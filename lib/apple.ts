// Scrapes Apple's public App Store endpoints to find apps that were updated
// recently. No API key needed:
//   1. Chart feeds (top free / paid / grossing / new) give a pool of app IDs.
//   2. The iTunes lookup API gives each app's current version and the exact
//      timestamp that version was released (`currentVersionReleaseDate`).

export type AppUpdate = {
  id: number;
  name: string;
  developer: string;
  version: string;
  releasedAt: string; // ISO timestamp of the current version's release
  notes: string;
  icon: string;
  url: string;
  genre: string;
};

export type UpdatesResult = {
  updates: AppUpdate[];
  checkedAt: string; // ISO timestamp of when we scraped
  appsScanned: number;
};

const COUNTRY = "us";
const REVALIDATE = 60 * 30; // re-scrape at most every 30 minutes

const CHART_FEEDS_V2 = ["top-free", "top-paid"].map(
  (chart) =>
    `https://rss.marketingtools.apple.com/api/v2/${COUNTRY}/apps/${chart}/100/apps.json`,
);

const CHART_FEEDS_LEGACY = [
  "topfreeapplications",
  "toppaidapplications",
  "topgrossingapplications",
  "newapplications",
  "newfreeapplications",
].map((chart) => `https://itunes.apple.com/${COUNTRY}/rss/${chart}/limit=100/json`);

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    next: { revalidate: REVALIDATE },
    headers: { "User-Agent": "doitduo-app-updates/1.0" },
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function chartIds(): Promise<string[]> {
  const v2 = CHART_FEEDS_V2.map(async (url) => {
    const data = (await getJson(url)) as any;
    return ((data?.feed?.results ?? []) as any[]).map((r) => String(r.id));
  });
  const legacy = CHART_FEEDS_LEGACY.map(async (url) => {
    const data = (await getJson(url)) as any;
    const entries = data?.feed?.entry ?? [];
    return (Array.isArray(entries) ? entries : [entries]).map((e: any) =>
      String(e?.id?.attributes?.["im:id"]),
    );
  });

  const settled = await Promise.allSettled([...v2, ...legacy]);
  const ids = new Set<string>();
  for (const s of settled) {
    if (s.status === "fulfilled") s.value.forEach((id) => /^\d+$/.test(id) && ids.add(id));
    else console.warn("chart feed failed:", s.reason);
  }
  return [...ids];
}

async function lookup(ids: string[]): Promise<AppUpdate[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));

  const settled = await Promise.allSettled(
    chunks.map(async (chunk) => {
      const url = `https://itunes.apple.com/lookup?country=${COUNTRY}&entity=software&id=${chunk.join(",")}`;
      const data = (await getJson(url)) as any;
      return (data?.results ?? []) as any[];
    }),
  );

  const apps: AppUpdate[] = [];
  for (const s of settled) {
    if (s.status !== "fulfilled") {
      console.warn("lookup failed:", s.reason);
      continue;
    }
    for (const r of s.value) {
      if (!r?.trackId || !r.currentVersionReleaseDate) continue;
      apps.push({
        id: r.trackId,
        name: r.trackName,
        developer: r.artistName ?? r.sellerName ?? "",
        version: r.version ?? "",
        releasedAt: r.currentVersionReleaseDate,
        notes: (r.releaseNotes ?? "").trim(),
        icon: r.artworkUrl100 ?? r.artworkUrl60 ?? "",
        url: r.trackViewUrl ?? `https://apps.apple.com/app/id${r.trackId}`,
        genre: r.primaryGenreName ?? "",
      });
    }
  }
  return apps;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function getUpdates(): Promise<UpdatesResult> {
  const ids = await chartIds();
  const apps = await lookup(ids);

  const seen = new Set<number>();
  const updates = apps
    .filter((a) => !seen.has(a.id) && seen.add(a.id))
    .sort((a, b) => Date.parse(b.releasedAt) - Date.parse(a.releasedAt));

  return { updates, checkedAt: new Date().toISOString(), appsScanned: ids.length };
}
