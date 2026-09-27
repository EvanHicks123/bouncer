require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const cron = require('node-cron');
const { JSONFilePreset } = require('lowdb/node');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// ---- Simple JSON "database" ----
let db;
async function initDb() {
    db = await JSONFilePreset('db.json', { users: {} });
}

function getUser(phone) {
    if (!db.data.users[phone]) {
        db.data.users[phone] = { commitments: [], history: [] };
    }
    if (!db.data.users[phone].history) {
        db.data.users[phone].history = [];
    }
    return db.data.users[phone];
}

function todayEndOfDay() {
    const d = new Date();
    d.setHours(23, 59, 59, 999);
    return d.toISOString();
}

function getNextRandomNudgeTime(minMinutes = 35, maxMinutes = 70) {
    const delayMs = (Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) + minMinutes) * 60 * 1000;
    return new Date(Date.now() + delayMs).toISOString();
}

// ---- Gemini Vision Helper: Checks if the image is actually a gym ----
async function verifyGymPhoto(mediaUrl) {
    try {
        const imgRes = await fetch(mediaUrl);
        const arrayBuffer = await imgRes.arrayBuffer();
        const base64Data = Buffer.from(arrayBuffer).toString('base64');
        const mimeType = imgRes.headers.get('content-type') || 'image/jpeg';

        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const response = await ai.models.generateContent({
                    model: 'gemini-3.8-flash',
                    contents: [
                        {
                            role: 'user',
                            parts: [
                                {
                                    inlineData: {
                                        mimeType: mimeType,
                                        data: base64Data,
                                    },
                                },
                                {
                                    text: 'Is this photo taken inside a gym, showing workout/weight equipment, or showing an active workout session? Answer ONLY "YES" or "NO".',
                                },
                            ],
                        },
                    ],
                });

                const result = (response.text || '').toUpperCase();
                return result.includes('YES');
            } catch (err) {
                console.error(`Photo check attempt ${attempt} failed:`, err.message);
                if (attempt < 3) await new Promise((r) => setTimeout(r, 1200));
            }
        }
        return false;
    } catch (err) {
        console.error('Error fetching image for verification:', err.message);
        return false;
    }
}

// ---- Conversational Friend Engine with 503 Retry Resilience ----
async function chatWithFriend(userMessage, chatHistory, hasOpenCommitment) {
    const systemPrompt = `You are a close gym bro / texting friend keeping the user accountable.
Tone: casual, witty, bro-ish, supportive, uses realistic texting shorthand (lower-case vibes, occasional emojis, 1-2 punchy sentences max).
Do NOT sound like a corporate AI bot or customer support.

Analyze the user's message and current commitment status.
Current open commitment status: ${hasOpenCommitment ? 'USER CURRENTLY HAS AN ACTIVE COMMITMENT TO GO TO THE GYM TODAY' : 'NO COMMITMENT ACTIVE YET'}.

Respond in strictly valid JSON format with two keys:
{
  "reply": "Your conversational text message back to the friend",
  "isCommitment": true or false (set to true if they are saying they will go, are going soon, heading there now, or confirming today's workout)
}`;

    const payload = {
        model: 'gemini-3.8-flash',
        contents: [
            ...chatHistory.slice(-6).map((msg) => ({
                role: msg.role === 'bot' ? 'model' : 'user',
                parts: [{ text: msg.text }],
            })),
            {
                role: 'user',
                parts: [{ text: userMessage }],
            },
        ],
        config: {
            systemInstruction: systemPrompt,
            responseMimeType: 'application/json',
        },
    };

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await ai.models.generateContent(payload);
            const text = response.text || '{}';
            return JSON.parse(text);
        } catch (err) {
            console.error(`Attempt ${attempt} failed:`, err.message);
            if (attempt < 3) {
                await new Promise((resolve) => setTimeout(resolve, 1200));
            }
        }
    }

    return {
        reply: "yo connection was lagging for a sec. what's the plan, you heading over soon?",
        isCommitment: false,
    };
}

// ---- Nudge & Roast Generation ----
async function generateNudge(commitmentText, nudgeCount) {
    const system = `You are a close friend texting your buddy because they said they would go to the gym ("${commitmentText}") and haven't sent a picture yet.
This is check-in #${nudgeCount}.
Keep it super short (1 sentence, casual texting slang). Ask if they're leaving soon or lagging.`;

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await ai.models.generateContent({
                model: 'gemini-3.8-flash',
                contents: 'Send a quick casual check-in text.',
                config: { systemInstruction: system, maxOutputTokens: 100 },
            });
            return (res.text || '').trim();
        } catch (err) {
            if (attempt < 3) await new Promise((r) => setTimeout(r, 1200));
        }
    }
    return 'yo you out the door yet?';
}

