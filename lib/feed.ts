// Builds the feed: articles -> AI classification -> grouped per app ->
// App Store cross-check -> confidence score.

import { unstable_cache } from "next/cache";
import { getUpdates, searchApps, type AppUpdate } from "./apple";
import { getCandidateArticles, type Article } from "./articles";
import { classifyAll, type Classification } from "./classify";
import type { SourceKind } from "./sources";

export type Signal = { label: string; points: number };
export type Level = "high" | "medium" | "low";

export type FeedItem = {
  key: string;
  kind: "reported" | "appstore";
  app: string;
  company: string;
  summary: string;
  version: string;
  status: Classification["status"] | "app_store";
  platforms: string[];
  /** Sort/display time: when the update was first reported, or App Store release time. */
  time: string;
  firstReportedAt: string | null;
  appStore: Pick<AppUpdate, "name" | "version" | "releasedAt" | "url" | "icon" | "notes"> | null;
  articles: Pick<Article, "title" | "url" | "source" | "sourceKind" | "publishedAt">[];
  confidence: number; // 0–100
  level: Level;
  signals: Signal[];
};

export type Feed = {
  items: FeedItem[];
  checkedAt: string;
  stats: {
    feedsOk: number;
    feedsFailed: string[];
    articlesScanned: number;
    articlesClassified: number;
    aiFailed: number;
    appsTracked: number;
  };
};

const DAY = 864e5;
const CLUSTER_GAP = 3 * DAY;
const APPSTORE_WINDOW = 7 * DAY;
const MAX_APP_SEARCHES = 30;

// ---------- name matching ----------

