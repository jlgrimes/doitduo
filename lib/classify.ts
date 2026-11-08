// AI layer, all through Vercel AI Gateway (OIDC auth on Vercel, or
// AI_GATEWAY_API_KEY locally).
//
// Jev (TypeSafe AI's decision model, `typesafe-ai/jev`) answers typed
// questions with real probabilities:
//   - Do these release notes say this version supports iPhone Duo?
//   - Does this article report that an app added iPhone Duo support?
//   - Is this App Store listing the app the article means?
// When Jev is unsure, AI Gateway re-asks a stronger model (conditional
// decision fallback). A small language model only pulls app names out of
// articles. Every result is cached, so each item is judged once.

import type { GatewayProviderOptions } from "@ai-sdk/gateway";
import { experimental_decide as decide, generateText, Output } from "ai";
import { unstable_cache } from "next/cache";
import { z } from "zod";
import type { App, VersionEntry } from "./apple";
import type { Article } from "./articles";

export const DECISION_MODEL = process.env.DECISION_MODEL ?? "typesafe-ai/jev";
export const ESCALATION_MODEL = "anthropic/claude-sonnet-5.5";
const EXTRACT_MODEL = process.env.AI_MODEL ?? "anthropic/claude-haiku-5.5";
const CACHE_SECONDS = 30 * 86400;

/** Cheap text filter: only text that passes this is sent to Jev. */
export const MENTIONS_DUO = /\bduo\b|\bunfold|\bfoldable\b|\binner (display|screen)\b/i;

const DUO_CONTEXT =
  "iPhone Duo is Apple's foldable iPhone (launched Oct 23, 2026) with an outer screen and a large inner display. Apps can be optimized for it, e.g. layouts that use the unfolded inner display. Every app technically runs on it, so only an explicit statement of support or optimization counts. Other things called Duo (Duolingo's owl, Google Duo, Duo Security, 'duo' meaning two people) are unrelated.";

const SUPPORT_LEVELS = {
  optimized: "The app now supports or is optimized for iPhone Duo (layouts for the inner display, unfolded mode, etc.)",
  improved: "Some iPhone Duo-specific improvements, but not described as full support",
  fix_only: "Only fixes a bug or crash on iPhone Duo",
  coming_later: "iPhone Duo support is planned or coming in a future version",
  unrelated: "Not about iPhone Duo",
} as const;
export type SupportLevel = keyof typeof SUPPORT_LEVELS;
export const SUPPORT_LEVEL_KEYS = Object.keys(SUPPORT_LEVELS) as SupportLevel[];

export type DuoJudgment = {
  pSupport: number; // P(the text says the app supports iPhone Duo now)
  level: Record<SupportLevel, number>;
  model: string;
  escalated: boolean;
};

// Escalate when Jev is unsure (probability near 0.5, or a low-confidence choice).
function escalation<Q extends string>(boolQ: Q, choiceQ: Q) {
  return {
    gateway: {
      models: [
        {
          model: ESCALATION_MODEL,
          when: {
            any: [
              { question: boolQ, probabilityBetween: [0.35, 0.65] },
              { question: choiceQ, confidenceBelow: 0.5 },
            ],
          },
        },
        ESCALATION_MODEL, // also used if Jev errors
      ],
    } satisfies GatewayProviderOptions<Q>,
  };
}

function toJudgment(
  p: number,
  choice: { choice: SupportLevel; probabilities?: Record<SupportLevel, number> },
  model: string,
): DuoJudgment {
  const level = Object.fromEntries(
    SUPPORT_LEVEL_KEYS.map((k) => [k, choice.probabilities?.[k] ?? (choice.choice === k ? 1 : 0)]),
  ) as Record<SupportLevel, number>;
  return { pSupport: p, level, model, escalated: !model.includes("jev") };
}

// ---------- release notes ----------

const NOTES_QUESTIONS = {
  supportsDuo: {
    type: "boolean",
    instructions: `Do these release notes say that this version of the app supports, or is optimized for, iPhone Duo? ${DUO_CONTEXT}`,
  },
  level: {
    type: "choice",
    instructions: "What do the release notes say about iPhone Duo?",
    criteria: SUPPORT_LEVELS,
  },
} as const;

