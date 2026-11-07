"use client";

import { useEffect, useMemo, useState } from "react";
import type { AppUpdate } from "@/lib/apple";

const RANGES = [
  { key: "24h", label: "24h", ms: 864e5 },
  { key: "7d", label: "7 days", ms: 7 * 864e5 },
  { key: "30d", label: "30 days", ms: 30 * 864e5 },
  { key: "all", label: "All", ms: Infinity },
] as const;

type RangeKey = (typeof RANGES)[number]["key"];

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
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

export default function UpdatesList({
  updates,
  checkedAt,
}: {
  updates: AppUpdate[];
  checkedAt: string;
}) {
  const [query, setQuery] = useState("");
  const [range, setRange] = useState<RangeKey>("7d");
  // Time-zone / clock dependent rendering waits for the browser to avoid
  // hydration mismatches; until then we render in UTC relative to checkedAt.
  const [now, setNow] = useState(() => Date.parse(checkedAt));
  const [timeZone, setTimeZone] = useState("UTC");

  useEffect(() => {
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const fmtDay = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone,
      }),
    [timeZone],
  );
  const fmtTime = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone,
        timeZoneName: "short",
      }),
    [timeZone],
  );
  const fmtFull = useMemo(
    () => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "long", timeZone }),
    [timeZone],
  );

  const groups = useMemo(() => {
    const maxAge = RANGES.find((r) => r.key === range)!.ms;
    const q = query.trim().toLowerCase();
    const filtered = updates.filter(
      (u) =>
        now - Date.parse(u.releasedAt) <= maxAge &&
        (!q || `${u.name} ${u.developer} ${u.genre}`.toLowerCase().includes(q)),
    );
    const byDay = new Map<string, AppUpdate[]>();
    for (const u of filtered) {
      const day = fmtDay.format(new Date(u.releasedAt));
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push(u);
    }
    return { count: filtered.length, days: [...byDay] };
  }, [updates, query, range, now, fmtDay]);

  return (
    <>
      <div className="controls">
        <input
          type="search"
          placeholder="Search apps, developers, categories"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="ranges" role="tablist">
          {RANGES.map((r) => (
            <button
              key={r.key}
              role="tab"
              aria-selected={range === r.key}
              className={range === r.key ? "active" : ""}
              onClick={() => setRange(r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <p className="meta">
        {groups.count} update{groups.count === 1 ? "" : "s"} · last checked{" "}
        <time dateTime={checkedAt} title={fmtFull.format(new Date(checkedAt))}>
          {relative(checkedAt, now)}
        </time>
      </p>

      {groups.days.length === 0 && <p className="empty">No updates match.</p>}

      {groups.days.map(([day, items]) => (
        <section key={day}>
          <h2>{day}</h2>
          <ul>
            {items.map((u) => (
              <li key={u.id}>
                <details>
                  <summary>
                    {u.icon ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={u.icon} alt="" width={44} height={44} loading="lazy" />
                    ) : (
                      <span className="icon-placeholder" />
                    )}
                    <span className="info">
                      <span className="name">{u.name}</span>
                      <span className="dev">
                        {u.developer}
                        {u.genre && ` · ${u.genre}`}
                      </span>
                    </span>
                    <span className="right">
                      <span className="version">v{u.version}</span>
                      <time dateTime={u.releasedAt} title={fmtFull.format(new Date(u.releasedAt))}>
                        {fmtTime.format(new Date(u.releasedAt))} · {relative(u.releasedAt, now)}
                      </time>
                    </span>
                  </summary>
                  <div className="notes">
                    <p className="stamp">
                      Released {fmtFull.format(new Date(u.releasedAt))}
                    </p>
                    {u.notes ? <p className="body">{u.notes}</p> : <p className="body muted">No release notes.</p>}
                    <a href={u.url} target="_blank" rel="noreferrer">
                      View on App Store →
                    </a>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
