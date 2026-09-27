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

const BOUNCER_SYSTEM_PROMPT = `
You are "Bouncer", an uncompromising, sarcastic, and hilarious accountability partner on WhatsApp.
Your job:
1. If the user states a goal/commitment, acknowledge it strictly. Hold them to it.
2. If they send an image as proof, scrutinize it aggressively. If it's fake or lazy (e.g. a photo of the floor, a random water bottle, a blurry ceiling), roast them and reject it. If it's valid proof, begrudgingly approve it.
3. Keep responses punchy, concise, and under 3-4 sentences. Talk like a bouncer guarding an exclusive club.
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

// Resilient Gemini generator with retry and fallback across models
async function generateWithRetry(promptContent, retries = 2) {
    const models = ['gemini-2.0-flash', 'gemini-1.5-flash'];

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
                    break; // Move to the next model if it's another type of error
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
            const { data: newUser, error: insertError } = await supabase
                .from('users')
                .insert([{ phone_number: fromNumber }])
                .select()
                .single();

            if (insertError) {
                console.error('Error creating user:', insertError);
            }
            user = newUser;
        }

        // 2. Check trial & subscription access
        const isExpired = user && user.status === 'trial' && new Date() > new Date(user.trial_ends_at);
        if (isExpired && user.status !== 'pro') {
            const paywallMsg =
                "Whoa there, trial's expired. You're not getting past the ropes without a wristband. Tap here to lock in Pro ($5/mo): https://buy.stripe.com/your_link_here";

            await twilioClient.messages.create({
                from: process.env.TWILIO_PHONE_NUMBER,
                to: fromNumber,
                body: paywallMsg,
            });
            return res.sendStatus(200);
        }

        // 3. Build Gemini content & generate reply
        let botReply = '';

        if (numMedia > 0 && mediaUrl) {
            const imagePart = await urlToGenerativePart(mediaUrl, mediaContentType);
            const prompt = `${BOUNCER_SYSTEM_PROMPT}\nUser submitted this image as proof with comment: "${userText}". Analyze it strictly.`;
            botReply = await generateWithRetry([prompt, imagePart]);
        } else {
            const prompt = `${BOUNCER_SYSTEM_PROMPT}\nUser message: "${userText}"`;
            botReply = await generateWithRetry(prompt);
        }

        // 4. Send WhatsApp response back via Twilio
        await twilioClient.messages.create({
            from: process.env.TWILIO_PHONE_NUMBER,
            to: fromNumber,
            body: botReply,
        });

        res.sendStatus(200);
    } catch (err) {
        console.error('Webhook processing error:', err);

        // Friendly fallback so user isn't left hanging on read
        try {
            await twilioClient.messages.create({
                from: process.env.TWILIO_PHONE_NUMBER,
                to: fromNumber,
                body: "Bouncer is handling a line at the door. Try texting your commitment again in 30 seconds.",
            });
        } catch (twilioErr) {
            console.error('Twilio fallback error:', twilioErr);
        }

        res.sendStatus(200);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Bouncer server live on port ${PORT}`);
});