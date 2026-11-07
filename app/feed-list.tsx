"use client";

import { useEffect, useMemo, useState } from "react";
import type { Feed, FeedItem, Level } from "@/lib/feed";

const RANGES = [
  { key: "24h", label: "24h", ms: 864e5 },
  { key: "3d", label: "3 days", ms: 3 * 864e5 },
  { key: "7d", label: "7 days", ms: 7 * 864e5 },
] as const;
const KINDS = [
  { key: "reported", label: "News & blogs" },
  { key: "appstore", label: "App Store" },
  { key: "all", label: "All" },
] as const;
const LEVELS = [
  { key: "low", label: "Any" },
  { key: "medium", label: "Medium+" },
  { key: "high", label: "High" },
] as const;
const RANK: Record<Level, number> = { low: 0, medium: 1, high: 2 };

const STATUS_LABEL: Record<FeedItem["status"], string> = {
  shipped: "Shipped",
  rolling_out: "Rolling out",
  beta: "Beta",
  announced: "Announced",
  rumor: "Rumor",
  not_an_update: "",
  app_store: "App Store release",
};

function relative(iso: string, now: number) {
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  return mo < 12 ? `${mo}mo ago` : `${Math.round(mo / 12)}y ago`;
}

function Seg<T extends string>({
  options,
  value,
  onChange,
  counts,
}: {
  options: readonly { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  counts?: Partial<Record<T, number>>;
}) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button key={o.key} role="tab" aria-selected={value === o.key} className={value === o.key ? "active" : ""} onClick={() => onChange(o.key)}>
          {o.label}
          {counts?.[o.key] != null && <span className="count">{counts[o.key]}</span>}
        </button>
      ))}
    </div>
  );
}

export default function FeedList({ feed }: { feed: Feed }) {
  const { items, checkedAt, stats } = feed;
  const [query, setQuery] = useState("");
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("7d");
  const [kind, setKind] = useState<(typeof KINDS)[number]["key"]>("reported");
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

  const fmt = useMemo(
    () => ({
      day: new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", timeZone }),
      time: new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }),
      full: new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone }),
    }),
    [timeZone],
  );

  const { groups, total, counts } = useMemo(() => {
    const maxAge = RANGES.find((r) => r.key === range)!.ms;
    const q = query.trim().toLowerCase();
    const base = items.filter(
      (i) =>
        now - Date.parse(i.time) <= maxAge &&
        RANK[i.level] >= RANK[minLevel] &&
        (!q || `${i.app} ${i.company} ${i.summary}`.toLowerCase().includes(q)),
    );
    const counts = {
      reported: base.filter((i) => i.kind === "reported").length,
      appstore: base.filter((i) => i.kind === "appstore").length,
      all: base.length,
    };
    const filtered = kind === "all" ? base : base.filter((i) => i.kind === kind);
    const byDay = new Map<string, FeedItem[]>();
    for (const i of filtered) {
      const d = fmt.day.format(new Date(i.time));
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d)!.push(i);
    }
    return { groups: [...byDay], total: filtered.length, counts };
  }, [items, query, range, kind, minLevel, now, fmt]);

  return (
    <>
      <div className="controls">
        <input type="search" placeholder="Search apps or companies" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="row">
          <Seg options={KINDS} value={kind} onChange={setKind} counts={counts} />
          <Seg options={RANGES} value={range} onChange={setRange} />
          <Seg options={LEVELS} value={minLevel} onChange={setMinLevel} />
        </div>
      </div>

      <p className="meta">
        {total} update{total === 1 ? "" : "s"} · Jev judged {stats.articlesClassified} articles from {stats.feedsOk} feeds
        {stats.escalated > 0 && ` (${stats.escalated} re-checked)`} · updated{" "}
        <time dateTime={checkedAt} title={fmt.full.format(new Date(checkedAt))}>
          {relative(checkedAt, now)}
        </time>
      </p>
      {stats.aiFailed > 0 && stats.articlesClassified === 0 && (
        <p className="warn">The AI step couldn&apos;t run, so only App Store data is shown right now.</p>
      )}

      {groups.length === 0 && <p className="empty">Nothing matches these filters.</p>}

      {groups.map(([day, list]) => (
        <section key={day}>
          <h2>{day}</h2>
          <ul>
            {list.map((i) => (
              <Row key={i.key} item={i} now={now} fmt={fmt} />
            ))}
          </ul>
        </section>
      ))}

      <footer>
        Confidence is the probability that an update is real and live. Jev (TypeSafe AI&apos;s decision model, via Vercel AI
        Gateway) judges every article: is it an app update, and is it shipped, rolling out, in beta, announced or a rumor? When
        Jev is unsure, the gateway re-asks Claude Sonnet. Independent sources are combined, official blogs count most, and a
        matching App Store release adds to it. Times are when the update was first reported, or Apple&apos;s release time for
        App Store entries.
      </footer>
    </>
  );
}

