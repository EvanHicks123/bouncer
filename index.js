require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize Twilio
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// In-memory locks and message history
const activeLocks = new Set();
const userHistories = new Map(); // phone -> [{ role: 'user'|'model', text: '' }]

const BOUNCER_SYSTEM_PROMPT = `
You are "Bouncer", the user's chill best friend and accountability buddy on WhatsApp.
Your texting style:
- Text like a real person texting from their phone: lowercase, super casual, zero emojis unless ironic.
- NEVER use line breaks or multiple paragraphs. Everything must be ONE single text bubble (1 to 2 short sentences max).
- NEVER repeat annoying catchphrases like "let's frickin go" or "lock it in" every message. Talk normally.
- If they state a plan, acknowledge it casually ("bet, chest at 9pm. see you then").
- If they actually send proof of work, give them props like a real friend.
- If they make excuses, send fake proof, or slack off, clown them and call them a chud.
- Remember the recent messages in context so you never ask them something they literally just told you.
`;

const SALES_PROMPT_DIRECTIVE = `
[CONTEXT: User's 3-day trial is up. You are not letting them log new workouts until they subscribe to Pro for $4.99/mo. Keep your chill friend tone, no harsh corporate walls. Tell them: "crap dude your free trial just ran out. grab the pass for 5 bucks here so we can keep going: https://buy.stripe.com/your_link_here". If they complain about 5 bucks, tell them if 5 bucks gets them off the couch it's worth it.]
`;

// Helper: Convert Twilio MMS URL to Gemini-compatible generative part
async function urlToGenerativePart(url, mimeType) {
    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        auth: {
            username: process.env.TWILIO_ACCOUNT_SID,
            password: process.env.TWILIO_AUTH_TOKEN,
        },
    });
    return {
        inlineData: {
            data: Buffer.from(response.data).toString('base64'),
            mimeType,
        },
    };
}

// Resilient Gemini generator locked to the active working model
async function generateWithRetry(promptContent, retries = 2) {
    const models = ['gemini-3.8-flash'];

    for (const modelName of models) {
        try {
            const selectedModel = genAI.getGenerativeModel({ model: modelName });
            for (let attempt = 0; attempt < retries; attempt++) {
                try {
                    const result = await selectedModel.generateContent(promptContent);
                    return result.response.text().replace(/\n+/g, ' ').trim();
                } catch (err) {
                    console.error(`Gemini attempt ${attempt + 1} error:`, err.message || err);
                    if (err.status === 503 || err.message?.includes('503')) {
                        await new Promise((res) => setTimeout(res, 1200));
                    } else {
                        break;
                    }
                }
            }
        } catch (modelInitErr) {
            console.error(`Skipping ${modelName}:`, modelInitErr.message);
        }
    }
    throw new Error('All models exhausted');
}

// Background retry worker with safe WhatsApp prefixes and error handling
async function resolveInBackground(fromNumber, promptPayload) {
    try {
        const reply = await generateWithRetry(promptPayload, 3);

        const history = userHistories.get(fromNumber) || [];
        history.push({ role: 'model', text: reply });
        userHistories.set(fromNumber, history.slice(-6));

        const formattedTo = fromNumber.startsWith('whatsapp:') ? fromNumber : `whatsapp:${fromNumber}`;
        const formattedFrom = process.env.TWILIO_PHONE_NUMBER.startsWith('whatsapp:')
            ? process.env.TWILIO_PHONE_NUMBER
            : `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`;

        await twilioClient.messages.create({
            from: formattedFrom,
            to: formattedTo,
            body: reply,
        });
    } catch (err) {
        console.error('Background worker caught error:', err.message || err);
    } finally {
        activeLocks.delete(fromNumber);
    }
}

app.get('/', (req, res) => res.status(200).send('Bouncer is active.'));

app.post('/sms', async (req, res) => {
    const { MessagingResponse } = twilio.twiml;
    const twiml = new MessagingResponse();

    const fromNumber = req.body.From;
    const userText = (req.body.Body || '').trim();
    const numMedia = parseInt(req.body.NumMedia || '0', 10);
    const mediaUrl = req.body.MediaUrl0;
    const mediaContentType = req.body.MediaContentType0;

    // 1. Lock check: if waiting on background retry and user follows up fast
    if (activeLocks.has(fromNumber)) {
        twiml.message("just wait a sec");
        res.type('text/xml');
        return res.send(twiml.toString());
    }

    try {
        // 2. Fetch or initialize user in Supabase
        let { data: user } = await supabase
            .from('users')
            .select('*')
            .eq('phone_number', fromNumber)
            .single();

        if (!user) {
            const trialEnds = new Date();
            trialEnds.setDate(trialEnds.getDate() + 3);

            const { data: newUser } = await supabase
                .from('users')
                .insert([{
                    phone_number: fromNumber,
                    status: 'trial',
                    trial_ends_at: trialEnds.toISOString(),
                }])
                .select()
                .single();
            user = newUser;
        }

        const hasValidDate = user && user.trial_ends_at;
        const isExpired = user && user.status === 'trial' && hasValidDate && (new Date() > new Date(user.trial_ends_at));

        // 3. Assemble chat history context
        let history = userHistories.get(fromNumber) || [];
        let historyText = history.map((h) => `${h.role === 'user' ? 'User' : 'Bouncer'}: "${h.text}"`).join('\n');

        let systemInstructions = BOUNCER_SYSTEM_PROMPT;
        if (isExpired && user.status !== 'pro') {
            systemInstructions += `\n${SALES_PROMPT_DIRECTIVE}`;
        }

        let promptPayload;
        if (numMedia > 0 && mediaUrl) {
            const imagePart = await urlToGenerativePart(mediaUrl, mediaContentType);
            const prompt = `${systemInstructions}\nRecent context:\n${historyText}\nUser sent image with caption: "${userText}"`;
            promptPayload = [prompt, imagePart];
        } else {
            promptPayload = `${systemInstructions}\nRecent context:\n${historyText}\nUser: "${userText}"\nBouncer:`;
        }

        // Append to local history
        history.push({ role: 'user', text: userText || '[sent media]' });
        userHistories.set(fromNumber, history.slice(-6));

        // 4. Primary generation attempt
        let botReply;
        try {
            botReply = await generateWithRetry(promptPayload, 2);
        } catch (fastErr) {
            activeLocks.add(fromNumber);
            resolveInBackground(fromNumber, promptPayload);

            twiml.message("hold up for a sec");
            res.type('text/xml');
            return res.send(twiml.toString());
        }

        // Save Bouncer response to history
        history.push({ role: 'model', text: botReply });
        userHistories.set(fromNumber, history.slice(-6));

        twiml.message(botReply);
        res.type('text/xml');
        res.send(twiml.toString());

    } catch (err) {
        console.error('Fatal route error:', err.message || err);
        activeLocks.delete(fromNumber);

        twiml.message("my bad phone lagged out for a sec, say that again?");
        res.type('text/xml');
        res.send(twiml.toString());
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bouncer running on port ${PORT}`));