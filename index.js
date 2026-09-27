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
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

const BOUNCER_SYSTEM_PROMPT = `
You are "Bouncer", an uncompromising, sarcastic, and hilarious accountability partner on WhatsApp.
Your job:
1. If the user states a goal/commitment, acknowledge it strictly. Hold them to it.
2. If they send an image as proof, scrutinize it aggressively. If it's fake or lazy (e.g. a photo of the floor, a random water bottle, a blurry ceiling), roast them and reject it. If it's valid proof, begrudgingly approve it.
3. Keep responses punchy, concise, and under 3-4 sentences. Talk like a bouncer guarding an exclusive club.
`;

// Helper: Convert image URL to Gemini-compatible generative part
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
        // Check or create user in Supabase
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

        // Check trial & subscription access
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

        // Build Gemini prompt
        let botReply = '';

        if (numMedia > 0 && mediaUrl) {
            // User sent an image proof
            const imagePart = await urlToGenerativePart(mediaUrl, mediaContentType);
            const prompt = `${BOUNCER_SYSTEM_PROMPT}\nUser submitted this image as proof with comment: "${userText}". Analyze it strictly.`;

            const result = await model.generateContent([prompt, imagePart]);
            botReply = result.response.text();
        } else {
            // User sent a plain text message
            const prompt = `${BOUNCER_SYSTEM_PROMPT}\nUser message: "${userText}"`;
            const result = await model.generateContent(prompt);
            botReply = result.response.text();
        }

        // Send WhatsApp response back via Twilio
        await twilioClient.messages.create({
            from: process.env.TWILIO_PHONE_NUMBER,
            to: fromNumber,
            body: botReply,
        });

        res.sendStatus(200);
    } catch (err) {
        console.error('Webhook error:', err);
        res.sendStatus(500);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Bouncer server live on port ${PORT}`);
});