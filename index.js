require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize Twilio & Gemini
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 🚨 STRIPE WEBHOOK MUST BE BEFORE express.json 🚨
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        console.error(`Webhook signature failed: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const phoneNumber = session.client_reference_id;

        if (phoneNumber) {
            console.log(`Upgrading user ${phoneNumber} to PRO`);
            await supabase
                .from('users')
                .update({ status: 'pro' })
                .eq('phone_number', phoneNumber);
        }
    }

    res.status(200).send();
});

// Load body parsers for Twilio routes
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const BOUNCER_SYSTEM_PROMPT = `
You are "Bouncer", the user's friend and accountability partner over SMS.
CRITICAL PERSONA RULES:
- EXTREME BREVITY: 10 words maximum per text. Be concise.
- NEVER use nightclub or security guard metaphors.
- TEXT LIKE A REAL HUMAN: lowercase, casual, zero emojis unless ironic.
- VARIETY IS MANDATORY: You have a chat history. DO NOT repeat phrases like "lock in", "bet", or "don't flake" if you've said them recently. Change up your vocabulary every time.
- ROASTING: If the user is whining, acting weak, or making excuses (being a "bitch"), roast them. Keep it simple, harsh, and gym-bro style (e.g., "if you dont go ur gonna stay small dude"). No elaborate or corny jokes. Just blunt truth.
- TRIAL QUESTIONS: If the user asks about their trial, look at the "Current Date" and "Trial Ends At" variables below and tell them exactly how much time they have left.

EXTRACTION INSTRUCTIONS (Hidden JSON tags):
1. Deadlines / Reschedules: <<<{"has_deadline": true, "minutes_from_now": 14, "goal": "gym", "reschedule": true}>>>
2. Cancellations: <<<{"cancel_active": true}>>>
3. Timezone Updates: <<<{"update_timezone": "America/Vancouver"}>>>
4. Double Texting (OPTIONAL): To seem more human, if the user is making excuses or struggling, you can SOMETIMES (about 20% of the time) send a follow-up text a few seconds later. Use this strictly for follow-up thoughts (e.g. "the hard part is just going once ur in there"). <<<{"double_text": "your second message here"}>>>
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
    const twilioNumber = req.body.To;
    const userText = (req.body.Body || '').trim();
    const numMedia = parseInt(req.body.NumMedia || '0', 10);

    try {
        let { data: user } = await supabase.from('users').select('*').eq('phone_number', fromNumber).single();
        if (!user) {
            const trialEndsAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
            const { data: newUser } = await supabase.from('users').insert([{
                phone_number: fromNumber,
                timezone: 'America/Vancouver',
                status: 'trial',
                trial_ends_at: trialEndsAt,
                chat_history: []
            }]).select().single();
            user = newUser;
        }

        const userTimezone = user?.timezone || 'America/Vancouver';
        const now = new Date();
        const trialEnd = user.trial_ends_at ? new Date(user.trial_ends_at) : null;
        const isExpired = trialEnd ? now > trialEnd : false;

        const paymentLink = `https://buy.stripe.com/test_3cI6oJ0JjgpZ8xBePNbbG00?client_reference_id=${encodeURIComponent(fromNumber)}`;

        if (isExpired && user.status !== 'pro') {
            twiml.message(`trial's up bro. grab the pass for $5 to keep using bouncer: ${paymentLink}`);
            res.type('text/xml');
            return res.send(twiml.toString());
        }

        await supabase
            .from('reminders')
            .update({ nag_stage: 4 })
            .eq('phone_number', fromNumber)
            .eq('completed', false);

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

        // Pull persistent history from Supabase
        let history = user.chat_history || [];
        let historyText = history.map((h) => `${h.role === 'user' ? 'User' : 'Bouncer'}: "${h.text}"`).join('\n');

        let promptPayload = `${BOUNCER_SYSTEM_PROMPT}\nUser Timezone: ${userTimezone}\nCurrent User Local Time: ${localTimeStr}\nCurrent Server Date: ${now.toISOString()}\nTrial Ends At: ${user.trial_ends_at}\n\nRecent context:\n${historyText}\nUser: "${userText || '[sent image]'}"\nBouncer:`;

        history.push({ role: 'user', text: userText || '[sent media]' });

        const rawReply = await generateWithRetry(promptPayload, 3);
        let cleanReply = rawReply;
        let doubleTextMsg = null;

        const jsonMatches = rawReply.match(/<<<([\s\S]*?)>>>/g);
        if (jsonMatches) {
            for (const rawTag of jsonMatches) {
                try {
                    const parsed = JSON.parse(rawTag.replace(/<<<|>>>/g, '').trim());

                    if (parsed.double_text) {
                        doubleTextMsg = parsed.double_text;
                    }

                    if (parsed.cancel_active) {
                        await supabase
                            .from('reminders')
                            .update({ completed: true, nag_stage: 4 })
                            .eq('phone_number', fromNumber)
                            .eq('completed', false);
                    }

                    if (parsed.has_deadline && typeof parsed.minutes_from_now === 'number') {
                        const mins = Math.max(1, parsed.minutes_from_now);
                        const target = new Date(Date.now() + mins * 60000);

                        let preNagAt = null;
                        if (mins > 4) {
                            let remindMinsBefore;
                            if (mins <= 30) {
                                remindMinsBefore = Math.round(mins / 2);
                            } else if (mins <= 60) {
                                remindMinsBefore = 15;
                            } else {
                                remindMinsBefore = 30;
                            }
                            preNagAt = new Date(target.getTime() - remindMinsBefore * 60000).toISOString();
                        }

                        await supabase
                            .from('reminders')
                            .update({ completed: true, nag_stage: 4 })
                            .eq('phone_number', fromNumber)
                            .eq('completed', false);

                        await supabase.from('reminders').insert([{
                            phone_number: fromNumber,
                            goal_text: parsed.goal || 'your task',
                            target_time: target.toISOString(),
                            pre_nag_at: preNagAt,
                            pre_nagged: false,
                            nag_stage: 0,
                        }]);
                    }

                    if (parsed.update_timezone) {
                        await supabase.from('users').update({ timezone: parsed.update_timezone }).eq('phone_number', fromNumber);
                    }
                } catch (e) {
                    console.error('Error parsing tag:', e);
                }
            }
            cleanReply = rawReply.replace(/<<<[\s\S]*?>>>/g, '').trim();
        }

        cleanReply = cleanReply.replace(/\n+/g, ' ').trim();
        history.push({ role: 'model', text: cleanReply });

        if (doubleTextMsg) {
            history.push({ role: 'model', text: doubleTextMsg });
        }

        // Save history permanently
        await supabase.from('users').update({ chat_history: history.slice(-10) }).eq('phone_number', fromNumber);

        // Send first message
        twiml.message(cleanReply);
        res.type('text/xml');
        res.send(twiml.toString());

        // Send delayed double text if requested
        if (doubleTextMsg) {
            setTimeout(async () => {
                try {
                    await twilioClient.messages.create({
                        from: twilioNumber || process.env.TWILIO_PHONE_NUMBER,
                        to: fromNumber,
                        body: doubleTextMsg
                    });
                } catch (err) {
                    console.error('Double text failed:', err.message);
                }
            }, 4500); // Waits 4.5 seconds to feel natural
        }

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
            const diffMins = (now - target) / 60000;

            let prompt = null;
            let nextStage = item.nag_stage;
            let isPreNagged = item.pre_nagged;
            let updateRequired = false;

            // Fetch persistent history for the nag context
            const { data: cronUser } = await supabase.from('users').select('chat_history').eq('phone_number', item.phone_number).single();
            let history = cronUser?.chat_history || [];
            const historySnippet = history.length > 0
                ? history.map((h) => `${h.role === 'user' ? 'User' : 'Friend'}: "${h.text}"`).join('\n')
                : '';

            const styleGuide = `
Recent chat history:
${historySnippet}

CRITICAL RULES:
- EXTREME BREVITY: 10 words max.
- VARIETY: Look at the history. Do NOT repeat phrases you recently used.
- TONE: Normal friend. If they are late (stage 1 or 2), roast them simply and bluntly.
- NEVER use the word "lag" or "lagging".
- Match lowercase casual style.
`;

            const isPreNagDue = item.pre_nag_at && now >= new Date(item.pre_nag_at) && diffMins < 0;
            if (!item.pre_nagged && isPreNagDue) {
                const remaining = Math.max(1, Math.round(Math.abs(diffMins)));
                prompt = `User has to do "${item.goal_text}" in ${remaining} minutes. Send a quick heads up reminding them. ${styleGuide}`;
                isPreNagged = true;
                updateRequired = true;
            }
            else if (diffMins >= 0 && item.nag_stage === 0) {
                prompt = `Time is up for "${item.goal_text}". Send a super quick text telling them to lock in or asking if they are there. ${styleGuide}`;
                nextStage = 1;
                updateRequired = true;
            }
            else if (diffMins >= 10 && item.nag_stage === 1) {
                prompt = `It's been 10 mins since deadline for "${item.goal_text}". Tell them to get off their phone and do it. Roast them simply. ${styleGuide}`;
                nextStage = 2;
                updateRequired = true;
            }
            else if (diffMins >= 60 && item.nag_stage === 2) {
                prompt = `An hour past deadline for "${item.goal_text}". Give them one final super brief nudge. ${styleGuide}`;
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

                    // Save nag back to memory
                    history.push({ role: 'model', text: roast });
                    await supabase.from('users').update({ chat_history: history.slice(-10) }).eq('phone_number', item.phone_number);

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