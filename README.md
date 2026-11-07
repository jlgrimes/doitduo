# App Updates

A minimal Next.js site that finds app updates across the web and shows when each one shipped, with a confidence score.

## How it works

1. **Collect.** Pulls ~20 RSS/Atom feeds (`lib/sources.ts`): tech press (9to5Mac, The Verge, Android Police…), company blogs and changelogs (GitHub, OpenAI, Spotify…), and Google News searches. Articles from the last 7 days that mention update-ish words become candidates.
2. **Decide (Jev).** Every candidate article goes to **Jev**, TypeSafe AI's decision model (`typesafe-ai/jev`), through **Vercel AI Gateway** (`lib/classify.ts`). Jev answers typed questions with real probabilities: *is this an app update?* (boolean) and *what's its status?* (shipped / rolling out / beta / announced / rumor). When Jev is unsure (P between 0.35 and 0.65, or status confidence under 0.5), the gateway's conditional decision fallback re-asks Claude Sonnet.
3. **Extract.** For articles Jev rates at least 30% likely to be an update, Claude Haiku pulls out the app name, version, platforms and a one-line summary.
4. **Group & cross-check.** Reports about the same app within 3 days are merged into one update. Each app is matched against the App Store (top charts + search) to see if a new version was released around the same time.
5. **Confidence.** Each article's evidence is `P(update) × P(shipped or rolling out, + half of beta) × source weight` (official blog 1.0, press 0.9, aggregator 0.75). Independent publishers are combined with a noisy-OR, and a matching App Store release closes part of the remaining doubt. The result is the probability that the update is real and live: 75%+ is High, 50%+ Medium.

All AI results are cached per article for 14 days, so each article is only processed once.

App Store releases with no news coverage are listed separately under **App Store**, using Apple's own release timestamp.

- `/` — the feed (filters: source, time range, minimum confidence)
- `/api/updates` — the same data as JSON

The feed is cached for 30 minutes.

## AI Gateway

On Vercel, AI Gateway authenticates automatically with the project's OIDC token, so no API key is needed. Locally, set `AI_GATEWAY_API_KEY` (or run `vercel env pull`). Override models with `DECISION_MODEL` (default `typesafe-ai/jev`) and `AI_MODEL` (extraction, default `anthropic/claude-haiku-5.5`).

```bash
npm install
npm run dev
```
