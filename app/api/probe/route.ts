// TEMPORARY: inspect how App Store data exposes iPhone Duo support. Removed after.
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15";
const snippets = (text: string, re: RegExp, n = 12, pad = 200) => {
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    out.push(text.slice(Math.max(0, m.index! - pad), m.index! + m[0].length + pad).replace(/\s+/g, " "));
    if (out.length >= n) break;
  }
  return out;
};

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const mode = sp.get("mode");

  if (mode === "chart") {
    // Correlate iPhoneDuo in supportedDevices with update date / min OS across chart apps.
    const feed = (await (await fetch("https://rss.marketingtools.apple.com/api/v2/us/apps/top-free/100/apps.json", { cache: "no-store" })).json()) as R;
    const ids = (feed.feed.results as R[]).map((r) => r.id).join(",");
    const lk = (await (await fetch(`https://itunes.apple.com/lookup?country=us&entity=software&id=${ids}`, { cache: "no-store" })).json()) as R;
    const rows = (lk.results as R[]).map((r) => ({
      name: String(r.trackName).slice(0, 28),
      duo: (r.supportedDevices as string[]).includes("iPhoneDuo-iPhoneDuo"),
      updated: r.currentVersionReleaseDate,
      minOS: r.minimumOsVersion,
      notesDuo: /duo/i.test(r.releaseNotes ?? "") ? String(r.releaseNotes).match(/.{0,80}duo.{0,80}/i)?.[0] : null,
      lastDevice: (r.supportedDevices as string[]).at(-1),
    }));
    return Response.json({
      total: rows.length,
      withDuo: rows.filter((r) => r.duo).length,
      withDuoUpdatedBeforeOct5: rows.filter((r) => r.duo && r.updated < "2026-10-05").length,
      withoutDuoUpdatedAfterOct5: rows.filter((r) => !r.duo && r.updated >= "2026-10-05").length,
      rows,
    });
  }

  const id = sp.get("id") ?? "";
  if (!/^\d{5,12}$/.test(id)) return Response.json({ error: "id" }, { status: 400 });
  const pageRes = await fetch(`https://apps.apple.com/us/app/id${id}`, { cache: "no-store", headers: { "User-Agent": UA, "Accept-Language": "en-US" } });
  const page = await pageRes.text();
  const m = page.match(/<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/);
  const data = m?.[1] ?? "";
  if (sp.get("vh")) {
    const json = JSON.parse(data.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    const found: R[] = [];
    const walk = (o: unknown, path: string) => {
      if (found.length >= 6 || !o || typeof o !== "object") return;
      const r = o as R;
      if (r.$kind === "TitledParagraph") {
        found.push({ path: path.slice(-160), keys: Object.keys(r), ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 120) : v])) });
      }
      for (const [k, v] of Object.entries(r)) walk(v, `${path}.${k}`);
    };
    walk(json, "");
    return Response.json({ count: found.length, found });
  }
  return Response.json({
    status: pageRes.status,
    duoAny: (page.match(/duo/gi) ?? []).length,
    duoSnippets: snippets(page, /duo/gi),
    serializedLen: data.length,
    screenshotKeys: [...new Set([...data.matchAll(/"(\w*[Ss]creenshot\w*|\w*[Dd]evice[Ff]amil\w*|mediaType|screenshotPlatform|platform)"\s*:\s*"?([^",{\[]{0,40})/g)].map((x) => `${x[1]}=${x[2]}`))].slice(0, 60),
    badgeLike: snippets(data, /badge|Made for|optimized/gi, 10, 150),
    versionHistorySample: snippets(data, /versionHistory/g, 2, 600),
  });
}
