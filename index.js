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

const userHistories = new Map();

const BOUNCER_SYSTEM_PROMPT = `
You are "Bouncer", the user's chill best friend and accountability buddy on WhatsApp.
Your texting style:
- Text like a real person texting from their phone: lowercase, super casual, zero emojis unless ironic.
- NEVER use line breaks or multiple paragraphs. Everything must be ONE single text bubble (1 to 2 short sentences max).
- NEVER repeat annoying catchphrases like "let's frickin go" or "lock it in" every message. Talk normally.
- If they state a plan, acknowledge it casually ("bet, chest at 9pm. see you then").
- If they actually send proof of work, give them props like a real friend.
- If they make excuses, send fake proof, or slack off, clown them and call them a chud.
- Remember recent context so you never ask something they literally just told you.

IMPORTANT EXTRACTION INSTRUCTION:
If the user committed to an action with an implied or explicit deadline in their message (e.g., "gym at 11pm", "running in 30 mins"), output a hidden JSON tag at the very end of your response formatted EXACTLY like this:
<<<{"has_deadline": true, "minutes_from_now": 30, "goal": "gym"}>>>
Estimate "minutes_from_now" relative to the current conversation. If there is NO time commitment, DO NOT output any <<<>>> tags.
`;

const SALES_PROMPT_DIRECTIVE = `
[CONTEXT: User's 3-day trial is up. You are not letting them log new workouts until they subscribe to Pro for $4.99/mo. Keep your chill friend tone, no harsh corporate walls. Tell them: "crap dude your free trial just ran out. grab the pass for 5 bucks here so we can keep going: https://buy.stripe.com/your_link_here". If they complain about 5 bucks, tell them if 5 bucks gets them off the couch it's worth it.]
`;

// Helper: Convert Twilio MMS to Gemini Part
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

// Resilient Gemini Generator
async function generateWithRetry(promptContent, retries = 3) {
    const model = genAI.getGenerativeModel({ model: 'gemini-3.8-flash' });

    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const result = await model.generateContent(promptContent);
            return result.response.text();
        } catch (err) {
            console.error(`Gemini attempt ${attempt + 1} failed:`, err.message || err);
            if (attempt < retries - 1) {
                await new Promise((res) => setTimeout(res, 800));
            }
        }
    }
    throw new Error('Gemini failed after retries');
}

// Keepalive endpoint
app.get('/', (req, res) => res.status(200).send('Bouncer is active.'));

// Webhook for incoming WhatsApp messages
app.post('/sms', async (req, res) => {
    const { MessagingResponse } = twilio.twiml;
    const twiml = new MessagingResponse();

    const fromNumber = req.body.From;
    const userText = (req.body.Body || '').trim();
    const numMedia = parseInt(req.body.NumMedia || '0', 10);
    const mediaUrl = req.body.MediaUrl0;
    const mediaContentType = req.body.MediaContentType0;

    try {
        // 1. Fetch or create user
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

        // 2. If photo is submitted, mark open reminders as completed
        if (numMedia > 0) {
            await supabase
                .from('reminders')
                .update({ completed: true })
                .eq('phone_number', fromNumber)
                .eq('completed', false);
        }

        // 3. Assemble chat context
        let history = userHistories.get(fromNumber) || [];
        let historyText = history.map((h) => `${h.role === 'user' ? 'User' : 'Bouncer'}: "${h.text}"`).join('\n');

        let systemInstructions = BOUNCER_SYSTEM_PROMPT;
        if (isExpired && user.status !== 'pro') {
            systemInstructions += `\n${SALES_PROMPT_DIRECTIVE}`;
        }

        let promptPayload;
        if (numMedia > 0 && mediaUrl) {
            const imagePart = await urlToGenerativePart(mediaUrl, mediaContentType);
            const prompt = `${systemInstructions}\nRecent context:\n${historyText}\nUser sent image proof with comment: "${userText}"`;
            promptPayload = [prompt, imagePart];
        } else {
            promptPayload = `${systemInstructions}\nRecent context:\n${historyText}\nUser: "${userText}"\nBouncer:`;
        }

        history.push({ role: 'user', text: userText || '[sent media]' });

        // 4. Generate reply
        const rawReply = await generateWithRetry(promptPayload, 3);

        // Extract hidden deadline tag if present
        let cleanReply = rawReply;
        const jsonMatch = rawReply.match(/<<<([\s\S]*?)>>>/);
        if (jsonMatch) {
            try {
                const parsed = JSON.parse(jsonMatch[1]);
                if (parsed.has_deadline && parsed.minutes_from_now) {
                    const target = new Date(Date.now() + parsed.minutes_from_now * 60000);
                    await supabase.from('reminders').insert([{
                        phone_number: fromNumber,
                        goal_text: parsed.goal || 'your commitment',
                        target_time: target.toISOString(),
                    }]);
                }
            } catch (e) {
                console.error('Failed to parse deadline tag:', e);
            }
            cleanReply = rawReply.replace(/<<<[\s\S]*?>>>/g, '').trim();
        }

        cleanReply = cleanReply.replace(/\n+/g, ' ').trim();

        history.push({ role: 'model', text: cleanReply });
        userHistories.set(fromNumber, history.slice(-6));

        twiml.message(cleanReply);
        res.type('text/xml');
        res.send(twiml.toString());

    } catch (err) {
        console.error('Fatal route error:', err.message || err);
        twiml.message("my bad phone lagged out, say that again?");
        res.type('text/xml');
        res.send(twiml.toString());
    }
});

// 5. Automated Nagging Cron Endpoint
app.get('/cron/check-reminders', async (req, res) => {
    try {
        const now = new Date().toISOString();

        // Find overdue, uncompleted, unnagged goals
        const { data: overdueList, error } = await supabase
            .from('reminders')
            .select('*')
            .eq('completed', false)
            .eq('nagged', false)
            .lte('target_time', now);

        if (error) throw error;

        for (const item of overdueList || []) {
            const nagPrompt = `
You are Bouncer. The user committed to "${item.goal_text}" by now and has NOT sent any proof or checked in.
Roast them in 1 short casual text message. Call them a chud or tell them to get off the couch and send proof.
Single line text bubble only, lowercase, no line breaks.
`;
            const roast = (await generateWithRetry(nagPrompt, 2)).replace(/\n+/g, ' ').trim();

            const formattedTo = item.phone_number.startsWith('whatsapp:') ? item.phone_number : `whatsapp:${item.phone_number}`;
            const formattedFrom = process.env.TWILIO_PHONE_NUMBER.startsWith('whatsapp:')
                ? process.env.TWILIO_PHONE_NUMBER
                : `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`;

            await twilioClient.messages.create({
                from: formattedFrom,
                to: formattedTo,
                body: roast,
            });

            // Mark as nagged so we don't spam them repeatedly
            await supabase
                .from('reminders')
                .update({ nagged: true })
                .eq('id', item.id);
        }

        res.status(200).json({ checked: overdueList ? overdueList.length : 0 });
    } catch (err) {
        console.error('Cron check error:', err.message || err);
        res.status(500).send('Cron failed');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bouncer running on port ${PORT}`));