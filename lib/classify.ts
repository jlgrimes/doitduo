// AI layer, all through Vercel AI Gateway (OIDC auth on Vercel, or
// AI_GATEWAY_API_KEY locally):
//
// 1. Jev (TypeSafe AI's decision model, `typesafe-ai/jev`) answers typed
//    questions about every article and returns real probabilities: is this an
//    app update, and what's its release status. When Jev is unsure, AI Gateway
//    automatically re-asks a stronger model (conditional decision fallback).
// 2. A small language model extracts the app name, version and a one-line
//    summary, only for articles Jev thinks are plausibly updates.
//
// Both results are cached per article, so each article is processed once.

import type { GatewayProviderOptions } from "@ai-sdk/gateway";
import { experimental_decide as decide, generateText, Output } from "ai";
import { unstable_cache } from "next/cache";
import { z } from "zod";
import type { Article } from "./articles";

export const DECISION_MODEL = process.env.DECISION_MODEL ?? "typesafe-ai/jev";
export const ESCALATION_MODEL = "anthropic/claude-sonnet-5.5";
const EXTRACT_MODEL = process.env.AI_MODEL ?? "anthropic/claude-haiku-5.5";
const JUDGE_VERSION = "jev-v1"; // bump to re-run Jev on everything
const EXTRACT_VERSION = "x-v2"; // bump to re-run extraction
const CACHE_SECONDS = 14 * 86400;
const MIN_P_UPDATE = 0.3; // below this we don't bother extracting

// ---------- 1. Jev decisions ----------

const STATUS_CRITERIA = {
  shipped: "Available to users now",
  rolling_out: "Gradually reaching users now",
  beta: "Only in beta, preview or test builds",
  announced: "Announced, but coming later",
  rumor: "A leak, code teardown, or 'reportedly working on' story",
  not_an_update: "Not about an app or software update at all",
} as const;

export type Status = keyof typeof STATUS_CRITERIA;
export const STATUSES = Object.keys(STATUS_CRITERIA) as Status[];

const QUESTIONS = {
  isAppUpdate: {
    type: "boolean",
    instructions:
      "Does this article report a new version, feature, or change to a specific app or software product that users can get or will get?",
    criteria: {
      true: "A specific app or software product gained a new version or user-facing feature (shipped, rolling out, in beta, announced or rumored).",
      false: "Hardware, company or business news, funding, policy, reviews, deals, how-tos, opinion, or anything not about a software update.",
    },
  },
  status: {
    type: "choice",
    instructions: "What is the release status of the update the article describes?",
    criteria: STATUS_CRITERIA,
  },
} as const;

export type Judgment = {
  pUpdate: number; // P(article reports an app update)
  status: Record<Status, number>; // probability per status
  model: string; // which model produced the answers
  escalated: boolean; // Jev was unsure, so a stronger model re-decided
};

async function judgeUncached(a: Article): Promise<Judgment> {
  const result = await decide({
    model: DECISION_MODEL,
    state: {
      title: a.title,
      publisher: a.source,
      publisherType: a.sourceKind,
      publishedAt: a.publishedAt,
      url: a.url,
      excerpt: a.snippet,
    },
    questions: QUESTIONS,
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(30_000),
    providerOptions: {
      gateway: {
        models: [
          {
            // Jev is unsure -> have a stronger model decide instead.
            model: ESCALATION_MODEL,
            when: {
              any: [
                { question: "isAppUpdate", probabilityBetween: [0.35, 0.65] },
                { question: "status", confidenceBelow: 0.5 },
              ],
            },
          },
          ESCALATION_MODEL, // also used if Jev errors
        ],
      } satisfies GatewayProviderOptions<keyof typeof QUESTIONS>,
    },
  });

  const s = result.answers.status;
  // Language-model fallbacks may omit the distribution; treat their pick as certain.
  const status = Object.fromEntries(
    STATUSES.map((k) => [k, s.probabilities?.[k] ?? (s.choice === k ? 1 : 0)]),
  ) as Record<Status, number>;

  const model = result.response.modelId;
  return {
    pUpdate: result.answers.isAppUpdate.probability,
    status,
    model,
    escalated: !model.includes("jev"),
  };
}

// ---------- 2. Extraction ----------

const Extraction = z.object({
  app: z
    .string()
    .describe(
      "The app or product itself, not the feature: 'Claude' (not 'Claude Personal Finance'), 'WhatsApp' (not 'WhatsApp message translation'), 'GitHub Copilot' (not 'Copilot code review'), 'Google Maps'. Empty if none.",
    ),
  company: z.string().describe("Company that makes it. Empty if unknown."),
  platforms: z.array(z.enum(["ios", "android", "web", "mac", "windows", "linux", "other"])),
  version: z.string().describe("Version number if stated, else empty."),
  summary: z.string().describe("What changed, at most 110 characters. Plain and specific."),
});
export type Extraction = z.infer<typeof Extraction>;

async function extractUncached(a: Article): Promise<Extraction> {
  const { output } = await generateText({
    model: EXTRACT_MODEL,
    output: Output.object({ schema: Extraction }),
    providerOptions: { gateway: { models: [ESCALATION_MODEL] } },
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(30_000),
    system: "Extract which app the article is about and what changed. Use only the given text.",
    prompt: `Title: ${a.title}\nPublisher: ${a.source}\nExcerpt: ${a.snippet || "(none)"}`,
  });
  return output;
}

// ---------- caching + batching ----------

const cached = <T>(kind: string, version: string, a: Article, fn: () => Promise<T>) =>
  unstable_cache(fn, [kind, version, a.id], { revalidate: CACHE_SECONDS })();

export type Classified = { judgment: Judgment; extraction: Extraction | null };

export async function classifyAll(articles: Article[], concurrency = 10) {
  const out = new Map<string, Classified>();
  let failed = 0;
  let firstError: string | undefined;
  let i = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (i < articles.length) {
        const a = articles[i++];
        try {
          const judgment = await cached("judge", JUDGE_VERSION, a, () => judgeUncached(a));
          const extraction =
            judgment.pUpdate >= MIN_P_UPDATE ? await cached("extract", EXTRACT_VERSION, a, () => extractUncached(a)) : null;
          out.set(a.id, { judgment, extraction });
        } catch (e) {
          failed++;
          firstError ??= e instanceof Error ? e.message : String(e);
        }
      }
    }),
  );
  if (failed) console.error(`AI step failed for ${failed}/${articles.length} articles. First error: ${firstError}`);
  return { results: out, failed };
}
