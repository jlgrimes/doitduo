import { XMLParser } from "fast-xml-parser";
import { SOURCES, type SourceKind } from "./sources";

export type Article = {
  id: string; // canonical URL
  title: string;
  url: string;
  source: string; // publication name
  sourceKind: SourceKind;
  publishedAt: string; // ISO
  snippet: string;
};

const SINCE = Date.parse("2026-09-01T00:00:00Z"); // iPhone Duo coverage starts here
const MAX_CANDIDATES = 150; // caps AI cost per refresh

// Cheap pre-filter before the AI looks at anything: must mention iPhone Duo.
const DUO_WORDS = /iphone\s?duo|\bduo\b.{0,60}\b(app|apps|support|optimi[sz]ed|inner (display|screen)|unfold)/i;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  htmlEntities: true,
});

/* eslint-disable @typescript-eslint/no-explicit-any */
const text = (v: any): string =>
  v == null ? "" : typeof v === "object" ? text(v["#text"]) : String(v);

const arr = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

function clean(html: string) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&(amp|lt|gt|quot|#39|apos);/g, (m) =>
      ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'" })[m]!,
    )
    .replace(/\s+/g, " ")
    .trim();
}

function atomLink(link: any): string {
  const links = arr(link);
  const alt = links.find((l: any) => !l?.["@_rel"] || l["@_rel"] === "alternate") ?? links[0];
  return typeof alt === "string" ? alt : alt?.["@_href"] ?? "";
}

function parseFeed(xml: string, fallbackSource: string, kind: SourceKind): Article[] {
  const doc = parser.parse(xml);
  const rssItems = arr(doc?.rss?.channel?.item);
  const atomItems = arr(doc?.feed?.entry);

  const raw = rssItems.length
    ? rssItems.map((i: any) => ({
        title: text(i.title),
        url: text(i.link) || text(i.guid),
        date: text(i.pubDate) || text(i["dc:date"]),
        snippet: text(i.description) || text(i["content:encoded"]),
        source: text(i.source) || fallbackSource,
      }))
    : atomItems.map((e: any) => ({
        title: text(e.title),
        url: atomLink(e.link),
        date: text(e.published) || text(e.updated),
        snippet: text(e.summary) || text(e.content),
        source: fallbackSource,
      }));

  return raw.flatMap((r) => {
    const t = Date.parse(r.date);
    if (!r.title || !r.url || Number.isNaN(t)) return [];
    let title = clean(r.title);
    // Google News titles look like "Headline - Publisher"
    if (fallbackSource === "Google News" && r.source !== fallbackSource)
      title = title.replace(new RegExp(`\\s+-\\s+${r.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "");
    return [
      {
        id: r.url.split("#")[0],
        title,
        url: r.url,
        source: r.source,
        sourceKind: kind,
        publishedAt: new Date(t).toISOString(),
        snippet: clean(r.snippet).slice(0, 700),
      },
    ];
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function getCandidateArticles(): Promise<{
  articles: Article[];
  feedsOk: number;
  feedsFailed: string[];
}> {
  const results = await Promise.allSettled(
    SOURCES.map(async (s) => {
      const res = await fetch(s.url, {
        next: { revalidate: 1800 },
        signal: AbortSignal.timeout(10_000),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; doitduo-app-updates/1.0)" },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      return parseFeed(await res.text(), s.name, s.kind);
    }),
  );

  const feedsFailed: string[] = [];
  const seen = new Set<string>();
  const seenTitles = new Set<string>();
  const articles: Article[] = [];

  results.forEach((r, i) => {
    if (r.status === "rejected") {
      feedsFailed.push(SOURCES[i].name);
      console.warn(`feed failed: ${SOURCES[i].name} (${SOURCES[i].url}):`, r.reason?.message ?? r.reason);
      return;
    }
    for (const a of r.value) {
      const titleKey = a.title.toLowerCase().replace(/\W+/g, " ").trim();
      if (seen.has(a.id) || seenTitles.has(titleKey)) continue;
      if (Date.parse(a.publishedAt) < SINCE) continue;
      if (!DUO_WORDS.test(`${a.title} ${a.snippet}`)) continue;
      seen.add(a.id);
      seenTitles.add(titleKey);
      articles.push(a);
    }
  });

  articles.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  return {
    articles: articles.slice(0, MAX_CANDIDATES),
    feedsOk: SOURCES.length - feedsFailed.length,
    feedsFailed,
  };
}
