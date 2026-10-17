require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const exifr = require('exifr');

const app = express();

// Validate required environment variables at startup
const REQUIRED_ENV = [
    'SUPABASE_URL',
    'SUPABASE_KEY',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_PHONE_NUMBER',
    'GEMINI_API_KEY',
];
for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
        console.warn(`[WARN] Missing environment variable: ${key}`);
    }
}

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize Twilio & Gemini
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// ==== PHOTO PROOF START ====
// A photo only counts as proof if its metadata says it was taken recently.
// Optional env vars: PROOF_MAX_AGE_MINS (default 30), REQUIRE_PHOTO_METADATA (default true)
const PROOF_MAX_AGE_MINS = parseInt(process.env.PROOF_MAX_AGE_MINS || '30', 10);
const REQUIRE_PHOTO_METADATA = process.env.REQUIRE_PHOTO_METADATA !== 'false';

// What the bot is told when a photo does not count (Gemini words the actual reply)
const PROOF_NOTES = {
    too_old: 'the photo was taken too long ago, so it does not count. Tell them to send a fresh photo taken right now.',
    no_metadata: 'the photo had no timestamp data, so it cannot be verified. Tell them to send a fresh photo taken right now with their camera.',
    bad_timestamp: 'the photo timestamp looks wrong. Tell them to send a fresh photo taken right now.',
    not_an_image: 'the attachment was not a photo. Tell them to send a photo.',
    download_failed: 'the photo did not come through. Ask them to send it again.',
    check_error: 'the photo could not be checked. Ask them to send it again.',
};

function parseOffsetMinutes(str) {
    const m = /^([+-])(\d{2}):?(\d{2})$/.exec(String(str || '').trim());
    if (!m) return null;
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

// How far a named timezone is ahead of UTC at a given moment, in milliseconds
function tzOffsetMs(utcMs, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(utcMs));
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return asIfUtc - Math.floor(utcMs / 1000) * 1000;
}

// Two passes so the answer is still right when the offset changes near daylight saving
function wallClockToUtcMs(wallAsUtc, timeZone) {
    const first = wallAsUtc - tzOffsetMs(wallAsUtc, timeZone);
    return wallAsUtc - tzOffsetMs(first, timeZone);
}

// EXIF stores local wall-clock time like "2026:10:16 17:33:52" with no timezone.
// Use the photo's own offset tag if it has one, otherwise the user's saved timezone.
function exifTimeToUtcMs(raw, offsetStr, userZone) {
    const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(raw || '').trim());
    if (!m) return null;
    const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
    const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);

    const offsetMins = parseOffsetMinutes(offsetStr);
    if (offsetMins !== null) return wallAsUtc - offsetMins * 60000;

    try {
        return wallClockToUtcMs(wallAsUtc, userZone);
    } catch {
        return wallClockToUtcMs(wallAsUtc, 'America/Vancouver');
    }
}

