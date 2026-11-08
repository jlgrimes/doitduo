// Which App Store apps work with iPhone Duo, and since when.
//
// 1. Pool: a few thousand popular apps (top charts, overall and per category).
// 2. Only apps updated since Oct 5, 2026 (when Apple opened iPhone Duo
//    submissions) can have shipped Duo support.
// 3. Release notes that mention Duo (current version, plus version history from
//    the App Store page) are judged by Jev: does this version support iPhone Duo?
// 4. News/blog articles about apps adding Duo support are judged by Jev, the
//    apps they name are matched to App Store listings, and Jev confirms each match.
// 5. Evidence is combined into a confidence score; the timestamp is the release
//    time of the first version whose notes announce Duo support (or the first
//    article, if the notes never say so).

import { unstable_cache } from "next/cache";
import { getAppPool, getRecentVersions, searchApps, type App, type VersionEntry } from "./apple";
import { getCandidateArticles, type Article } from "./articles";
import {
  confirmListing,
  extractArticleApps,
  judgeArticle,
  judgeReleaseNotes,
  MENTIONS_DUO,
  pool,
  SUPPORT_LEVEL_KEYS,
  type DuoJudgment,
  type SupportLevel,
} from "./classify";
import type { SourceKind } from "./sources";

export const DUO_SUBMISSIONS_OPENED = "2026-10-05T00:00:00Z";
const HISTORY_TIME_BUDGET_MS = 120_000; // per refresh; the rest is picked up next time
const MAX_APP_SEARCHES = 40;

export type Level = "high" | "medium" | "low";

export type Evidence =
  | {
      kind: "release-notes";
      version: string;
      at: string;
      quote: string;
      p: number;
      pSupport: number;
      level: SupportLevel;
      escalated: boolean;
    }
  | {
      kind: "news";
      title: string;
      url: string;
      source: string;
      sourceKind: SourceKind;
      at: string;
      p: number;
      pSupport: number;
      pSameApp: number;
      level: SupportLevel;
      escalated: boolean;
    };

export type DuoApp = {
  id: number;
  name: string;
  developer: string;
  genre: string;
  icon: string;
  url: string;
  currentVersion: string;
  /** When Duo support shipped: release time of the first Duo version, else the first report. */
  duoSince: string;
  /** First version whose release notes announce Duo support, if any. */
  duoVersion: string | null;
  level: SupportLevel;
  confidence: number; // 0–100
  tier: Level;
  evidence: Evidence[];
};

export type DuoFeed = {
  apps: DuoApp[];
  checkedAt: string;
  stats: {
    appsInPool: number;
    appsEligible: number;
    historiesScanned: number;
    notesJudged: number;
    articlesJudged: number;
    escalated: number;
    aiFailed: number;
    feedsOk: number;
  };
};

// ---------- helpers ----------

