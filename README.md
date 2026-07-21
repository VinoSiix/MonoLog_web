# Monolog 📝

**Type a thought. AI figures out the rest.**

A notes + reminders app with one input and zero decisions. You write a single
thought — "text sam back about friday", "ian's playlist", "stop overthinking
the email" — and Monolog figures out whether it's a note to keep or a
reminder that needs to fire at a specific time. No folders. No categories.
No "is this a note or a reminder?" menus.

---

## What it is

Every other notes app makes you decide what kind of thought you're having
before you've finished having it. Monolog lets you just think.

You write. Monolog reads your words, understands whether it's something to
remember or something that needs to fire at a specific time, and routes it
correctly. Notes land on your device. Reminders fire on time.

The whole thing is local-first: notes live on your device. The AI only sees
the specific thought you submit for sorting — never your whole library.

### Free tier

5 AI-sorted thoughts per day. No card, no account, no trial expiration. Paid
plans (unlimited sorting) coming soon.

---

## Try it

**Web app (free, no account):** <https://mono-log-web.vercel.app/app/>

Landing page: <https://mono-log-web.vercel.app/>

---

## Stack

| Layer | Tech |
|---|---|
| Framework | Expo SDK 56, React Native, React 19 |
| Navigation | expo-router (file-based, typed routes) |
| State / storage | AsyncStorage (local-first) |
| AI | Groq inference API (LLaMA models) |
| Backend | Cloudflare Worker (waitlist + AI proxy) |
| Web deployment | Vercel (static export) |

---

## Project structure

```
src/                 # app source (tabs, components, lib)
worker/              # Cloudflare Worker — AI proxy + waitlist
  src/index.ts       # worker entry
  wrangler.toml      # deploy config (Cloudflare)
assets/              # icons, splash, favicon
scripts/build-web.js # builds the static web export to dist/
index.html           # landing page (pure HTML/CSS, no framework)
privacy.html         # privacy policy
terms.html           # terms of service
App.tsx              # main Expo app entry
```

---

## Setup (for local dev)

```bash
# 1. Install dependencies
npm install

# 2. (Optional) Configure env vars for AI proxy
#    The web app routes AI requests through the deployed worker by default.
#    To use Groq directly in dev, set EXPO_PUBLIC_GROQ_API_KEY in .env.

# 3. Start the dev server
npm start
# then press: i (iOS), a (Android), or w (web)
```

### Deploying the worker

The AI proxy + waitlist worker is in `worker/`. Deploy with:

```bash
cd worker
npm install
npx wrangler deploy
```

Set the secrets:

```bash
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put ADMIN_USER
npx wrangler secret put ADMIN_PASS
```

The worker endpoint is hard-coded in the web app. Update it in `App.tsx`
if you redeploy to a different URL.

---

## How the AI works

When you submit a thought, Monolog:

1. Sends the single thought (not your library) over HTTPS to the worker.
2. The worker forwards it to Groq's inference API with a structured prompt.
3. The model returns a classification: `note` or `reminder`, plus extracted
   time info for reminders.
4. The worker hands the result back to the app. The app stores the note or
   schedules the reminder locally.

Your existing notes library never leaves your device. If you don't tap
submit, nothing leaves your phone.

---

## Privacy

Monolog is local-first. Your notes library never leaves your device. The AI
only sees the specific thought you submit for sorting.

See [privacy.html](./privacy.html) and [terms.html](./terms.html).

---

## License

MIT — see [LICENSE](./LICENSE). © 2026 Tim Kuusi.
