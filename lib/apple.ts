// App Store data, from Apple's public endpoints (no API key):
//   - Chart feeds (overall + every category) give a pool of popular app IDs.
//   - The iTunes lookup API gives each app's current version, release notes and
//     the exact time that version was released.
//   - Each app's App Store page embeds its full version history (notes, version,
//     exact release time), which is how we date when iPhone Duo support shipped.

import { unstable_cache } from "next/cache";

export type App = {
  id: number;
  name: string;
  developer: string;
  version: string;
  releasedAt: string; // ISO time the current version was released
  notes: string; // current version's release notes
  icon: string;
  url: string;
  genre: string;
};

export type VersionEntry = { version: string; releasedAt: string; notes: string };

const COUNTRY = "us";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15";

// App Store categories (genre IDs) whose top charts we pull.
const GENRES = [
  6000, 6001, 6002, 6003, 6004, 6005, 6006, 6007, 6008, 6009, 6010, 6011, 6012, 6013, 6014, 6015, 6016, 6017, 6018,
  6020, 6023, 6024, 6026, 6027,
];

const CHART_FEEDS = [
  ...["top-free", "top-paid"].map((c) => `https://rss.marketingtools.apple.com/api/v2/${COUNTRY}/apps/${c}/100/apps.json`),
  ...["topfreeapplications", "toppaidapplications", "topgrossingapplications", "newapplications", "newfreeapplications"].map(
    (c) => `https://itunes.apple.com/${COUNTRY}/rss/${c}/limit=100/json`,
  ),
  ...GENRES.flatMap((g) =>
    ["topfreeapplications", "toppaidapplications"].map(
      (c) => `https://itunes.apple.com/${COUNTRY}/rss/${c}/limit=100/genre=${g}/json`,
    ),
  ),
];

async function getJson(url: string, revalidate = 1800): Promise<unknown> {
  const res = await fetch(url, {
    next: { revalidate },
    signal: AbortSignal.timeout(10_000),
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function poolIds(): Promise<string[]> {
  const settled = await Promise.allSettled(
    CHART_FEEDS.map(async (url) => {
      const data = (await getJson(url, 6 * 3600)) as any;
      if (data?.feed?.results) return (data.feed.results as any[]).map((r) => String(r.id));
      const entries = data?.feed?.entry ?? [];
      return (Array.isArray(entries) ? entries : [entries]).map((e: any) => String(e?.id?.attributes?.["im:id"]));
    }),
  );
  const ids = new Set<string>();
  let failed = 0;
  for (const s of settled) {
    if (s.status === "fulfilled") s.value.forEach((id) => /^\d+$/.test(id) && ids.add(id));
    else failed++;
  }
  if (failed) console.warn(`${failed}/${CHART_FEEDS.length} chart feeds failed`);
  return [...ids];
}

function toApp(r: any): App | null {
  if (!r?.trackId || !r.currentVersionReleaseDate) return null;
  return {
    id: r.trackId,
    name: r.trackName,
    developer: r.artistName ?? r.sellerName ?? "",
    version: r.version ?? "",
    releasedAt: r.currentVersionReleaseDate,
    notes: (r.releaseNotes ?? "").trim(),
    icon: r.artworkUrl100 ?? r.artworkUrl60 ?? "",
    url: (r.trackViewUrl ?? `https://apps.apple.com/app/id${r.trackId}`).replace(/\?.*$/, ""),
    genre: r.primaryGenreName ?? "",
  };
}

export async function lookupApps(ids: string[]): Promise<App[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 150) chunks.push(ids.slice(i, i + 150));
  const apps: App[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (i < chunks.length) {
        const chunk = chunks[i++];
        try {
          const data = (await getJson(
            `https://itunes.apple.com/lookup?country=${COUNTRY}&entity=software&id=${chunk.join(",")}`,
          )) as any;
          for (const r of data?.results ?? []) {
            const app = toApp(r);
            if (app) apps.push(app);
          }
        } catch (e) {
          console.warn("lookup failed:", e instanceof Error ? e.message : e);
        }
      }
    }),
  );
  return apps;
}

/** Popular apps across the App Store, with current version info. */
export async function getAppPool(): Promise<App[]> {
  return lookupApps(await poolIds());
}

/** Search the App Store by name; returns the top few apps. */
export async function searchApps(term: string): Promise<App[]> {
  const url = `https://itunes.apple.com/search?country=${COUNTRY}&entity=software&limit=5&term=${encodeURIComponent(term)}`;
  const data = (await getJson(url, 6 * 3600)) as any;
  return ((data?.results ?? []) as any[]).map(toApp).filter((a): a is App => !!a);
}

/** Pulls the version history embedded in an app's App Store page. */
async function fetchVersionHistory(id: number): Promise<VersionEntry[]> {
  const res = await fetch(`https://apps.apple.com/${COUNTRY}/app/id${id}`, {
    cache: "no-store", // pages are ~1MB; we cache the parsed result instead
    signal: AbortSignal.timeout(15_000),
    headers: { "User-Agent": UA, "Accept-Language": "en-US" },
  });
  if (!res.ok) throw new Error(`app page ${id} -> ${res.status}`);
  const html = await res.text();
  const m = html.match(/<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error(`app page ${id}: no data`);
  const json = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));

  const out = new Map<string, VersionEntry>();
  const walk = (o: unknown) => {
    if (!o || typeof o !== "object") return;
    const r = o as any;
    if (r.$kind === "TitledParagraph" && r.primarySubtitle && r.secondarySubtitle) {
      const version = String(r.primarySubtitle).replace(/^Version\s+/i, "");
      const t = Date.parse(r.secondarySubtitle);
      if (!Number.isNaN(t) && !out.has(version))
        out.set(version, { version, releasedAt: new Date(t).toISOString(), notes: String(r.text ?? "") });
    }
    for (const v of Object.values(r)) walk(v);
  };
  walk(json);
  return [...out.values()].sort((a, b) => Date.parse(b.releasedAt) - Date.parse(a.releasedAt));
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Version history entries released since `since`, cached per app version
 * (history only changes when the app ships a new version).
 */
export function getRecentVersions(app: App, since: string): Promise<VersionEntry[]> {
  return unstable_cache(
    async () => (await fetchVersionHistory(app.id)).filter((v) => v.releasedAt >= since),
    ["history", "v1", String(app.id), app.version, since],
    { revalidate: 30 * 86400 },
  )();
}
