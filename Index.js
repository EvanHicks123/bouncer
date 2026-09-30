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
You are "Bouncer", the user's friend and accountability partner over SMS.
CRITICAL PERSONA RULE:
You are NOT a nightclub security bouncer. NEVER use metaphors about clubs, velvet ropes, VIP lines, doors, locks, or security guards.

CORE RULES:
- EXTREME BREVITY: 10 words maximum. Be concise.
- TONE: Sound like a normal human guy texting his friend. Do not force a heavy roast every time. Sometimes just say "lock in bro", "where you at", or "get off your phone".
- NEVER use the word "lag", "lagging", or "lagger".
- Text like a real person: lowercase, casual, zero emojis unless ironic.
- Exactly ONE single text bubble only. Never use line breaks.
- If they state or change a plan, acknowledge it casually ("bet", "ight").
- If they send proof of work, give quick props.

EXTRACTION INSTRUCTIONS:
1. Deadlines / Reschedules:
Using "Current User Local Time", if the user states a commitment OR changes/reschedules an existing time (e.g. "at 1:30", "change it to 1:32", "in 10 mins"), calculate the minutes from right now until that deadline.
Append this exact hidden tag:
<<<{"has_deadline": true, "minutes_from_now": 14, "goal": "gym", "reschedule": true}>>>

2. Cancellations:
If the user explicitly cancels their plan:
<<<{"cancel_active": true}>>>

3. Timezone Updates:
If the user mentions their city or timezone:
<<<{"update_timezone": "America/Vancouver"}>>>

If none apply, output no <<<>>> tags.
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

    // STOP FOLLOW-UP NAGS: Any incoming response from user stops further overdue nags
    await supabase
      .from('reminders')
      .update({ nag_stage: 4 })
      .eq('phone_number', fromNumber)
      .eq('completed', false);

    // If proof photo is sent, mark reminder fully completed
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

      const history = userHistories.get(item.phone_number) || [];
      const historySnippet = history.length > 0
        ? history.map((h) => `${h.role === 'user' ? 'User' : 'Friend'}: "${h.text}"`).join('\n')
        : '';

      const styleGuide = `
Recent chat history:
${historySnippet}

CRITICAL RULES:
- EXTREME BREVITY: 10 words maximum. Be concise.
- TONE: You are a normal friend. Do not try too hard to roast them. Just tell them to lock in, get off their phone, or ask where they are.
- NEVER use the word "lag" or "lagging".
- Match the user's lowercase casual style.
- Exactly ONE short text bubble.
`;

      // 1. Relative Pre-reminder
      const isPreNagDue = item.pre_nag_at && now >= new Date(item.pre_nag_at) && diffMins < 0;
      if (!item.pre_nagged && isPreNagDue) {
        const remaining = Math.max(1, Math.round(Math.abs(diffMins)));
        prompt = `User has to do "${item.goal_text}" in ${remaining} minutes. Send a quick heads up reminding them. ${styleGuide}`;
        isPreNagged = true;
        updateRequired = true;
      }
      // 2. Stage 0: Exactly at deadline
      else if (diffMins >= 0 && item.nag_stage === 0) {
        prompt = `Time is up for "${item.goal_text}". Send a super quick text telling them to lock in or asking if they are there. ${styleGuide}`;
        nextStage = 1;
        updateRequired = true;
      }
      // 3. Stage 1: +10 mins late
      else if (diffMins >= 10 && item.nag_stage === 1) {
        prompt = `It's been 10 mins since deadline for "${item.goal_text}". Tell them to get off their phone and do it. ${styleGuide}`;
        nextStage = 2;
        updateRequired = true;
      }
      // 4. Stage 2: +60 mins late
      else if (diffMins >= 60 && item.nag_stage === 2) {
        prompt = `An hour past deadline for "${item.goal_text}". Give them one final super brief nudge. ${styleGuide}`;
        nextStage = 4; // Stop nagging after this
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
