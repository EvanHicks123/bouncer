require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

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
You are "Bouncer", an accountability buddy over text.
ADAPTIVE PERSONALITY: Analyze the user's specific vocabulary, slang, and texting rhythm in the recent context. Subtly mirror their tone so you sound exactly like them. 
Your core texting style:
- NEVER use the word "lag", "lagging", or "lagger" under any circumstance.
- Text like a real person texting from their phone: lowercase, super casual, zero emojis unless ironic.
- NEVER use line breaks. ONE single text bubble only.
- If they state a plan, acknowledge it casually.
- If they send proof of work, give props.
- If they make excuses, send fake proof, or slack off, clown them.

IMPORTANT EXTRACTION INSTRUCTIONS:
1. Deadlines:
Using the "Current User Local Time", if the user committed to an action with a deadline (e.g. "in 2 mins", "at 11:45am"), calculate how many minutes from right now that deadline is.
Append a hidden deadline tag at the end:
<<<{"has_deadline": true, "minutes_from_now": 15, "goal": "gym"}>>>

2. Timezone Updates:
If the user mentions their city/timezone, append a hidden timezone tag:
<<<{"update_timezone": "America/Toronto"}>>>

If neither applies, do NOT output any <<<>>> tags.
`;

async function generateWithRetry(promptContent, retries = 3) {
    const model = genAI.getGenerativeModel({ model: 'gemini-3.8-flash' });
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const result = await model.generateContent(promptContent);
            return result.response.text();
        } catch (err) {
            if (attempt < retries - 1) await new Promise((res) => setTimeout(res, 800));
        }
    }
    throw new Error('Gemini failed');
}

app.get('/', (req, res) => res.status(200).send('Bouncer is active.'));

// Webhook for incoming SMS messages
app.post('/sms', async (req, res) => {
    const { MessagingResponse } = twilio.twiml;
    const twiml = new MessagingResponse();

    const fromNumber = req.body.From;
    const userText = (req.body.Body || '').trim();
    const numMedia = parseInt(req.body.NumMedia || '0', 10);

    try {
        let { data: user } = await supabase.from('users').select('*').eq('phone_number', fromNumber).single();
        if (!user) {
            const { data: newUser } = await supabase.from('users').insert([{
                phone_number: fromNumber,
                timezone: 'America/Vancouver',
            }]).select().single();
            user = newUser;
        }

        const userTimezone = user?.timezone || 'America/Vancouver';
        const nowISO = new Date().toISOString();

        // STOP FOLLOW-UPS: If the user texts back, halt all active nags for overdue tasks
        await supabase
            .from('reminders')
            .update({ nag_stage: 4 })
            .eq('phone_number', fromNumber)
            .eq('completed', false)
            .lte('target_time', nowISO);

        // If photo is submitted, fully mark active tasks as completed
        if (numMedia > 0) {
            await supabase
                .from('reminders')
                .update({ completed: true })
                .eq('phone_number', fromNumber)
                .eq('completed', false);
        }

        let localTimeStr;
        try {
            localTimeStr = new Date().toLocaleTimeString('en-US', { timeZone: userTimezone, hour: 'numeric', minute: '2-digit', hour12: true });
        } catch {
            localTimeStr = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Vancouver', hour: 'numeric', minute: '2-digit', hour12: true });
        }

        let history = userHistories.get(fromNumber) || [];
        let historyText = history.map((h) => `${h.role === 'user' ? 'User' : 'Bouncer'}: "${h.text}"`).join('\n');

        let promptPayload = `${BOUNCER_SYSTEM_PROMPT}\nUser Timezone: ${userTimezone}\nCurrent User Local Time: ${localTimeStr}\nRecent context:\n${historyText}\nUser: "${userText || '[sent image]'}"\nBouncer:`;

        history.push({ role: 'user', text: userText || '[sent media]' });

        const rawReply = await generateWithRetry(promptPayload, 3);
        let cleanReply = rawReply;

        const jsonMatches = rawReply.match(/<<<([\s\S]*?)>>>/g);
        if (jsonMatches) {
            for (const rawTag of jsonMatches) {
                try {
                    const parsed = JSON.parse(rawTag.replace(/<<<|>>>/g, '').trim());
                    if (parsed.has_deadline && typeof parsed.minutes_from_now === 'number') {
                        const target = new Date(Date.now() + Math.max(1, parsed.minutes_from_now) * 60000);
                        await supabase.from('reminders').insert([{
                            phone_number: fromNumber,
                            goal_text: parsed.goal || 'your task',
                            target_time: target.toISOString(),
                        }]);
                    }
                    if (parsed.update_timezone) {
                        await supabase.from('users').update({ timezone: parsed.update_timezone }).eq('phone_number', fromNumber);
                    }
                } catch (e) {}
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
        console.error('Route error:', err);
        twiml.message("my bad phone froze, say that again?");
        res.type('text/xml');
        res.send(twiml.toString());
    }
});

// Automated Nagging Cron Endpoint
app.get('/cron/check-reminders', async (req, res) => {
    try {
        const now = new Date();

        // Fetch active reminders not completed and not at max nag stage (4)
        const { data: activeList, error } = await supabase
            .from('reminders')
            .select('*')
            .eq('completed', false)
            .lt('nag_stage', 4);

        if (error) return res.status(200).json({ error: error.message });
        if (!activeList || activeList.length === 0) return res.status(200).json({ checked: 0 });

        const results = [];
        const rawFrom = (process.env.TWILIO_PHONE_NUMBER || '').replace(/^whatsapp:/, '').trim();

        for (const item of activeList) {
            const target = new Date(item.target_time);
            const diffMins = (now - target) / 60000; // Negative = future, Positive = past

            let prompt = null;
            let nextStage = item.nag_stage;
            let isPreNagged = item.pre_nagged;
            let updateRequired = false;

            // 30 mins before
            if (diffMins >= -30 && diffMins < 0 && !item.pre_nagged) {
                prompt = `You are Bouncer. User has to do "${item.goal_text}" in ${Math.abs(Math.round(diffMins))} minutes. Send a quick chill text reminding them. Mirror their texting style. NEVER use the word "lag" or "lagging". Single sentence, lowercase.`;
                isPreNagged = true;
                updateRequired = true;
            }
            // Stage 0: Exactly at Deadline
            else if (diffMins >= 0 && item.nag_stage === 0) {
                prompt = `You are Bouncer. Time is up for "${item.goal_text}". Roast them for not checking in. Mirror their slang. NEVER use the word "lag" or "lagging". Single sentence, lowercase.`;
                nextStage = 1;
                updateRequired = true;
            }
            // Stage 1: +5 mins late
            else if (diffMins >= 5 && item.nag_stage === 1) {
                prompt = `You are Bouncer. It's been 5 mins since their deadline for "${item.goal_text}" and they are ghosting you. Call them out. Mirror their tone. NEVER use the word "lag". Single sentence, lowercase.`;
                nextStage = 2;
                updateRequired = true;
            }
            // Stage 2: +15 mins late
            else if (diffMins >= 15 && item.nag_stage === 2) {
                prompt = `You are Bouncer. 15 mins past deadline for "${item.goal_text}". Escalate the roast. Mirror their tone. NEVER use the word "lag". Single sentence, lowercase.`;
                nextStage = 3;
                updateRequired = true;
            }
            // Stage 3: +30 mins late
            else if (diffMins >= 30 && item.nag_stage === 3) {
                prompt = `You are Bouncer. 30 mins past deadline for "${item.goal_text}". Final warning, express total disappointment. Mirror their tone. NEVER use the word "lag". Single sentence, lowercase.`;
                nextStage = 4;
                updateRequired = true;
            }

            if (prompt && updateRequired) {
                try {
                    const rawRoast = await generateWithRetry(prompt, 2);
                    const roast = rawRoast.replace(/\n+/g, ' ').trim();
                    const rawTo = item.phone_number.replace(/^whatsapp:/, '').trim();

                    const msg = await twilioClient.messages.create({ from: rawFrom, to: rawTo, body: roast });

                    await supabase
                        .from('reminders')
                        .update({ pre_nagged: isPreNagged, nag_stage: nextStage })
                        .eq('id', item.id);

                    results.push({ id: item.id, stage: nextStage, status: 'sent', sid: msg.sid });
                } catch (sendErr) {
                    console.error(`Failed on reminder ${item.id}:`, sendErr.message);
                }
            }
        }

        res.status(200).json({ checked: activeList.length, sent: results });
    } catch (err) {
        console.error('Fatal cron check error:', err);
        res.status(200).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bouncer running on port ${PORT}`));