export function normalizeName(s: string) {
  return s
    .toLowerCase()
    .split(/\s[-–—:|]\s|:\s/)[0]
    .replace(/\sby\s.+$/, "")
    .replace(/[^a-z0-9+ ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function namesMatch(a: string, b: string) {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.startsWith(short + " ");
}

// ---------- scoring ----------

const STATUS_POINTS: Record<Classification["status"], [number, string]> = {
  shipped: [15, "Says it's available now"],
  rolling_out: [10, "Says it's rolling out"],
  beta: [-5, "Beta / test build only"],
  announced: [-10, "Announced, not shipped yet"],
  rumor: [-25, "Rumor or leak"],
  not_an_update: [-40, "Not an update"],
};
const STATUS_RANK = ["shipped", "rolling_out", "beta", "announced", "rumor", "not_an_update"] as const;

const level = (c: number): Level => (c >= 75 ? "high" : c >= 50 ? "medium" : "low");
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

type Tagged = { article: Article; c: Classification };

function score(group: Tagged[], appStoreHit: boolean, appStore: AppUpdate | null) {
  const signals: Signal[] = [];
  const maxConf = Math.max(...group.map((g) => g.c.confidence));
  signals.push({ label: `AI read: ${Math.round(maxConf * 100)}% sure it's a real update`, points: Math.round(maxConf * 50) });

  const best = STATUS_RANK.find((s) => group.some((g) => g.c.status === s))!;
  const [sp, sl] = STATUS_POINTS[best];
  signals.push({ label: sl, points: sp });

  const kinds = new Set<SourceKind>(group.map((g) => g.article.sourceKind));
  if (kinds.has("first-party")) signals.push({ label: "From the company's own blog/changelog", points: 20 });
  else if (kinds.has("news")) signals.push({ label: "Reported by tech press", points: 5 });
  else signals.push({ label: "Only found via search/aggregators", points: 0 });

  const publishers = new Set(group.map((g) => g.article.source.toLowerCase()));
  if (publishers.size > 1)
    signals.push({ label: `${publishers.size} independent sources`, points: Math.min(16, (publishers.size - 1) * 8) });

  if (appStoreHit && appStore)
    signals.push({ label: `App Store shows a new version (v${appStore.version}) around the same time`, points: 20 });

  const confidence = clamp(signals.reduce((s, x) => s + x.points, 0));
  return { signals, confidence, status: best };
}

// ---------- pipeline ----------

async function buildFeed(): Promise<Feed> {
  const [{ articles, feedsOk, feedsFailed }, chart] = await Promise.all([
    getCandidateArticles(),
    getUpdates().catch(() => ({ updates: [] as AppUpdate[], appsScanned: 0 })),
  ]);

  const { results, failed } = await classifyAll(articles);

  const tagged: Tagged[] = articles
    .map((article) => ({ article, c: results.get(article.id)! }))
    .filter((t) => t.c && t.c.isAppUpdate && t.c.app.trim() && t.c.status !== "not_an_update");

  // Group by app, then split into separate updates when reports are > 3 days apart.
  const byApp = new Map<string, Tagged[]>();
  for (const t of tagged) {
    const k = normalizeName(t.c.app);
    if (!k) continue;
    if (!byApp.has(k)) byApp.set(k, []);
    byApp.get(k)!.push(t);
  }
  const groups: Tagged[][] = [];
  for (const list of byApp.values()) {
    list.sort((a, b) => Date.parse(a.article.publishedAt) - Date.parse(b.article.publishedAt));
    let cur: Tagged[] = [];
    for (const t of list) {
      const last = cur.at(-1);
      if (last && Date.parse(t.article.publishedAt) - Date.parse(last.article.publishedAt) > CLUSTER_GAP) {
        groups.push(cur);
        cur = [];
      }
      cur.push(t);
    }
    if (cur.length) groups.push(cur);
  }

  // App Store lookup per app: chart pool first, then search (capped).
  const appNames = [...new Set(groups.map((g) => g[0].c.app))];
  const storeMatch = new Map<string, AppUpdate | null>();
  const toSearch: string[] = [];
  for (const name of appNames) {
    const hit = chart.updates.find((u) => namesMatch(u.name, name));
    if (hit) storeMatch.set(name, hit);
    else toSearch.push(name);
  }
  let si = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (si < Math.min(toSearch.length, MAX_APP_SEARCHES)) {
        const name = toSearch[si++];
        try {
          const found = await searchApps(name);
          storeMatch.set(name, found.find((u) => namesMatch(u.name, name)) ?? null);
        } catch {
          storeMatch.set(name, null);
        }
      }
    }),
  );

  const matchedStoreIds = new Set<number>();
  const reported: FeedItem[] = groups.map((group) => {
    const first = group[0];
    const firstAt = Date.parse(first.article.publishedAt);
    const store = storeMatch.get(first.c.app) ?? null;
    const rel = store ? Date.parse(store.releasedAt) : NaN;
    // New App Store version within 5 days before / 3 days after first report
    const appStoreHit = !!store && rel >= firstAt - 5 * DAY && rel <= firstAt + 3 * DAY;
    if (store && appStoreHit) matchedStoreIds.add(store.id);

    const { signals, confidence, status } = score(group, appStoreHit, store);
    const lead =
      group.find((g) => g.article.sourceKind === "first-party") ??
      [...group].sort((a, b) => b.c.confidence - a.c.confidence)[0];

    return {
      key: `r:${normalizeName(first.c.app)}:${first.article.id}`,
      kind: "reported",
      app: lead.c.app,
      company: lead.c.company,
      summary: lead.c.summary,
      version: group.map((g) => g.c.version).find(Boolean) ?? (appStoreHit ? store!.version : ""),
      status,
      platforms: [...new Set(group.flatMap((g) => g.c.platforms))],
      time: first.article.publishedAt,
      firstReportedAt: first.article.publishedAt,
      appStore: store
        ? { name: store.name, version: store.version, releasedAt: store.releasedAt, url: store.url, icon: store.icon, notes: store.notes }
        : null,
      articles: [...group]
        .sort((a, b) => Date.parse(a.article.publishedAt) - Date.parse(b.article.publishedAt))
        .map(({ article: a }) => ({ title: a.title, url: a.url, source: a.source, sourceKind: a.sourceKind, publishedAt: a.publishedAt })),
      confidence,
      level: level(confidence),
      signals,
    };
  });

  // App Store-only updates (no articles), straight from Apple.
  const now = Date.now();
  const storeOnly: FeedItem[] = chart.updates
    .filter((u) => !matchedStoreIds.has(u.id) && now - Date.parse(u.releasedAt) <= APPSTORE_WINDOW)
    .map((u) => ({
      key: `a:${u.id}`,
      kind: "appstore",
      app: u.name,
      company: u.developer,
      summary: u.notes.split("\n").find((l) => l.trim())?.trim().slice(0, 140) ?? "",
      version: u.version,
      status: "app_store",
      platforms: ["ios"],
      time: u.releasedAt,
      firstReportedAt: null,
      appStore: { name: u.name, version: u.version, releasedAt: u.releasedAt, url: u.url, icon: u.icon, notes: u.notes },
      articles: [],
      confidence: 95,
      level: "high",
      signals: [{ label: "Version and release time come straight from Apple's App Store", points: 95 }],
    }));

  const items = [...reported, ...storeOnly].sort((a, b) => Date.parse(b.time) - Date.parse(a.time));

  return {
    items,
    checkedAt: new Date().toISOString(),
    stats: {
      feedsOk,
      feedsFailed,
      articlesScanned: articles.length,
      articlesClassified: results.size,
      aiFailed: failed,
      appsTracked: chart.appsScanned,
    },
  };
}

export const getFeed = unstable_cache(buildFeed, ["feed", "v1"], { revalidate: 1800 });
