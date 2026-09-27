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

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const BOUNCER_SYSTEM_PROMPT = `
You are "Bouncer", the user's friend and accountability partner on WhatsApp. 
Your personality & dynamic:
- You text like a real friend in their late teens/early 20s: casual, lowercase/minimal punctuation if it feels natural, current humor ("let's frickin go", calling them a "chud" when they act lazy, teasing banter).
- When they lock in a commitment: Hype them up like a bro ("8:30 gym session? let's frickin go, lock it in").
- When they actually deliver and send legitimate proof: Be genuinely supportive and proud of them, not toxic. Give real respect ("alright respect, you actually showed up. let's keep that streak alive").
- When they slack, make lame excuses, or send lazy/fake proof (floor photos, random objects, bad excuses): Roast their ass ruthlessly and call them out like a friend who refuses to watch them fail ("bro sent a blurry photo of a carpet thinking he beat the system, stop being a chud and go actually lift").
- Keep messages short and punchy (1 to 3 sentences max). Never sound like a corporate AI bot.
`;

const SALES_PROMPT_DIRECTIVE = `
IMPORTANT CONTEXT: The user's 3-day free trial has expired and they are NOT on the Pro plan yet.
Your goal is to gently break the news and persuade them to subscribe ($4.99/mo) while staying completely in character as their friend:
- Do NOT act like a harsh paywall or a corporate bot.
- First time breaking the news: Be like "oh crap dude sorry but your trial just ran out... but it's only 4.99 if you wanna keep going: https://buy.stripe.com/your_link_here".
- If they hesitate, object, or say they don't have $5: Persuade them like a bro ("if this 5 dollars gets your ass off the couch and in the gym then it will be worth it trust me dude").
- Do NOT accept new workout commitments or verify photos until they subscribe, but do keep bantering and convincing them to get the pass.
- Always include the checkout link if they seem on the fence: https://buy.stripe.com/your_link_here
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

// Resilient Gemini generator using the active 3.8 models
async function generateWithRetry(promptContent, retries = 2) {
    const models = ['gemini-3.8-flash', 'gemini-3.8-pro'];

    for (const modelName of models) {
        const selectedModel = genAI.getGenerativeModel({ model: modelName });
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                const result = await selectedModel.generateContent(promptContent);
                return result.response.text();
            } catch (err) {
                if (err.status === 503 || err.message?.includes('503')) {
                    console.log(`503 on ${modelName}, waiting 1.5s... (Attempt ${attempt + 1})`);
                    await new Promise((res) => setTimeout(res, 1500));
                } else {
                    console.error(`Error on ${modelName}:`, err.message || err);
                    break; // Move to fallback model
                }
            }
        }
    }
    throw new Error('All Gemini models and retries exhausted.');
}

// 1. Keepalive endpoint for cron-job.org
app.get('/', (req, res) => {
    res.status(200).send('Bouncer is active and awake.');
});

// 2. Main Twilio WhatsApp Webhook
app.post('/sms', async (req, res) => {
    const { MessagingResponse } = twilio.twiml;
    const twiml = new MessagingResponse();

    const fromNumber = req.body.From; // e.g. 'whatsapp:+1234567890'
    const userText = req.body.Body || '';
    const numMedia = parseInt(req.body.NumMedia || '0', 10);
    const mediaUrl = req.body.MediaUrl0;
    const mediaContentType = req.body.MediaContentType0;

    try {
        // 1. Check or create user in Supabase
        let { data: user, error: userFetchError } = await supabase
            .from('users')
            .select('*')
            .eq('phone_number', fromNumber)
            .single();

        if (!user) {
            const trialEnds = new Date();
            trialEnds.setDate(trialEnds.getDate() + 3);

            const { data: newUser, error: insertError } = await supabase
                .from('users')
                .insert([{
                    phone_number: fromNumber,
                    status: 'trial',
                    trial_ends_at: trialEnds.toISOString(),
                }])
                .select()
                .single();

            if (insertError) {
                console.error('Error creating user:', insertError);
            }
            user = newUser;
        }

        // 2. Safe check if trial has expired
        const hasValidDate = user && user.trial_ends_at;
        const isExpired = user && user.status === 'trial' && hasValidDate && (new Date() > new Date(user.trial_ends_at));

        // 3. Assemble Prompt based on status
        let activePrompt = BOUNCER_SYSTEM_PROMPT;
        if (isExpired && user.status !== 'pro') {
            activePrompt += `\n${SALES_PROMPT_DIRECTIVE}`;
        }

        // 4. Generate AI response
        let botReply = '';

        if (numMedia > 0 && mediaUrl) {
            const imagePart = await urlToGenerativePart(mediaUrl, mediaContentType);
            const prompt = `${activePrompt}\nUser submitted an image proof with message: "${userText}".`;
            botReply = await generateWithRetry([prompt, imagePart]);
        } else {
            const prompt = `${activePrompt}\nUser message: "${userText}"`;
            botReply = await generateWithRetry(prompt);
        }

        // 5. Send back via TwiML XML
        twiml.message(botReply);
        res.type('text/xml');
        res.send(twiml.toString());

    } catch (err) {
        console.error('Webhook processing error:', err);

        twiml.message("yo dude the message isnt working send it again in thirty seconds");
        res.type('text/xml');
        res.send(twiml.toString());
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Bouncer server live on port ${PORT}`);
});