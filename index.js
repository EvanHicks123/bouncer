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

// Time constants & multiplication helper (avoids raw asterisk characters that get stripped when copy-pasting through Markdown viewers)
const ONE_SECOND_MS = 1000;
const ONE_MINUTE_MS = 60000;
const THREE_DAYS_MS = 259200000;
function multiply(a, b) {
    return a / (1 / b);
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
// A photo only counts as proof if its metadata says it was taken recently (or if carrier MMS stripped EXIF and Gemini Vision verifies it).
// Optional env vars: PROOF_MAX_AGE_MINS (default 30), REQUIRE_PHOTO_METADATA (default false so carrier MMS stripping doesn't block real camera photos)
const PROOF_MAX_AGE_MINS = parseInt(process.env.PROOF_MAX_AGE_MINS || '30', 10);
const REQUIRE_PHOTO_METADATA = process.env.REQUIRE_PHOTO_METADATA === 'true';

// What the bot is told when a photo does not count (Gemini words the actual reply)
const PROOF_NOTES = {
    too_old: 'the photo metadata shows it was taken too long ago, so it does not count. Roast them lightly for trying to use an old camera roll photo and tell them to take a fresh one right now.',
    no_metadata: 'the photo had no timestamp data, so it cannot be verified. Tell them to send a fresh photo taken right now with their camera.',
    bad_timestamp: 'the photo timestamp looks wrong. Tell them to send a fresh photo taken right now.',
    not_an_image: 'the attachment was not a photo. Tell them to send an actual photo.',
    download_failed: 'the photo did not come through. Ask them to send it again.',
    check_error: 'the photo could not be checked. Ask them to send it again.',
};

function parseOffsetMinutes(str) {
    const m = /^([+-])(\d{2}):?(\d{2})$/.exec(String(str || '').trim());
    if (!m) return null;
    const totalMins = multiply(Number(m[2]), 60) + Number(m[3]);
    return m[1] === '-' ? -totalMins : totalMins;
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
    const monthIndex = get('month') - 1;
    const asIfUtc = Date.UTC(get('year'), monthIndex, get('day'), get('hour'), get('minute'), get('second'));
    const truncatedUtc = multiply(Math.floor(utcMs / ONE_SECOND_MS), ONE_SECOND_MS);
    return asIfUtc - truncatedUtc;
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
    const monthIndex = mo - 1;
    const wallAsUtc = Date.UTC(y, monthIndex, d, h, mi, s);

    const offsetMins = parseOffsetMinutes(offsetStr);
    if (offsetMins !== null) {
        return wallAsUtc - multiply(offsetMins, ONE_MINUTE_MS);
    }

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
        const mimeType = contentType || 'image/jpeg';

        let meta = null;
        try {
            meta = await exifr.parse(buf, {
                pick: ['DateTimeOriginal', 'CreateDate', 'OffsetTimeOriginal', 'OffsetTimeDigitized', 'OffsetTime'],
                reviveValues: false, // keep the raw "YYYY:MM:DD HH:MM:SS" text so we control the timezone
            });
        } catch (exifErr) {
            console.warn('EXIF parse warning:', exifErr.message);
        }
        console.log('Photo metadata found:', meta || 'none');

        const usingOriginal = Boolean(meta && meta.DateTimeOriginal);
        const rawTime = meta && (meta.DateTimeOriginal || meta.CreateDate);
        if (!rawTime) {
            // Many carrier SMS/MMS gateways strip EXIF metadata from fresh camera photos.
            // If REQUIRE_PHOTO_METADATA is false (default), pass the image to Gemini Vision to verify its content!
            return REQUIRE_PHOTO_METADATA
                ? { ok: false, reason: 'no_metadata', buf, mimeType }
                : { ok: true, reason: 'no_metadata_allowed', buf, mimeType };
        }

        const offsetStr = (usingOriginal ? meta.OffsetTimeOriginal : meta.OffsetTimeDigitized) || meta.OffsetTime;
        const takenAtMs = exifTimeToUtcMs(rawTime, offsetStr, userZone);
        if (takenAtMs === null) return { ok: false, reason: 'bad_timestamp', buf, mimeType };

        const ageMins = (Date.now() - takenAtMs) / ONE_MINUTE_MS;
        if (ageMins > PROOF_MAX_AGE_MINS) return { ok: false, reason: 'too_old', ageMins, buf, mimeType };
        if (ageMins < -5) return { ok: false, reason: 'bad_timestamp', ageMins, buf, mimeType }; // photo "from the future"
        return { ok: true, reason: 'fresh', ageMins, buf, mimeType };
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
You are "Bouncer", the user's close friend and accountability partner over SMS.
CRITICAL PERSONA RULES:
- EXTREME BREVITY: 10 words maximum per text. Be concise.
- NEVER use nightclub or security guard metaphors.
- TEXT LIKE A REAL HUMAN: lowercase, casual, zero emojis unless ironic.
- VARIETY IS MANDATORY: You have a chat history. DO NOT repeat phrases like "lock in", "bet", or "don't flake" if you've said them recently. Change up your vocabulary every time.
- WHEN THEY ARE LAZY (ROASTING): If the user is whining, procrastinating, acting weak, or making excuses, call them out and roast them like a real friend (e.g., "if you dont go ur gonna stay small dude", "stop making excuses and just start"). No corny jokes—just blunt truth.
- WHEN THEY DO WELL (CONGRATULATING): When the user finishes a task, sends valid photo proof, or follows through on what they said they would do, genuinely congratulate and hype them up like a proud friend (e.g., "hell yeah good shit bro", "proud of u man keep stacking days", "that's what i'm talking about"). Reference what's in their photo if they sent one.
- FAKE PHOTO PROOF: If the user sent a photo for an active task, look at the image. If it clearly has nothing to do with their task (like a picture of a dark ceiling, floor, or couch when they said they're at the gym), roast them for faking proof and include <<<{"reject_photo": true}>>>.
- TRIAL QUESTIONS: If the user asks about their trial, look at "Current Server Date" and "Trial Ends At" below and tell them how much time they have left.
- PHOTO PROOF SYSTEM NOTES: If a [System note] appears after the user's message, follow it exactly. Never say a timestamp-rejected photo counts.

EXTRACTION INSTRUCTIONS (Hidden JSON tags):
Whenever the user sets a reminder, gives a deadline, asks you to text/remind/check on them in a set amount of time (e.g. "remind me in 20 mins", "in an hour", "at 5pm"), reschedules, cancels, completes a task, or mentions their timezone, you MUST append the matching hidden tag at the VERY END of your reply:

1. Reminders / Deadlines / Reschedules (MANDATORY whenever a time or duration is mentioned):
   - If the user asks for a reminder in X minutes/hours (e.g. "remind me in 15 mins to stretch") or sets a deadline (e.g. "gym at 6pm", "give me 30 mins"):
   - Calculate "minutes_from_now" as an integer (convert hours or clock times using Current User Local Time).
   - Set "is_simple_reminder": true if they specifically asked to be reminded in X minutes ("remind me in 10 mins"), or false if it's a deadline they need a heads-up before ("i need to leave in 45 mins").
   - Set "reschedule": true if they are pushing back or changing an existing active reminder, or false if it's a new task.
   <<<{"has_deadline": true, "minutes_from_now": 15, "goal": "stretch", "is_simple_reminder": true, "reschedule": false}>>>

2. Completed Task via Text (when user tells you they just finished or arrived at their active task, e.g. "done", "just finished", "i'm at the gym now"):
   <<<{"mark_done": true}>>>

3. Cancellations (when user explicitly asks to cancel/drop a reminder without doing it):
   <<<{"cancel_active": true}>>>

4. Timezone Updates (when user mentions their city or timezone):
   <<<{"update_timezone": "America/Vancouver"}>>>

5. Double Texting (OPTIONAL):
   To seem more human, if the user is making excuses or just crushed a big goal, you can SOMETIMES (about 20% of the time) send a follow-up text a few seconds later.
   <<<{"double_text": "your second message here"}>>>
`;

async function generateWithRetry(promptContent, retries = 3, imageAttachment = null) {
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const requestParts = imageAttachment
        ? [promptContent, { inlineData: { data: imageAttachment.buf.toString('base64'), mimeType: imageAttachment.mimeType } }]
        : promptContent;

    let lastErr;
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const result = await model.generateContent(requestParts);
            return result.response.text();
        } catch (err) {
            lastErr = err;
            console.error(`Gemini attempt ${attempt + 1} failed (${GEMINI_MODEL}):`, err.message);
            if (attempt < retries - 1) {
                const backoffMs = multiply(800, attempt + 1);
                await new Promise((res) => setTimeout(res, backoffMs));
            }
        }
    }
    throw lastErr || new Error('Gemini failed');
}

function cleanModelText(raw) {
    return String(raw || '')
        .replace(/<<<[^]+?>>>/g, '')
        .replace(/\n+/g, ' ')
        .replace(/^["']|["']$/g, '')
        .trim();
}

// Fallback parser in case the user explicitly writes "remind me in 15 mins to X" and the LLM omits the JSON tag
function parseFallbackReminder(text) {
    const m = /\b(?:remind(?:\s+me)?|text\s+me|check\s+on\s+me|hit\s+me\s+up|give\s+me)\s+in\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b(?:\s*(?:to|about|for)\s+(.+))?/i.exec(text);
    if (!m) return null;
    const amount = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    const minutesFromNow = unit.startsWith('h') ? multiply(amount, 60) : amount;
    const goal = (m[3] || '').replace(/[.!?]+$/, '').trim() || 'your task';
    return {
        has_deadline: true,
        minutes_from_now: minutesFromNow,
        goal,
        is_simple_reminder: true,
        reschedule: false,
    };
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
            .select()
            .eq('phone_number', fromNumber)
            .maybeSingle();

        if (!user) {
            const trialEndsAt = new Date(Date.now() + THREE_DAYS_MS).toISOString();
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

        // Photo proof: check first attached image
        let proof = null;
        if (numMedia > 0) {
            proof = await checkPhotoProof(req.body.MediaUrl0, req.body.MediaContentType0, userTimezone);
            console.log('Photo proof result:', proof ? { ok: proof.ok, reason: proof.reason, ageMins: proof.ageMins } : 'none');
        }

        // Fetch any currently active reminders so Bouncer knows what task is active
        const { data: activeReminders } = await supabase
            .from('reminders')
            .select()
            .eq('phone_number', fromNumber)
            .eq('completed', false)
            .lt('nag_stage', 4)
            .order('target_time', { ascending: true });

        const currentReminder = activeReminders && activeReminders.length > 0 ? activeReminders[0] : null;

        let proofNote = '';
        if (proof && proof.ok) {
            proofNote = currentReminder
                ? `\n[System note: the user sent a fresh photo for their active task "${currentReminder.goal_text}". Look at the attached image: if it plausibly shows them doing or completing "${currentReminder.goal_text}", genuinely congratulate/hype them up like a proud friend! If the photo is obviously fake/unrelated (like a blank wall, floor, or bed when they should be working out), roast them and output <<<{"reject_photo": true}>>>.]`
                : '\n[System note: the user sent a fresh photo. React to what is in the photo naturally like a friend and hype them up if they are being productive.]';
        } else if (proof) {
            proofNote = `\n[System note: their task is NOT done. ${PROOF_NOTES[proof.reason] || PROOF_NOTES.check_error}]`;
        }

        let localTimeStr;
        try {
            localTimeStr = now.toLocaleString('en-US', {
                timeZone: userTimezone,
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
            });
        } catch {
            localTimeStr = now.toLocaleString('en-US', {
                timeZone: 'America/Vancouver',
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
            });
        }

        let activeReminderContext = 'None';
        if (currentReminder) {
            const minsLeft = Math.round((new Date(currentReminder.target_time) - now) / ONE_MINUTE_MS);
            activeReminderContext = minsLeft >= 0
                ? `"${currentReminder.goal_text}" due in ${minsLeft} mins`
                : `"${currentReminder.goal_text}" (overdue by ${Math.abs(minsLeft)} mins)`;
        }

        // Pull persistent history from Supabase
        const history = Array.isArray(user.chat_history) ? [...user.chat_history] : [];
        const historyText = history.map((h) => `${h.role === 'user' ? 'User' : 'Bouncer'}: "${h.text}"`).join('\n');

        const promptPayload = `${BOUNCER_SYSTEM_PROMPT}\nUser Timezone: ${userTimezone}\nCurrent User Local Time: ${localTimeStr}\nCurrent Server Date: ${now.toISOString()}\nTrial Ends At: ${user.trial_ends_at}\nActive Reminder: ${activeReminderContext}\n\nRecent context:\n${historyText}\nUser: "${userText || '[sent photo]'}"${proofNote}\nBouncer:`;

        history.push({ role: 'user', text: userText || '[sent photo]' });

        const imageAttachment = proof && proof.ok && proof.buf ? { buf: proof.buf, mimeType: proof.mimeType } : null;
        const rawReply = await generateWithRetry(promptPayload, 3, imageAttachment);
        let doubleTextMsg = null;
        let photoRejectedByVision = false;
        let handledDeadlineTag = false;
        let markedDoneOrCanceled = false;

        const jsonMatches = rawReply.match(/<<<([^]+?)>>>/g);
        if (jsonMatches) {
            for (const rawTag of jsonMatches) {
                try {
                    const parsed = JSON.parse(rawTag.replace(/<<<|>>>/g, '').trim());

                    if (parsed.double_text) {
                        doubleTextMsg = String(parsed.double_text).trim();
                    }

                    if (parsed.reject_photo) {
                        photoRejectedByVision = true;
                    }

                    if (parsed.mark_done || parsed.cancel_active) {
                        markedDoneOrCanceled = true;
                        await supabase
                            .from('reminders')
                            .update({ completed: true, nag_stage: 4 })
                            .eq('phone_number', fromNumber)
                            .eq('completed', false);
                    }

                    if (parsed.has_deadline && typeof parsed.minutes_from_now === 'number' && !Number.isNaN(parsed.minutes_from_now)) {
                        handledDeadlineTag = true;
                        const mins = Math.max(1, Math.round(parsed.minutes_from_now));
                        const target = new Date(Date.now() + multiply(mins, ONE_MINUTE_MS));

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
                            preNagAt = new Date(target.getTime() - multiply(remindMinsBefore, ONE_MINUTE_MS)).toISOString();
                        }

                        // Clear previous uncompleted reminder if rescheduling or if one is already overdue
                        if (parsed.reschedule !== false || (currentReminder && new Date(currentReminder.target_time) <= now)) {
                            await supabase
                                .from('reminders')
                                .update({ completed: true, nag_stage: 4 })
                                .eq('phone_number', fromNumber)
                                .eq('completed', false);
                        }

                        const { error: remErr } = await supabase.from('reminders').insert([{
                            phone_number: fromNumber,
                            goal_text: parsed.goal || (currentReminder ? currentReminder.goal_text : 'your task'),
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

        // Fallback: if the user explicitly typed "remind me in X mins to Y" and Gemini forgot the JSON tag, schedule it anyway
        if (!handledDeadlineTag && userText) {
            const fallback = parseFallbackReminder(userText);
            if (fallback) {
                const mins = Math.max(1, fallback.minutes_from_now);
                const target = new Date(Date.now() + multiply(mins, ONE_MINUTE_MS));
                await supabase.from('reminders').insert([{
                    phone_number: fromNumber,
                    goal_text: fallback.goal,
                    target_time: target.toISOString(),
                    pre_nag_at: null,
                    pre_nagged: true,
                    nag_stage: 0,
                    completed: false,
                }]);
                console.log(`Fallback scheduled reminder for ${fromNumber} in ${mins}m: "${fallback.goal}"`);
            }
        }

        // A verified photo (that wasn't rejected as fake by Vision) marks the active task done
        if (proof && proof.ok && !photoRejectedByVision && !markedDoneOrCanceled) {
            await supabase
                .from('reminders')
                .update({ completed: true, nag_stage: 4 })
                .eq('phone_number', fromNumber)
                .eq('completed', false);
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
            .select()
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
            const diffMins = (now - target) / ONE_MINUTE_MS;
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
                        `It's been 10 mins since deadline for "${item.goal_text}". They haven't confirmed or sent proof yet. Tell them to stop being lazy, get off their phone, and do it. Roast them simply. ${styleGuide}`,
                });
            } else if (diffMins >= 60 && item.nag_stage === 2) {
                dueActions.push({
                    item,
                    nextStage: 4,
                    isPreNagged: item.pre_nagged,
                    promptBuilder: (styleGuide) =>
                        `An hour past deadline for "${item.goal_text}" and they still haven't done it. Give them one final blunt nudge calling them out for flaking. ${styleGuide}`,
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
                        const roast = cleanModelText(rawRoast) || `time for ${item.goal_text}. get on it.`;
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
if (require.main === module) {
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
}

module.exports = { app, processReminders, parseFallbackReminder, exifTimeToUtcMs, tzOffsetMs, wallClockToUtcMs };