async function generateRoast(commitmentText) {
    const system = `You are a teasing friend roasting your buddy for ghosting the gym after promising: "${commitmentText}".
Keep it to 1-2 sentences of playful, witty teasing. Casual texting style. Under 180 chars.`;

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await ai.models.generateContent({
                model: 'gemini-3.8-flash',
                contents: 'Roast them for skipping.',
                config: { systemInstruction: system, maxOutputTokens: 100 },
            });
            return (res.text || '').trim();
        } catch (err) {
            if (attempt < 3) await new Promise((r) => setTimeout(r, 1200));
        }
    }
    return "knew you'd flake smh. gains lost forever.";
}

function sendSms(to, body) {
    return twilioClient.messages.create({
        to,
        from: TWILIO_PHONE_NUMBER,
        body,
    });
}

// ---- Webhook: Incoming Messages from Twilio/WhatsApp ----
app.post('/sms', async (req, res) => {
    const from = req.body.From;
    const body = (req.body.Body || '').trim();
    const numMedia = parseInt(req.body.NumMedia || '0', 10);
    const mediaUrl = req.body.MediaUrl0;

    const user = getUser(from);
    let replyText = '';

    const openCommitment = user.commitments.find(
        (c) => c.status === 'open' && c.deadline.slice(0, 10) === new Date().toISOString().slice(0, 10)
    );

    // 1. Photo verification
    if (numMedia > 0 && mediaUrl) {
        if (openCommitment) {
            const isRealGym = await verifyGymPhoto(mediaUrl);

            if (isRealGym) {
                openCommitment.status = 'done';
                openCommitment.nextNudgeAt = null;
                replyText = "yessir let's go!! locked it in. go get those gains 💪";
            } else {
                replyText = "nice try bro that is definitely not a gym 💀 send real proof or get roasted tonight";
            }
        } else {
            replyText = "fire pic but you didn't even tell me you were hitting the gym today 👀";
        }
    } else {
        // 2. Natural conversation with memory & structured intent
        const botDecision = await chatWithFriend(body, user.history, !!openCommitment);
        replyText = botDecision.reply;

        user.history.push({ role: 'user', text: body });

        if (botDecision.isCommitment && !openCommitment) {
            user.commitments.push({
                id: Date.now().toString(),
                text: body,
                createdAt: new Date().toISOString(),
                deadline: todayEndOfDay(),
                status: 'open',
                nudgeCount: 0,
                nextNudgeAt: getNextRandomNudgeTime(35, 60),
            });
        }
    }

    user.history.push({ role: 'bot', text: replyText });

    await db.write();

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(replyText);
    res.type('text/xml').send(twiml.toString());
});

// ---- Cron: Random Nudge Watcher ----
cron.schedule('* * * * *', async () => {
    const now = new Date().toISOString();

    for (const [phone, user] of Object.entries(db.data.users)) {
        for (const c of user.commitments) {
            if (c.status === 'open' && c.nextNudgeAt && c.nextNudgeAt <= now) {
                c.nudgeCount = (c.nudgeCount || 0) + 1;
                c.nextNudgeAt = getNextRandomNudgeTime(40, 80);

                const nudgeMessage = await generateNudge(c.text, c.nudgeCount);
                try {
                    await sendSms(phone, nudgeMessage);
                    console.log(`Sent nudge #${c.nudgeCount} to ${phone}`);
                } catch (err) {
                    console.error('Failed to send nudge to', phone, err.message);
                }
            }
        }
    }
    await db.write();
});

// ---- Cron: Nightly Roast at 23:00 ----
cron.schedule('0 23 * * *', async () => {
    const today = new Date().toISOString().slice(0, 10);

    for (const [phone, user] of Object.entries(db.data.users)) {
        for (const c of user.commitments) {
            if (c.status === 'open' && c.deadline.slice(0, 10) === today) {
                c.status = 'missed';
                c.nextNudgeAt = null;
                const roast = await generateRoast(c.text);
                try {
                    await sendSms(phone, roast);
                } catch (err) {
                    console.error('Failed to send roast to', phone, err.message);
                }
            }
        }
    }
    await db.write();
});

// ---- Health check ----
app.get('/', (req, res) => res.send('gymbot is running'));

initDb().then(() => {
    app.listen(PORT, () => console.log(`The Bouncer listening on port ${PORT}`));
});