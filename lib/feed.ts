// Builds the feed: articles -> Jev decisions + extraction -> grouped per app ->
// App Store cross-check -> confidence (a probability that the update is real
// and live).

import { unstable_cache } from "next/cache";
import { getUpdates, searchApps, type AppUpdate } from "./apple";
import { getCandidateArticles, type Article } from "./articles";
import { classifyAll, STATUSES, type Extraction, type Judgment, type Status } from "./classify";
import type { SourceKind } from "./sources";

export type Signal = { label: string; value: string; tone: "pos" | "neg" | "zero" };
export type Level = "high" | "medium" | "low";

export type FeedItem = {
  key: string;
  kind: "reported" | "appstore";
  app: string;
  company: string;
  summary: string;
  version: string;
  status: Status | "app_store";
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
    escalated: number;
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

/**
 * Does an App Store listing name refer to the app named in an article?
 * The store name may add words ("WhatsApp Messenger" for "WhatsApp"), but the
 * article's app may not ("GitHub Copilot code review" is not the "GitHub" app).
 */
function namesMatch(storeName: string, appName: string) {
  const store = normalizeName(storeName);
  const app = normalizeName(appName);
  if (!store || !app) return false;
  return store === app || (app.length >= 4 && store.startsWith(app + " "));
}

/** Only native-app platforms can be corroborated by the iOS App Store. */
const couldBeOnAppStore = (platforms: string[]) =>
  platforms.length === 0 || platforms.some((p) => p === "ios" || p === "other");

// ---------- confidence ----------
//
// For each article, Jev gives P(it reports an app update) and a probability
// for each release status. The article's evidence that a real update is live:
//
//   p = P(update) × (P(shipped) + P(rolling out) + ½·P(beta)) × source weight
//
// Articles from different publishers count as independent evidence and are
// combined with a noisy-OR: 1 − Π(1 − p). A matching App Store release then
// closes part of the remaining doubt.

const SOURCE_WEIGHT: Record<SourceKind, number> = { "first-party": 1, news: 0.9, aggregator: 0.75 };
const APPSTORE_WEIGHT = 0.6;

const pLive = (j: Judgment) => j.status.shipped + j.status.rolling_out + 0.5 * j.status.beta;
const pct = (p: number) => `${Math.round(p * 100)}%`;
const level = (c: number): Level => (c >= 75 ? "high" : c >= 50 ? "medium" : "low");

type Tagged = { article: Article; j: Judgment; x: Extraction };

/** The group's app name: the shortest one, i.e. the parent app after merging. */
const appNameOf = (group: Tagged[]) => group.map((t) => t.x.app).sort((a, b) => a.length - b.length)[0];

function score(group: Tagged[], appStoreHit: AppUpdate | null) {
  // Best evidence per publisher (reposts on one outlet aren't independent).
  const perPublisher = new Map<string, { t: Tagged; p: number }>();
  for (const t of group) {
    const p = t.j.pUpdate * pLive(t.j) * SOURCE_WEIGHT[t.article.sourceKind];
    const k = t.article.source.toLowerCase();
    if (!perPublisher.has(k) || perPublisher.get(k)!.p < p) perPublisher.set(k, { t, p });
  }
  const evidence = [...perPublisher.values()].sort((a, b) => b.p - a.p);

  let doubt = evidence.reduce((d, e) => d * (1 - e.p), 1);
  const fromArticles = 1 - doubt;

  const signals: Signal[] = evidence.slice(0, 5).map(({ t, p }) => ({
    label:
      `${t.article.source}${t.article.sourceKind === "first-party" ? " (official)" : ""}: ` +
      `Jev says ${pct(t.j.pUpdate)} an app update, ${pct(pLive(t.j))} live` +
      (t.j.escalated ? " · re-checked by Claude Sonnet" : ""),
    value: pct(p),
    tone: p >= 0.5 ? "pos" : p >= 0.2 ? "zero" : "neg",
  }));
  if (evidence.length > 5) signals.push({ label: `+${evidence.length - 5} more sources`, value: "", tone: "zero" });

  if (appStoreHit) {
    const maxUpdate = Math.max(...group.map((g) => g.j.pUpdate));
    const before = 1 - doubt;
    doubt *= 1 - APPSTORE_WEIGHT * maxUpdate;
    signals.push({
      label: `App Store shows v${appStoreHit.version} released around the same time`,
      value: `+${Math.round((1 - doubt - before) * 100)}`,
      tone: "pos",
    });
  }

  const confidence = Math.round((1 - doubt) * 100);
  if (evidence.length > 1)
    signals.push({ label: `Combined across ${evidence.length} independent sources`, value: pct(fromArticles), tone: "zero" });

  // Most likely status, weighting each article by its evidence.
  const totals = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  for (const t of group) for (const s of STATUSES) totals[s] += t.j.status[s] * t.j.pUpdate;
  const status = STATUSES.reduce((a, b) => (totals[b] > totals[a] ? b : a));

  return { signals, confidence, status };
}

// ---------- pipeline ----------

async function buildFeed(): Promise<Feed> {
  const [{ articles, feedsOk, feedsFailed }, chart] = await Promise.all([
    getCandidateArticles(),
    getUpdates().catch(() => ({ updates: [] as AppUpdate[], appsScanned: 0 })),
  ]);

  const { results, failed } = await classifyAll(articles);

  const tagged: Tagged[] = articles.flatMap((article) => {
    const r = results.get(article.id);
    if (!r?.extraction || !r.extraction.app.trim()) return [];
    return [{ article, j: r.judgment, x: r.extraction }];
  });

  // Group by app, then split into separate updates when reports are > 3 days apart.
  const byApp = new Map<string, Tagged[]>();
  for (const t of tagged) {
    const k = normalizeName(t.x.app);
    if (!k) continue;
    if (!byApp.has(k)) byApp.set(k, []);
    byApp.get(k)!.push(t);
  }
  // Merge feature-named apps into their parent from the same company
  // ("Claude Personal Finance" -> "Claude"). A parent named after the company
  // itself is skipped, so "Google Maps" doesn't fold into "Google", and so is
  // any name that is its own App Store app ("Apple Music Classical").
  const storeNames = new Set(chart.updates.map((u) => normalizeName(u.name)));
  const companyOf = (list: Tagged[]) =>
    normalizeName(list.find((t) => t.x.company)?.x.company ?? "").split(" ")[0] ?? "";
  for (const k of [...byApp.keys()].sort((a, b) => b.length - a.length)) {
    const co = companyOf(byApp.get(k)!);
    if (!co || storeNames.has(k)) continue;
    const parent = [...byApp.keys()]
      .filter((p) => p !== k && p.length >= 3 && k.startsWith(p + " ") && p !== co)
      .sort((a, b) => b.length - a.length)
      .find((p) => companyOf(byApp.get(p)!) === co);
    if (parent) {
      byApp.get(parent)!.push(...byApp.get(k)!);
      byApp.delete(k);
    }
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
  const appNames = [
    ...new Set(groups.filter((g) => couldBeOnAppStore(g.flatMap((t) => t.x.platforms))).map(appNameOf)),
  ];
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
    const appName = appNameOf(group);
    const store = storeMatch.get(appName) ?? null;
    const rel = store ? Date.parse(store.releasedAt) : NaN;
    // New App Store version within 5 days before / 3 days after the first report
    const appStoreHit = !!store && rel >= firstAt - 5 * DAY && rel <= firstAt + 3 * DAY;
    if (store && appStoreHit) matchedStoreIds.add(store.id);

    const { signals, confidence, status } = score(group, appStoreHit ? store : null);
    const lead =
      group.find((g) => g.article.sourceKind === "first-party") ??
      [...group].sort((a, b) => b.j.pUpdate * pLive(b.j) - a.j.pUpdate * pLive(a.j))[0];

    return {
      key: `r:${normalizeName(appName)}:${first.article.id}`,
      kind: "reported",
      app: appName,
      company: lead.x.company,
      summary: lead.x.summary,
      version: group.map((g) => g.x.version).find(Boolean) ?? (appStoreHit ? store!.version : ""),
      status,
      platforms: [...new Set(group.flatMap((g) => g.x.platforms))],
      time: first.article.publishedAt,
      firstReportedAt: first.article.publishedAt,
      appStore: store
        ? { name: store.name, version: store.version, releasedAt: store.releasedAt, url: store.url, icon: store.icon, notes: store.notes }
        : null,
      articles: group.map(({ article: a }) => ({
        title: a.title,
        url: a.url,
        source: a.source,
        sourceKind: a.sourceKind,
        publishedAt: a.publishedAt,
      })),
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
      confidence: 99,
      level: "high",
      signals: [{ label: "Version and release time come straight from Apple's App Store", value: "99%", tone: "pos" }],
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
      escalated: [...results.values()].filter((r) => r.judgment.escalated).length,
      aiFailed: failed,
      appsTracked: chart.appsScanned,
    },
  };
}

export const getFeed = unstable_cache(buildFeed, ["feed", "jev-v2"], { revalidate: 1800 });
