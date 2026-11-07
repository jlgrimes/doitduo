# App Updates

A minimal Next.js site that finds app updates across the web and shows when each one shipped, with a confidence score.

## How it works

1. **Collect.** Pulls ~20 RSS/Atom feeds (`lib/sources.ts`): tech press (9to5Mac, The Verge, Android Police…), company blogs and changelogs (GitHub, OpenAI, Spotify…), and Google News / Hacker News searches. Articles from the last 7 days that mention update-ish words become candidates.
2. **Read.** Each candidate article is read by an AI model through **Vercel AI Gateway** (`lib/classify.ts`). It decides whether the article reports a real app update, which app, its status (shipped / rolling out / announced / beta / rumor), and what changed. Results are cached per article, so each one is only classified once.
3. **Group & cross-check.** Reports about the same app within 3 days are merged into one update. Each app is matched against the App Store (top charts + search) to see if a new version was released around the same time.
4. **Score.** The confidence layer (`lib/feed.ts`) adds up signals: the AI's own confidence, the status, whether it's from the company itself, how many independent outlets report it, and App Store corroboration. 75+ is High, 50+ Medium.

App Store releases with no news coverage are listed separately under **App Store**, using Apple's own release timestamp.

- `/` — the feed (filters: source, time range, minimum confidence)
- `/api/updates` — the same data as JSON

The feed is cached for 30 minutes.

## AI Gateway

On Vercel, AI Gateway authenticates automatically with the project's OIDC token, so no API key is needed. Locally, set `AI_GATEWAY_API_KEY` (or run `vercel env pull`). Set `AI_MODEL` to use any other AI Gateway model ID (default `anthropic/claude-haiku-5.5`).

```bash
npm install
npm run dev
```
