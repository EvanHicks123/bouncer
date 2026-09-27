# GymBot — SMS gym accountability roast bot

Texts you to hold you to your gym commitments. Say "going to the gym later" → it
tracks it. Send a photo before midnight → hype text. Ghost it → roast text.

## How it works

- `/sms` endpoint receives incoming texts from Twilio
- Claude API classifies each text as a commitment or just chat
- Commitments are stored in a local `db.json` file with a deadline (end of day)
- A cron job runs nightly at 11pm, checks for anyone who didn't send proof,
  and fires off a generated roast

## Setup

1. **Get a Twilio account**: https://www.twilio.com/try-twilio
   - Free trial gives you credit + a phone number
   - Find your Account SID and Auth Token on the Twilio Console dashboard
   - Buy/activate a phone number that supports SMS + MMS (for photos)

2. **Get an Anthropic API key**: https://console.anthropic.com
   - Create a key under Settings → API Keys
   - Note: this is billed separately from a claude.ai subscription

3. **Install dependencies**
   ```
   npm install
   ```

4. **Set up your `.env` file**
   ```
   cp .env.example .env
   ```
   Fill in your real Twilio SID/token/number and Anthropic key.

5. **Run locally**
   ```
   node index.js
   ```
   Server starts on port 3000 (or whatever you set in `.env`).

## Connecting Twilio to your server

Twilio needs to reach your `/sms` endpoint over the public internet, so
`localhost` alone won't work. Two options:

**Quick test (temporary public URL):**
- Install [ngrok](https://ngrok.com), run `ngrok http 3000`
- Copy the `https://...ngrok-free.app` URL it gives you
- In the Twilio Console, go to your phone number's settings → set the
  "A message comes in" webhook to `https://your-ngrok-url.ngrok-free.app/sms`
  (method: HTTP POST)

**Real deployment (so it's always on):**
- Deploy this folder to Railway, Render, or Fly.io (all have free/cheap tiers)
- Set your `.env` values as environment variables in their dashboard
- Point the Twilio webhook at your deployed URL + `/sms`
- Keep in mind: `db.json` is a flat file, so it will NOT persist reliably
  on most serverless/ephemeral hosts. Fine for your first tests; switch to
  a real database (e.g. SQLite via Railway volumes, or Postgres) once you're
  past prototyping.

## Testing it yourself

1. Text your Twilio number: "gonna go to the gym later"
2. You should get a reply locking that in
3. Either:
   - Text a photo before midnight → hype message
   - Wait until 11pm without sending one → roast message (or temporarily
     change the cron time in `index.js` to test faster, e.g. run it a
     minute from now)

## Known limitations (fine for prototyping, fix before charging money)

- Single timezone assumption (server time) — commitments/roasts don't
  account for each user's own timezone yet
- No user accounts, payment, or trial-tracking logic yet — this is just
  the core SMS loop
- `db.json` isn't safe for concurrent/production use — swap for a real DB
  before you have real users relying on it
- No retry/error handling if Twilio or Claude API calls fail transiently
