// TEMPORARY: inspect how App Store data exposes iPhone Duo support. Removed after.
export const dynamic = "force-dynamic";

const snippets = (text: string, re: RegExp, n = 10, pad = 160) => {
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    out.push(text.slice(Math.max(0, m.index! - pad), m.index! + m[0].length + pad).replace(/\s+/g, " "));
    if (out.length >= n) break;
  }
  return out;
};

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^\d{5,12}$/.test(id)) return Response.json({ error: "id" }, { status: 400 });

  const lookupRes = await fetch(`https://itunes.apple.com/lookup?id=${id}&country=us&entity=software`, { cache: "no-store" });
  const lookup = (await lookupRes.json()) as { results?: Record<string, unknown>[] };
  const r = lookup.results?.[0] ?? {};
  const duoFields = Object.fromEntries(
    Object.entries(r).filter(([k, v]) => /duo|fold/i.test(k) || /duo|fold/i.test(JSON.stringify(v))),
  );

  const pageRes = await fetch(`https://apps.apple.com/us/app/id${id}`, {
    cache: "no-store",
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15", "Accept-Language": "en-US" },
    redirect: "follow",
  });
  const page = await pageRes.text();

  return Response.json({
    lookup: {
      keys: Object.keys(r),
      features: r.features,
      supportedDevicesDuo: (r.supportedDevices as string[] | undefined)?.filter((d) => /duo|fold/i.test(d)),
      supportedDevicesSample: (r.supportedDevices as string[] | undefined)?.slice(-8),
      screenshotKeys: Object.keys(r).filter((k) => /screenshot/i.test(k)).map((k) => [k, (r[k] as unknown[])?.length]),
      duoFields,
      version: r.version,
      currentVersionReleaseDate: r.currentVersionReleaseDate,
    },
    page: {
      status: pageRes.status,
      url: pageRes.url,
      length: page.length,
      duoCount: (page.match(/iPhone Duo/gi) ?? []).length,
      duoSnippets: snippets(page, /iPhone\s?Duo/gi),
      madeFor: snippets(page, /Made for/gi, 5),
      versionHistory: snippets(page, /versionHistory|Version History/g, 3, 400),
      scriptIds: [...page.matchAll(/<script[^>]*id="([^"]+)"/g)].map((m) => m[1]),
    },
  });
}
