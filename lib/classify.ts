// AI step: reads each candidate article (via Vercel AI Gateway) and decides
// whether it reports a real app update, which app, and how sure it is.
// Results are cached per article, so each article is only classified once.

import { generateText, Output } from "ai";
import { unstable_cache } from "next/cache";
import { z } from "zod";
import type { Article } from "./articles";

// Any AI Gateway model ID works here. On Vercel, auth is automatic (OIDC);
// locally, set AI_GATEWAY_API_KEY.
const MODEL = process.env.AI_MODEL ?? "anthropic/claude-haiku-5.5";
const FALLBACK_MODELS = ["anthropic/claude-sonnet-5.5"];
const PROMPT_VERSION = "v1"; // bump to re-classify everything

export const Classification = z.object({
  isAppUpdate: z
    .boolean()
    .describe(
      "True only if the article reports that a specific app or software product shipped, or is rolling out, a new version or user-facing feature.",
    ),
  status: z
    .enum(["shipped", "rolling_out", "announced", "beta", "rumor", "not_an_update"])
    .describe("shipped = available now; rolling_out = gradually reaching users; announced = coming later; beta = test builds only; rumor = leaks/reports/code findings."),
  app: z.string().describe("Canonical app/product name, e.g. 'WhatsApp', 'ChatGPT', 'Google Maps'. Empty if none."),
  company: z.string().describe("Company that makes the app. Empty if unknown."),
  platforms: z.array(z.enum(["ios", "android", "web", "mac", "windows", "linux", "other"])),
  version: z.string().describe("Version number if stated, else empty."),
  summary: z.string().describe("What changed, in at most 110 characters. Plain, specific, no hype."),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("How confident you are that this is a real, user-facing app update that has shipped or is rolling out."),
});

export type Classification = z.infer<typeof Classification>;

async function classifyUncached(a: Pick<Article, "title" | "source" | "publishedAt" | "snippet" | "url">) {
  const { output } = await generateText({
    model: MODEL,
    output: Output.object({ schema: Classification }),
    providerOptions: { gateway: { models: FALLBACK_MODELS } },
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(30_000),
    system:
      "You triage tech news for a feed of app updates. Be strict: hardware, OS-wide policy, company news, funding, reviews, deals, how-tos and opinion pieces are not app updates. Leaks, code teardowns and 'reportedly working on' stories are rumors. Base everything only on the given text.",
    prompt: [
      `Title: ${a.title}`,
      `Publisher: ${a.source}`,
      `Published: ${a.publishedAt}`,
      `URL: ${a.url}`,
      `Excerpt: ${a.snippet || "(none)"}`,
    ].join("\n"),
  });
  return output;
}

export function classify(a: Article): Promise<Classification> {
  return unstable_cache(() => classifyUncached(a), ["classify", PROMPT_VERSION, MODEL, a.id], {
    revalidate: 14 * 864e5 / 1000,
  })();
}

/** Classify many articles with limited concurrency; failures are dropped. */
export async function classifyAll(articles: Article[], concurrency = 10) {
  const out = new Map<string, Classification>();
  let failed = 0;
  let firstError: string | undefined;
  let i = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (i < articles.length) {
        const a = articles[i++];
        try {
          out.set(a.id, await classify(a));
        } catch (e) {
          failed++;
          firstError ??= e instanceof Error ? e.message : String(e);
        }
      }
    }),
  );
  if (failed) console.error(`AI classification failed for ${failed}/${articles.length} articles. First error: ${firstError}`);
  return { results: out, failed };
}