async function checkPhotoProof(mediaUrl, contentType, userZone) {
    try {
        if (!mediaUrl) return { ok: false, reason: 'download_failed' };
        if (contentType && !contentType.startsWith('image/')) return { ok: false, reason: 'not_an_image' };

        const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
        const res = await fetch(mediaUrl, {
            headers: { Authorization: `Basic ${auth}` },
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return { ok: false, reason: 'download_failed' };
        const buf = Buffer.from(await res.arrayBuffer());

        const meta = await exifr.parse(buf, {
            pick: ['DateTimeOriginal', 'CreateDate', 'OffsetTimeOriginal', 'OffsetTimeDigitized', 'OffsetTime'],
            reviveValues: false, // keep the raw "YYYY:MM:DD HH:MM:SS" text so we control the timezone
        });
        console.log('Photo metadata found:', meta || 'none');

        const usingOriginal = Boolean(meta && meta.DateTimeOriginal);
        const rawTime = meta && (meta.DateTimeOriginal || meta.CreateDate);
        if (!rawTime) {
            return REQUIRE_PHOTO_METADATA
                ? { ok: false, reason: 'no_metadata' }
                : { ok: true, reason: 'no_metadata_allowed' };
        }

        const offsetStr = (usingOriginal ? meta.OffsetTimeOriginal : meta.OffsetTimeDigitized) || meta.OffsetTime;
        const takenAtMs = exifTimeToUtcMs(rawTime, offsetStr, userZone);
        if (takenAtMs === null) return { ok: false, reason: 'bad_timestamp' };

        const ageMins = (Date.now() - takenAtMs) / 60000;
        if (ageMins > PROOF_MAX_AGE_MINS) return { ok: false, reason: 'too_old', ageMins };
        if (ageMins < -5) return { ok: false, reason: 'bad_timestamp', ageMins }; // photo "from the future"
        return { ok: true, reason: 'fresh', ageMins };
    } catch (err) {
        console.error('Photo proof check failed:', err.message);
        return { ok: false, reason: 'check_error' };
    }
}
// ==== PHOTO PROOF END ====

// STRIPE WEBHOOK MUST BE BEFORE express.json
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
            const { error } = await supabase
                .from('users')
                .update({ status: 'pro' })
                .eq('phone_number', phoneNumber);
            if (error) console.error('Failed to upgrade user in Supabase:', error.message);
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
- TRIAL QUESTIONS: If the user asks about their trial, look at the "Current Server Date" and "Trial Ends At" variables below and tell them exactly how much time they have left.
- PHOTO PROOF: If a [System note] appears after the user's message, follow it exactly. Never say a rejected photo counts.

EXTRACTION INSTRUCTIONS (Hidden JSON tags):
Whenever the user sets a reminder, gives a deadline, asks you to text/remind/check on them in a set amount of time (e.g. "remind me in 20 mins", "in an hour", "at 5pm"), reschedules, cancels, completes a task, or mentions their timezone, you MUST append the matching hidden tag at the VERY END of your reply:

1. Reminders / Deadlines / Reschedules (MANDATORY whenever a time or duration is mentioned):
   - If the user asks for a reminder in X minutes/hours (e.g. "remind me in 15 mins to stretch") or sets a deadline (e.g. "gym at 6pm", "give me 30 mins"):
   - Calculate "minutes_from_now" as an integer (convert hours or clock times using Current User Local Time).
   - Set "is_simple_reminder": true if they specifically asked to be reminded *in* X minutes ("remind me in 10 mins"), or false if it's a deadline they need a heads-up before ("i need to leave in 45 mins").
   <<<{"has_deadline": true, "minutes_from_now": 15, "goal": "stretch", "is_simple_reminder": true, "reschedule": false}>>>

2. Cancellations or Completed Tasks (when user says they finished it, or asks to cancel/stop reminders):
   <<<{"cancel_active": true}>>>

3. Timezone Updates (when user mentions their city or timezone):
   <<<{"update_timezone": "America/Vancouver"}>>>

4. Double Texting (OPTIONAL):
   To seem more human, if the user is making excuses or struggling, you can SOMETIMES (about 20% of the time) send a follow-up text a few seconds later. Use this strictly for follow-up thoughts (e.g. "the hard part is just going once ur in there").
   <<<{"double_text": "your second message here"}>>>
`;

async function generateWithRetry(promptContent, retries = 3) {
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    let lastErr;
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const result = await model.generateContent(promptContent);
            return result.response.text();
        } catch (err) {
            lastErr = err;
            console.error(`Gemini attempt ${attempt + 1} failed (${GEMINI_MODEL}):`, err.message);
            if (attempt < retries - 1) await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
        }
    }
    throw lastErr || new Error('Gemini failed');
}

function cleanModelText(raw) {
    return String(raw || '')
        .replace(/<<<[\s\S]*?>>>/g, '')
        .replace(/\n+/g, ' ')
        .replace(/^["']|["']$/g, '')
        .trim();
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

    if (!fromNumber) {
        return res.status(400).send('Missing From number');
    }

    try {
        let { data: user } = await supabase
            .from('users')
            .select('*')
            .eq('phone_number', fromNumber)
            .maybeSingle();

        if (!user) {
            const trialEndsAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
            const { data: newUser, error: insertErr } = await supabase
                .from('users')
                .upsert([{
                    phone_number: fromNumber,
                    timezone: 'America/Vancouver',
                    status: 'trial',
                    trial_ends_at: trialEndsAt,
                    chat_history: [],
                }], { onConflict: 'phone_number' })
                .select()
                .single();

            if (insertErr) console.error('User creation error:', insertErr.message);
            user = newUser || {
                phone_number: fromNumber,
                timezone: 'America/Vancouver',
                status: 'trial',
                trial_ends_at: trialEndsAt,
                chat_history: [],
            };
        }

        const userTimezone = user.timezone || 'America/Vancouver';
        const now = new Date();
        const trialEnd = user.trial_ends_at ? new Date(user.trial_ends_at) : null;
        const isExpired = trialEnd ? now > trialEnd : false;

        const paymentLink = `https://buy.stripe.com/test_3cI6oJ0JjgpZ8xBePNbbG00?client_reference_id=${encodeURIComponent(fromNumber)}`;

        if (isExpired && user.status !== 'pro') {
            twiml.message(`trial's up bro. grab the pass for $5 to keep using bouncer: ${paymentLink}`);
            res.type('text/xml');
            return res.send(twiml.toString());
        }

        // Photo proof: only the first attached photo is checked
        let proof = null;
        if (numMedia > 0) {
            proof = await checkPhotoProof(req.body.MediaUrl0, req.body.MediaContentType0, userTimezone);
            console.log('Photo proof result:', proof);
        }
        const proofRejected = Boolean(proof && !proof.ok);

        // Fetch any currently active reminder so Bouncer knows about it and we don't accidentally kill future reminders
        const { data: activeReminders } = await supabase
            .from('reminders')
            .select('*')
            .eq('phone_number', fromNumber)
            .eq('completed', false)
            .lt('nag_stage', 4)
            .order('target_time', { ascending: false });

        const currentReminder = activeReminders && activeReminders.length > 0 ? activeReminders[0] : null;

        // Only silence post-deadline nagging (nag_stage >= 1) on a normal reply.
        // Do NOT set nag_stage = 4 when nag_stage === 0 (before the reminder time has even arrived).
        if (!proofRejected) {
            await supabase
                .from('reminders')
                .update({ nag_stage: 4 })
                .eq('phone_number', fromNumber)
                .eq('completed', false)
                .gte('nag_stage', 1);
        }

        // A verified photo marks the task done
        if (proof && proof.ok) {
            await supabase
                .from('reminders')
                .update({ completed: true, nag_stage: 4 })
                .eq('phone_number', fromNumber)
                .eq('completed', false);
        }

        let proofNote = '';
        if (proof && proof.ok) {
            proofNote = '\n[System note: the photo was verified as taken just now. Their task is marked done. Acknowledge it briefly.]';
        } else if (proof) {
            proofNote = `\n[System note: their task is NOT done. ${PROOF_NOTES[proof.reason] || PROOF_NOTES.check_error}]`;
        }

        let localTimeStr;
        try {
            localTimeStr = now.toLocaleTimeString('en-US', { timeZone: userTimezone, hour: 'numeric', minute: '2-digit', hour12: true });
        } catch {
            localTimeStr = now.toLocaleTimeString('en-US', { timeZone: 'America/Vancouver', hour: 'numeric', minute: '2-digit', hour12: true });
        }

        let activeReminderContext = 'None';
        if (currentReminder && !(proof && proof.ok)) {
            const minsLeft = Math.round((new Date(currentReminder.target_time) - now) / 60000);
            activeReminderContext = minsLeft >= 0
                ? `"${currentReminder.goal_text}" due in ${minsLeft} mins`
                : `"${currentReminder.goal_text}" (overdue by ${Math.abs(minsLeft)} mins)`;
        }

        // Pull persistent history from Supabase
        const history = Array.isArray(user.chat_history) ? [...user.chat_history] : [];
        const historyText = history.map((h) => `${h.role === 'user' ? 'User' : 'Bouncer'}: "${h.text}"`).join('\n');

        const promptPayload = `${BOUNCER_SYSTEM_PROMPT}\nUser Timezone: ${userTimezone}\nCurrent User Local Time: ${localTimeStr}\nCurrent Server Date: ${now.toISOString()}\nTrial Ends At: ${user.trial_ends_at}\nActive Reminder: ${activeReminderContext}\n\nRecent context:\n${historyText}\nUser: "${userText || '[sent image]'}"${proofNote}\nBouncer:`;

        history.push({ role: 'user', text: userText || '[sent media]' });

        const rawReply = await generateWithRetry(promptPayload, 3);
        let doubleTextMsg = null;

        const jsonMatches = rawReply.match(/<<<([\s\S]*?)>>>/g);
        if (jsonMatches) {
            for (const rawTag of jsonMatches) {
                try {
                    const parsed = JSON.parse(rawTag.replace(/<<<|>>>/g, '').trim());

                    if (parsed.double_text) {
                        doubleTextMsg = String(parsed.double_text).trim();
                    }

                    if (parsed.cancel_active) {
                        await supabase
                            .from('reminders')
                            .update({ completed: true, nag_stage: 4 })
                            .eq('phone_number', fromNumber)
                            .eq('completed', false);
                    }

                    if (parsed.has_deadline && typeof parsed.minutes_from_now === 'number' && !Number.isNaN(parsed.minutes_from_now)) {
                        const mins = Math.max(1, Math.round(parsed.minutes_from_now));
                        const target = new Date(Date.now() + mins * 60000);

                        // Only schedule a pre-nag if it's NOT a simple "remind me in X mins" timer and is > 10 mins away
                        let preNagAt = null;
                        const isSimpleReminder = Boolean(parsed.is_simple_reminder);
                        if (!isSimpleReminder && mins > 10) {
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

                        // Clear previous uncompleted reminders for this user before inserting the new one
                        await supabase
                            .from('reminders')
                            .update({ completed: true, nag_stage: 4 })
                            .eq('phone_number', fromNumber)
                            .eq('completed', false);

                        const { error: remErr } = await supabase.from('reminders').insert([{
                            phone_number: fromNumber,
                            goal_text: parsed.goal || 'your task',
                            target_time: target.toISOString(),
                            pre_nag_at: preNagAt,
                            pre_nagged: isSimpleReminder,
                            nag_stage: 0,
                            completed: false,
                        }]);
                        if (remErr) {
                            console.error('Failed to insert reminder:', remErr.message);
                        } else {
                            console.log(`Scheduled reminder for ${fromNumber} in ${mins}m: "${parsed.goal || 'your task'}" (target: ${target.toISOString()})`);
                        }
                    }

                    if (parsed.update_timezone) {
                        await supabase
                            .from('users')
                            .update({ timezone: parsed.update_timezone })
                            .eq('phone_number', fromNumber);
                    }
                } catch (e) {
                    console.error('Error parsing tag:', e.message);
                }
            }
        }

        const cleanReply = cleanModelText(rawReply) || 'bet.';
        history.push({ role: 'model', text: cleanReply });

        if (doubleTextMsg) {
            history.push({ role: 'model', text: doubleTextMsg });
        }

        // Save history permanently (keep last 12 turns)
        await supabase
            .from('users')
            .update({ chat_history: history.slice(-12) })
            .eq('phone_number', fromNumber);

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
                        body: doubleTextMsg,
                    });
                } catch (err) {
                    console.error('Double text failed:', err.message);
                }
            }, 4500);
        }
    } catch (err) {
        console.error('Route error:', err);
        twiml.message('my bad phone froze, say that again?');
        res.type('text/xml');
        res.send(twiml.toString());
    }
});

