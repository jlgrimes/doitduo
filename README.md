# App Updates

A minimal Next.js site that scrapes the App Store for recent app updates and shows when each app shipped its latest version, with the exact release timestamp.

**How it works:** Apple's public chart feeds (top free, paid, grossing, new) give a pool of a few hundred popular apps. The iTunes lookup API returns each app's current version, release notes, and `currentVersionReleaseDate`. The page re-scrapes at most every 30 minutes (ISR), so there's no database or API key.

- `/` — the feed, grouped by day, with search and 24h / 7d / 30d / all filters
- `/api/updates` — the same data as JSON

```bash
npm install
npm run dev
```

The scraper lives in `lib/apple.ts`.
