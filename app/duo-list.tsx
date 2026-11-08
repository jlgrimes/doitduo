"use client";

import { useEffect, useMemo, useState } from "react";
import type { DuoApp, DuoFeed, Level } from "@/lib/feed";

const RANGES = [
  { key: "24h", label: "24h", ms: 864e5 },
  { key: "7d", label: "7 days", ms: 7 * 864e5 },
  { key: "all", label: "Since launch", ms: Infinity },
] as const;
const LEVELS = [
  { key: "low", label: "Any" },
  { key: "medium", label: "Medium+" },
  { key: "high", label: "High" },
] as const;
const RANK: Record<Level, number> = { low: 0, medium: 1, high: 2 };

const LEVEL_LABEL: Record<DuoApp["level"], string> = {
  optimized: "Optimized for iPhone Duo",
  improved: "iPhone Duo improvements",
  fix_only: "iPhone Duo fixes only",
  coming_later: "iPhone Duo support coming later",
  unrelated: "Unclear",
};

const pct = (p: number) => `${Math.round(p * 100)}%`;

function relative(iso: string, now: number) {
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d ago` : `${Math.round(d / 30)}mo ago`;
}

function Seg<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button key={o.key} role="tab" aria-selected={value === o.key} className={value === o.key ? "active" : ""} onClick={() => onChange(o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

type Fmt = { day: Intl.DateTimeFormat; time: Intl.DateTimeFormat; full: Intl.DateTimeFormat };

export default function DuoList({ feed }: { feed: DuoFeed }) {
  const { apps, checkedAt, stats } = feed;
  const [query, setQuery] = useState("");
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("all");
  const [minLevel, setMinLevel] = useState<Level>("medium");
  // Clock/time-zone rendering waits for the browser to avoid hydration mismatches.
  const [now, setNow] = useState(() => Date.parse(checkedAt));
  const [timeZone, setTimeZone] = useState("UTC");

  useEffect(() => {
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const fmt: Fmt = useMemo(
    () => ({
      day: new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", timeZone }),
      time: new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }),
      full: new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone }),
    }),
    [timeZone],
  );

  const { groups, total } = useMemo(() => {
    const maxAge = RANGES.find((r) => r.key === range)!.ms;
    const q = query.trim().toLowerCase();
    const filtered = apps.filter(
      (a) =>
        now - Date.parse(a.duoSince) <= maxAge &&
        RANK[a.tier] >= RANK[minLevel] &&
        (!q || `${a.name} ${a.developer} ${a.genre}`.toLowerCase().includes(q)),
    );
    const byDay = new Map<string, DuoApp[]>();
    for (const a of filtered) {
      const d = fmt.day.format(new Date(a.duoSince));
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d)!.push(a);
    }
    return { groups: [...byDay], total: filtered.length };
  }, [apps, query, range, minLevel, now, fmt]);

  return (
    <>
      <div className="controls">
        <input type="search" placeholder="Search apps, developers, categories" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="row">
          <Seg options={RANGES} value={range} onChange={setRange} />
          <Seg options={LEVELS} value={minLevel} onChange={setMinLevel} />
        </div>
      </div>

      <p className="meta">
        {total} app{total === 1 ? "" : "s"} · checked {stats.appsEligible.toLocaleString()} recently updated apps (
        {stats.historiesScanned.toLocaleString()} version histories) · updated{" "}
        <time dateTime={checkedAt} title={fmt.full.format(new Date(checkedAt))}>
          {relative(checkedAt, now)}
        </time>
      </p>
      {stats.historiesScanned < stats.appsEligible && (
        <p className="meta">
          Still scanning version histories ({stats.historiesScanned.toLocaleString()} of {stats.appsEligible.toLocaleString()});
          more apps appear as the scan catches up.
        </p>
      )}

      {groups.length === 0 && <p className="empty">No apps match these filters yet.</p>}

      {groups.map(([day, list]) => (
        <section key={day}>
          <h2>{day}</h2>
          <ul>
            {list.map((a) => (
              <Row key={a.id} app={a} now={now} fmt={fmt} />
            ))}
          </ul>
        </section>
      ))}

      <footer>
        An app is listed when its developer says, in the App Store release notes, that a version supports iPhone Duo, or
        when news coverage says so. Every app runs on iPhone Duo, so only an explicit statement of support counts. Jev
        (TypeSafe AI&apos;s decision model, via Vercel AI Gateway) reads each release note and article that mentions Duo and
        gives the probability that it means real support (not Duolingo&apos;s owl, a bug fix, or &ldquo;coming soon&rdquo;).
        Unsure cases are re-checked by Claude Sonnet. The time shown is when the first version with Duo support was
        released. Apps that support Duo without saying so in their notes or the news won&apos;t appear.
      </footer>
    </>
  );
}

function Row({ app: a, now, fmt }: { app: DuoApp; now: number; fmt: Fmt }) {
  const lead = a.evidence.find((e) => e.kind === "release-notes" && e.p >= 0.5) ?? a.evidence[0];
  const line = lead.kind === "release-notes" ? `“${lead.quote}”` : lead.title;
  return (
    <li>
      <details>
        <summary>
          {a.icon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={a.icon} alt="" width={40} height={40} loading="lazy" />
          ) : (
            <span className="avatar">{a.name.slice(0, 1)}</span>
          )}
          <span className="info">
            <span className="name">
              {a.name}
              {a.duoVersion && <span className="version">v{a.duoVersion}</span>}
            </span>
            <span className="line">{line}</span>
          </span>
          <span className="right">
            <span className={`badge ${a.tier}`} title={`${a.confidence}% confidence`}>
              <span className="dot" />
              {a.confidence}
            </span>
            <time dateTime={a.duoSince} title={fmt.full.format(new Date(a.duoSince))}>
              {fmt.time.format(new Date(a.duoSince))} · {relative(a.duoSince, now)}
            </time>
          </span>
        </summary>

        <div className="detail">
          <dl className="times">
            <dt>Duo support</dt>
            <dd>
              {a.duoVersion
                ? `Shipped in v${a.duoVersion} on ${fmt.full.format(new Date(a.duoSince))}`
                : `First reported ${fmt.full.format(new Date(a.duoSince))}`}
            </dd>
            <dt>Type</dt>
            <dd>{LEVEL_LABEL[a.level]}</dd>
            <dt>Developer</dt>
            <dd>
              {a.developer}
              {a.genre && ` · ${a.genre}`} · now on v{a.currentVersion}
            </dd>
          </dl>

          <div className="signals">
            <span className="label">{a.confidence}% confident this app works with iPhone Duo · {a.tier}</span>
            <ul>
              {a.evidence.map((e, i) => (
                <li key={i}>
                  <span className={e.p >= 0.5 ? "pos" : e.p >= 0.2 ? "zero" : "neg"}>{pct(e.p)}</span>
                  <span className="ev">
                    {e.kind === "release-notes" ? (
                      <>
                        Release notes v{e.version} ({fmt.full.format(new Date(e.at))}): &ldquo;{e.quote}&rdquo;
                        <em>
                          {" "}
                          Jev: {pct(e.pSupport)} says Duo support
                          {e.escalated && " · re-checked by Claude Sonnet"}
                        </em>
                      </>
                    ) : (
                      <>
                        <a href={e.url} target="_blank" rel="noreferrer">
                          {e.title}
                        </a>{" "}
                        · {e.source}
                        {e.sourceKind === "first-party" && " (official)"} · {fmt.full.format(new Date(e.at))}
                        <em>
                          {" "}
                          Jev: {pct(e.pSupport)} reports Duo support, {pct(e.pSameApp)} this App Store app
                          {e.escalated && " · re-checked by Claude Sonnet"}
                        </em>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <a className="store" href={a.url} target="_blank" rel="noreferrer">
            View on App Store →
          </a>
        </div>
      </details>
    </li>
  );
}