// ==== SCALABLE REMINDER ENGINE (25+ USERS) ====
let isCronRunning = false;
const CONCURRENCY_LIMIT = 5;

async function processReminders() {
    if (isCronRunning) {
        return { skipped: true, reason: 'already_running' };
    }
    isCronRunning = true;

    try {
        const now = new Date();

        const { data: activeList, error } = await supabase
            .from('reminders')
            .select('*')
            .eq('completed', false)
            .lt('nag_stage', 4);

        if (error) {
            console.error('Supabase fetch reminders error:', error.message);
            return { error: error.message };
        }
        if (!activeList || activeList.length === 0) {
            return { checked: 0, due: 0, sent: [] };
        }

        const rawFrom = (process.env.TWILIO_PHONE_NUMBER || '').replace(/^whatsapp:/, '').trim();
        if (!rawFrom) {
            console.error('TWILIO_PHONE_NUMBER is not set; cannot send outbound reminder texts.');
            return { error: 'Missing TWILIO_PHONE_NUMBER env var' };
        }

        // 1. Filter in-memory first so we only query user histories & Gemini for reminders that are ACTUALLY due right now
        const dueActions = [];
        for (const item of activeList) {
            const target = new Date(item.target_time);
            const diffMins = (now - target) / 60000;
            const isPreNagDue = Boolean(item.pre_nag_at && now >= new Date(item.pre_nag_at) && diffMins < 0);

            if (!item.pre_nagged && isPreNagDue) {
                const remaining = Math.max(1, Math.round(Math.abs(diffMins)));
                dueActions.push({
                    item,
                    nextStage: item.nag_stage,
                    isPreNagged: true,
                    promptBuilder: (styleGuide) =>
                        `User has to do "${item.goal_text}" in ${remaining} minutes. Send a quick heads up reminding them. ${styleGuide}`,
                });
            } else if (diffMins >= 0 && item.nag_stage === 0) {
                dueActions.push({
                    item,
                    nextStage: 1,
                    isPreNagged: item.pre_nagged,
                    promptBuilder: (styleGuide) =>
                        `Time is up for "${item.goal_text}". Send a super quick text reminding them to do it right now or asking if they started. ${styleGuide}`,
                });
            } else if (diffMins >= 10 && item.nag_stage === 1) {
                dueActions.push({
                    item,
                    nextStage: 2,
                    isPreNagged: item.pre_nagged,
                    promptBuilder: (styleGuide) =>
                        `It's been 10 mins since deadline for "${item.goal_text}". Tell them to get off their phone and do it. Roast them simply. ${styleGuide}`,
                });
            } else if (diffMins >= 60 && item.nag_stage === 2) {
                dueActions.push({
                    item,
                    nextStage: 4,
                    isPreNagged: item.pre_nagged,
                    promptBuilder: (styleGuide) =>
                        `An hour past deadline for "${item.goal_text}". Give them one final super brief nudge. ${styleGuide}`,
                });
            }
        }

        if (dueActions.length === 0) {
            return { checked: activeList.length, due: 0, sent: [] };
        }

        // 2. Batch-fetch chat histories for all due users in ONE Supabase query
        const duePhones = [...new Set(dueActions.map((d) => d.item.phone_number))];
        const { data: usersData } = await supabase
            .from('users')
            .select('phone_number, chat_history')
            .in('phone_number', duePhones);

        const userHistoryMap = new Map();
        for (const u of usersData || []) {
            userHistoryMap.set(u.phone_number, Array.isArray(u.chat_history) ? u.chat_history : []);
        }

        const results = [];

        // 3. Process due reminders in parallel batches of CONCURRENCY_LIMIT
        for (let i = 0; i < dueActions.length; i += CONCURRENCY_LIMIT) {
            const batch = dueActions.slice(i, i + CONCURRENCY_LIMIT);

            const batchOutcomes = await Promise.allSettled(
                batch.map(async ({ item, nextStage, isPreNagged, promptBuilder }) => {
                    // Atomically claim this reminder transition in Supabase first
                    const { data: claimed, error: claimErr } = await supabase
                        .from('reminders')
                        .update({ pre_nagged: isPreNagged, nag_stage: nextStage })
                        .eq('id', item.id)
                        .eq('nag_stage', item.nag_stage)
                        .eq('pre_nagged', item.pre_nagged)
                        .eq('completed', false)
                        .select('id');

                    if (claimErr || !claimed || claimed.length === 0) {
                        return null;
                    }

                    const history = [...(userHistoryMap.get(item.phone_number) || [])];
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
- Do NOT output any <<<JSON>>> tags.
`;

                    try {
                        const rawRoast = await generateWithRetry(promptBuilder(styleGuide), 2);
                        const roast = cleanModelText(rawRoast) || `time for ${item.goal_text}. lock in.`;
                        const rawTo = item.phone_number.replace(/^whatsapp:/, '').trim();

                        const msg = await twilioClient.messages.create({
                            from: rawFrom,
                            to: rawTo,
                            body: roast,
                        });

                        history.push({ role: 'model', text: roast });
                        await supabase
                            .from('users')
                            .update({ chat_history: history.slice(-12) })
                            .eq('phone_number', item.phone_number);

                        return { id: item.id, stage: nextStage, status: 'sent', sid: msg.sid };
                    } catch (sendErr) {
                        // Roll back the stage claim if sending failed so the next tick can retry
                        await supabase
                            .from('reminders')
                            .update({ pre_nagged: item.pre_nagged, nag_stage: item.nag_stage })
                            .eq('id', item.id);
                        throw sendErr;
                    }
                })
            );

            for (const outcome of batchOutcomes) {
                if (outcome.status === 'fulfilled' && outcome.value) {
                    results.push(outcome.value);
                } else if (outcome.status === 'rejected') {
                    console.error('Reminder dispatch error:', outcome.reason?.message || outcome.reason);
                }
            }
        }

        return { checked: activeList.length, due: dueActions.length, sent: results };
    } catch (err) {
        console.error('Fatal cron check error:', err);
        return { error: err.message };
    } finally {
        isCronRunning = false;
    }
}

// Automated Nagging Cron Endpoint
app.get('/cron/check-reminders', async (req, res) => {
    if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}` && req.query.secret !== process.env.CRON_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const summary = await processReminders();
    res.status(200).json(summary);
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`Bouncer running on port ${PORT}`);
});

// Built-in background ticker so reminders fire automatically every 30 seconds
const CRON_INTERVAL_MS = parseInt(process.env.CRON_INTERVAL_MS || '30000', 10);
const cronTimer = setInterval(() => {
    processReminders().catch((err) => console.error('Background reminder loop error:', err.message));
}, CRON_INTERVAL_MS);

// Graceful shutdown
function shutdown() {
    clearInterval(cronTimer);
    server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