function Row({
  item: i,
  now,
  fmt,
}: {
  item: FeedItem;
  now: number;
  fmt: { time: Intl.DateTimeFormat; full: Intl.DateTimeFormat };
}) {
  return (
    <li>
      <details>
        <summary>
          {i.appStore?.icon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={i.appStore.icon} alt="" width={40} height={40} loading="lazy" />
          ) : (
            <span className="avatar">{i.app.slice(0, 1).toUpperCase()}</span>
          )}
          <span className="info">
            <span className="name">
              {i.app}
              {i.version && <span className="version">{i.version.startsWith("v") ? i.version : `v${i.version}`}</span>}
            </span>
            <span className="line">{i.summary || i.company}</span>
          </span>
          <span className="right">
            <span className={`badge ${i.level}`} title={`${i.confidence}% confidence`}>
              <span className="dot" />
              {i.confidence}
            </span>
            <time dateTime={i.time} title={fmt.full.format(new Date(i.time))}>
              {fmt.time.format(new Date(i.time))} · {relative(i.time, now)}
            </time>
          </span>
        </summary>

        <div className="detail">
          <dl className="times">
            {i.firstReportedAt && (
              <>
                <dt>First reported</dt>
                <dd>
                  {fmt.full.format(new Date(i.firstReportedAt))} · {i.articles[0]?.source}
                </dd>
              </>
            )}
            {i.appStore && (
              <>
                <dt>App Store</dt>
                <dd>
                  v{i.appStore.version} released {fmt.full.format(new Date(i.appStore.releasedAt))}
                </dd>
              </>
            )}
            <dt>Status</dt>
            <dd>
              {STATUS_LABEL[i.status]}
              {i.company && i.kind === "reported" && ` · ${i.company}`}
              {i.platforms.length > 0 && ` · ${i.platforms.join(", ")}`}
            </dd>
          </dl>

          <div className="signals">
            <span className="label">
              {i.kind === "reported" ? `${i.confidence}% likely this update is real and live` : `Confidence ${i.confidence}%`} · {i.level}
            </span>
            <ul>
              {i.signals.map((s) => (
                <li key={s.label}>
                  <span className={s.tone}>{s.value}</span>
                  {s.label}
                </li>
              ))}
            </ul>
          </div>

          {i.articles.length > 0 && (
            <ul className="articles">
              {i.articles.map((a) => (
                <li key={a.url}>
                  <a href={a.url} target="_blank" rel="noreferrer">
                    {a.title}
                  </a>
                  <span className="src">
                    {a.source}
                    {a.sourceKind === "first-party" && " (official)"} · {fmt.full.format(new Date(a.publishedAt))}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {i.kind === "appstore" && i.appStore?.notes && <p className="notes">{i.appStore.notes}</p>}
          {i.appStore && (
            <a className="store" href={i.appStore.url} target="_blank" rel="noreferrer">
              View on App Store →
            </a>
          )}
        </div>
      </details>
    </li>
  );
}