/** Jev's read of one version's release notes. Cached per app version. */
export function judgeReleaseNotes(app: App, entry: VersionEntry): Promise<DuoJudgment> {
  return unstable_cache(
    async () => {
      const r = await decide({
        model: DECISION_MODEL,
        state: {
          app: app.name,
          developer: app.developer,
          version: entry.version,
          releasedAt: entry.releasedAt,
          releaseNotes: entry.notes.slice(0, 4000),
        },
        questions: NOTES_QUESTIONS,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(30_000),
        providerOptions: escalation<keyof typeof NOTES_QUESTIONS>("supportsDuo", "level"),
      });
      return toJudgment(r.answers.supportsDuo.probability, r.answers.level, r.response.modelId);
    },
    ["notes-duo", "v1", String(app.id), entry.version],
    { revalidate: CACHE_SECONDS },
  )();
}

// ---------- articles ----------

const ARTICLE_QUESTIONS = {
  reportsSupport: {
    type: "boolean",
    instructions: `Does this article report that one or more specific apps now support, or have been optimized for, iPhone Duo? ${DUO_CONTEXT}`,
  },
  level: {
    type: "choice",
    instructions: "What does the article say about the apps' iPhone Duo support?",
    criteria: SUPPORT_LEVELS,
  },
} as const;

export function judgeArticle(a: Article): Promise<DuoJudgment> {
  return unstable_cache(
    async () => {
      const r = await decide({
        model: DECISION_MODEL,
        state: { title: a.title, publisher: a.source, publisherType: a.sourceKind, publishedAt: a.publishedAt, excerpt: a.snippet },
        questions: ARTICLE_QUESTIONS,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(30_000),
        providerOptions: escalation<keyof typeof ARTICLE_QUESTIONS>("reportsSupport", "level"),
      });
      return toJudgment(r.answers.reportsSupport.probability, r.answers.level, r.response.modelId);
    },
    ["article-duo", "v1", a.id],
    { revalidate: CACHE_SECONDS },
  )();
}

const ArticleApps = z.object({
  apps: z
    .array(
      z.object({
        app: z.string().describe("The App Store app's name, e.g. 'Netflix', 'Canva', 'YouTube'"),
        company: z.string().describe("Company that makes it, or empty"),
      }),
    )
    .max(25)
    .describe("Apps the article says support or were optimized for iPhone Duo. Empty if none."),
});

/** Which apps an article says support iPhone Duo. */
export function extractArticleApps(a: Article): Promise<z.infer<typeof ArticleApps>["apps"]> {
  return unstable_cache(
    async () => {
      const { output } = await generateText({
        model: EXTRACT_MODEL,
        output: Output.object({ schema: ArticleApps }),
        providerOptions: { gateway: { models: [ESCALATION_MODEL] } },
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(30_000),
        system: `List the apps this article says now support or are optimized for iPhone Duo. ${DUO_CONTEXT} Use only the given text.`,
        prompt: `Title: ${a.title}\nPublisher: ${a.source}\nExcerpt: ${a.snippet || "(none)"}`,
      });
      return output.apps.filter((x) => x.app.trim());
    },
    ["article-apps", "v1", a.id],
    { revalidate: CACHE_SECONDS },
  )();
}

// ---------- App Store listing check ----------

const LISTING_QUESTIONS = {
  sameApp: {
    type: "boolean",
    instructions:
      "Is this App Store listing the app the news is about? A different app that merely shares a word in its name, an operating system, a website or a developer API does not count.",
  },
} as const;

/** Jev's probability that an App Store listing is the app a news item names. */
export function confirmListing(
  news: { app: string; company: string; headline: string },
  listing: Pick<App, "id" | "name" | "developer" | "genre">,
): Promise<number> {
  return unstable_cache(
    async () => {
      const r = await decide({
        model: DECISION_MODEL,
        state: { news, appStoreListing: listing },
        questions: LISTING_QUESTIONS,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(30_000),
        providerOptions: { gateway: { models: [ESCALATION_MODEL] } satisfies GatewayProviderOptions },
      });
      return r.answers.sameApp.probability;
    },
    ["listing", "v2", news.app.toLowerCase(), String(listing.id)],
    { revalidate: CACHE_SECONDS },
  )();
}

/** Run async work over items with limited concurrency; failures are counted, not thrown. */
export async function pool<T, R>(items: T[], concurrency: number, fn: (t: T) => Promise<R>) {
  const results: (R | undefined)[] = new Array(items.length);
  let failed = 0;
  let firstError: string | undefined;
  let i = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          results[idx] = await fn(items[idx]);
        } catch (e) {
          failed++;
          firstError ??= e instanceof Error ? e.message : String(e);
        }
      }
    }),
  );
  return { results, failed, firstError };
}