export function normalizeName(s: string) {
  return s
    .toLowerCase()
    .split(/\s[-–—:|]\s|:\s/)[0]
    .replace(/\sby\s.+$/, "")
    .replace(/[^a-z0-9+ ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The store name may extend the news name ("Canva" -> "Canva AI Photo..."), not the reverse. */
function namesMatch(storeName: string, appName: string) {
  const store = normalizeName(storeName);
  const app = normalizeName(appName);
  if (!store || !app) return false;
  return store === app || (app.length >= 4 && store.startsWith(app + " "));
}

const SOURCE_WEIGHT: Record<SourceKind, number> = { "first-party": 1, news: 0.9, aggregator: 0.75 };
const RELEASE_NOTES_WEIGHT = 0.97; // the developer's own statement

/** How strongly a judgment says "this app works with iPhone Duo now". */
const strength = (j: DuoJudgment) =>
  j.pSupport * (j.level.optimized + 0.7 * j.level.improved + 0.3 * j.level.fix_only);

const topLevel = (j: DuoJudgment) => SUPPORT_LEVEL_KEYS.reduce((a, b) => (j.level[b] > j.level[a] ? b : a));

/** The sentence of the notes that mentions Duo. */
function duoQuote(notes: string) {
  const sentences = notes.split(/(?<=[.!?])\s+|\n+/);
  const hit = sentences.find((s) => MENTIONS_DUO.test(s)) ?? notes;
  return hit.trim().slice(0, 220);
}

// ---------- pipeline ----------

async function buildFeed(): Promise<DuoFeed> {
  const started = Date.now();
  const [apps, { articles, feedsOk }] = await Promise.all([getAppPool(), getCandidateArticles()]);
  const byId = new Map(apps.map((a) => [a.id, a]));
  const eligible = apps
    .filter((a) => a.releasedAt >= DUO_SUBMISSIONS_OPENED)
    .sort((a, b) => Date.parse(b.releasedAt) - Date.parse(a.releasedAt));

  // Release notes that mention Duo, keyed app+version.
  const noteCandidates = new Map<string, { app: App; entry: VersionEntry }>();
  const addNotes = (app: App, entry: VersionEntry) => {
    if (entry.releasedAt >= DUO_SUBMISSIONS_OPENED && MENTIONS_DUO.test(entry.notes))
      noteCandidates.set(`${app.id}@${entry.version}`, { app, entry });
  };
  for (const app of eligible) addNotes(app, { version: app.version, releasedAt: app.releasedAt, notes: app.notes });

  // Version history: catches apps that announced Duo support in an earlier
  // version. Cached per app version, so after warm-up only apps that shipped
  // a new version are re-fetched.
  let historiesScanned = 0;
  const historyDeadline = started + HISTORY_TIME_BUDGET_MS;
  const scanHistory = async (app: App) => {
    if (Date.now() > historyDeadline) return;
    const versions = await getRecentVersions(app, DUO_SUBMISSIONS_OPENED);
    historiesScanned++;
    for (const v of versions) addNotes(app, v);
  };
  await pool(eligible, 12, scanHistory);

  // News: which articles report Duo support, and for which apps.
  const judgedArticles = await pool(articles, 10, async (a) => ({ a, j: await judgeArticle(a) }));
  const reporting = judgedArticles.results.filter((r): r is { a: Article; j: DuoJudgment } => !!r && strength(r.j) >= 0.3);
  const named = await pool(reporting, 8, async ({ a, j }) => ({ a, j, apps: await extractArticleApps(a) }));

  const newsHits: { a: Article; j: DuoJudgment; app: string; company: string }[] = [];
  for (const r of named.results) if (r) for (const x of r.apps) newsHits.push({ a: r.a, j: r.j, app: x.app, company: x.company });

  // Match named apps to App Store listings (pool first, then search), then have Jev confirm.
  const listingFor = new Map<string, App | null>();
  const toSearch: string[] = [];
  for (const name of new Set(newsHits.map((h) => h.app))) {
    const hit = apps.find((u) => namesMatch(u.name, name));
    if (hit) listingFor.set(name, hit);
    else toSearch.push(name);
  }
  await pool(toSearch.slice(0, MAX_APP_SEARCHES), 4, async (name) => {
    const found = await searchApps(name);
    const hit = found.find((u) => namesMatch(u.name, name)) ?? null;
    listingFor.set(name, hit);
    if (hit && !byId.has(hit.id)) byId.set(hit.id, hit);
  });

  const newsEvidence = new Map<number, Evidence[]>();
  const confirmed = await pool(newsHits, 8, async (h) => {
    const listing = listingFor.get(h.app);
    if (!listing) return null;
    const pSameApp = await confirmListing({ app: h.app, company: h.company, headline: h.a.title }, listing);
    return { h, listing, pSameApp };
  });
  for (const c of confirmed.results) {
    if (!c || c.pSameApp < 0.5) continue;
    const { h, listing, pSameApp } = c;
    const ev: Evidence = {
      kind: "news",
      title: h.a.title,
      url: h.a.url,
      source: h.a.source,
      sourceKind: h.a.sourceKind,
      at: h.a.publishedAt,
      p: strength(h.j) * SOURCE_WEIGHT[h.a.sourceKind] * pSameApp,
      pSupport: h.j.pSupport,
      pSameApp,
      level: topLevel(h.j),
      escalated: h.j.escalated,
    };
    const list = newsEvidence.get(listing.id) ?? [];
    if (!list.some((e) => e.kind === "news" && e.url === ev.url)) list.push(ev);
    newsEvidence.set(listing.id, list);
  }

  // Apps found through news but outside the pool: check their history too.
  await pool(
    [...newsEvidence.keys()].map((id) => byId.get(id)!).filter((a) => a && !eligible.includes(a)),
    6,
    async (app) => {
      addNotes(app, { version: app.version, releasedAt: app.releasedAt, notes: app.notes });
      for (const v of await getRecentVersions(app, DUO_SUBMISSIONS_OPENED)) addNotes(app, v);
    },
  );

  // Jev reads every release note that mentions Duo.
  const judgedNotes = await pool([...noteCandidates.values()], 10, async ({ app, entry }) => ({
    app,
    entry,
    j: await judgeReleaseNotes(app, entry),
  }));

  const notesEvidence = new Map<number, Evidence[]>();
  for (const r of judgedNotes.results) {
    if (!r) continue;
    const list = notesEvidence.get(r.app.id) ?? [];
    list.push({
      kind: "release-notes",
      version: r.entry.version,
      at: r.entry.releasedAt,
      quote: duoQuote(r.entry.notes),
      p: strength(r.j) * RELEASE_NOTES_WEIGHT,
      pSupport: r.j.pSupport,
      level: topLevel(r.j),
      escalated: r.j.escalated,
    });
    notesEvidence.set(r.app.id, list);
  }

  // Combine per app.
  const duoApps: DuoApp[] = [];
  for (const id of new Set([...notesEvidence.keys(), ...newsEvidence.keys()])) {
    const app = byId.get(id);
    if (!app) continue;
    const evidence = [...(notesEvidence.get(id) ?? []), ...(newsEvidence.get(id) ?? [])].sort(
      (a, b) => Date.parse(a.at) - Date.parse(b.at),
    );
    // Independent sources: best evidence per publisher; release notes count once.
    const best = new Map<string, number>();
    for (const e of evidence) {
      const k = e.kind === "news" ? `news:${e.source.toLowerCase()}` : "notes";
      best.set(k, Math.max(best.get(k) ?? 0, e.p));
    }
    const confidence = Math.round((1 - [...best.values()].reduce((d, p) => d * (1 - p), 1)) * 100);
    if (confidence < 10) continue; // e.g. only Duolingo-owl mentions

    const firstNotes = evidence.find((e) => e.kind === "release-notes" && e.p >= 0.5);
    const firstAny = evidence.find((e) => e.p >= 0.5) ?? evidence.reduce((a, b) => (b.p > a.p ? b : a));
    const since = firstNotes ?? firstAny;
    const strongest = evidence.reduce((a, b) => (b.p > a.p ? b : a));

    duoApps.push({
      id,
      name: app.name,
      developer: app.developer,
      genre: app.genre,
      icon: app.icon,
      url: app.url,
      currentVersion: app.version,
      duoSince: since.at,
      duoVersion: firstNotes?.kind === "release-notes" ? firstNotes.version : null,
      level: strongest.level,
      confidence,
      tier: confidence >= 75 ? "high" : confidence >= 50 ? "medium" : "low",
      evidence,
    });
  }
  duoApps.sort((a, b) => Date.parse(b.duoSince) - Date.parse(a.duoSince));

  const failed = judgedNotes.failed + judgedArticles.failed + named.failed + confirmed.failed;
  const firstError = judgedNotes.firstError ?? judgedArticles.firstError ?? named.firstError ?? confirmed.firstError;
  if (failed) console.error(`AI step failed ${failed} times. First error: ${firstError}`);

  return {
    apps: duoApps,
    checkedAt: new Date().toISOString(),
    stats: {
      appsInPool: apps.length,
      appsEligible: eligible.length,
      historiesScanned,
      notesJudged: judgedNotes.results.filter(Boolean).length,
      articlesJudged: judgedArticles.results.filter(Boolean).length,
      escalated:
        judgedNotes.results.filter((r) => r?.j.escalated).length +
        judgedArticles.results.filter((r) => r?.j.escalated).length,
      aiFailed: failed,
      feedsOk,
    },
  };
}

export const getFeed = unstable_cache(buildFeed, ["duo-feed", "v1"], { revalidate: 1800 });
