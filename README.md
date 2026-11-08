# Works with iPhone Duo

A minimal Next.js site that tracks which App Store apps have shipped **iPhone Duo** support, and exactly when.

Every app runs on iPhone Duo (Apple's foldable, launched Oct 23, 2026), and the App Store lists `iPhoneDuo` as a supported device for all of them, so that tells you nothing. What matters is whether the developer actually built support for it. This site looks for explicit evidence of that.

## How it works

1. **App pool.** Top charts from the App Store, overall and for every category (a few thousand popular apps), via Apple's public feeds and the iTunes lookup API (`lib/apple.ts`).
2. **Only apps that could have it.** Apple opened iPhone Duo submissions on Oct 5, 2026, so only apps updated since then are checked.
3. **Release notes.** For each of those apps, the current release notes and the version history embedded in its App Store page (notes, version and exact release time for every version) are scanned for mentions of Duo. Version histories are cached per app version, so after the first pass only apps that ship a new version are re-fetched.
4. **Jev decides.** Every release note or news article that mentions Duo is judged by **Jev**, TypeSafe AI's decision model (`typesafe-ai/jev`), through **Vercel AI Gateway** (`lib/classify.ts`). It answers with probabilities: *does this say the app supports iPhone Duo?* and *is it full optimization, some improvements, only a bug fix, or "coming later"?* That filters out Duolingo's owl, Duo Security and "Duo support coming soon". When Jev is unsure, the gateway's conditional fallback re-asks Claude Sonnet.
5. **News.** Tech press, company blogs and Google News searches for iPhone Duo app support (`lib/sources.ts`). Articles Jev says report Duo support have their apps extracted by Claude Haiku, matched to App Store listings, and Jev confirms each match.
6. **Confidence and timestamp** (`lib/feed.ts`). Each piece of evidence counts as `P(supports Duo) × (optimized + 0.7·improved + 0.3·fix only) × weight` (release notes 0.97, official blog 1.0, press 0.9, search results 0.75, news also × P(right app)). Independent sources combine with a noisy-OR. The timestamp is the release time of the first version whose notes announce Duo support, or the first article if the notes never mention it.

`/` is the list; `/api/updates` is the same data as JSON. The feed refreshes every 30 minutes; each refresh scans up to two minutes' worth of not-yet-cached version histories, so coverage grows over the first few refreshes.

**Limits:** apps that support Duo without saying so in their release notes or in the news won't appear. Apple's "Made for iPhone Duo" badge isn't exposed in the App Store's page data yet, so it can't be checked.

## AI Gateway

On Vercel, AI Gateway authenticates automatically with the project's OIDC token, so no API key is needed. Locally, set `AI_GATEWAY_API_KEY` (or run `vercel env pull`). Override models with `DECISION_MODEL` (default `typesafe-ai/jev`) and `AI_MODEL` (extraction, default `anthropic/claude-haiku-5.5`).

```bash
npm install
npm run dev
```
