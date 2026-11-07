// Where we look for app-update articles. Add or remove feeds freely; any feed
// that fails to load is skipped.
//
// kind:
//   "first-party"  the company's own blog / changelog (strongest signal)
//   "news"         tech press
//   "aggregator"   search results / link aggregators (weakest signal)

export type SourceKind = "first-party" | "news" | "aggregator";

export type Source = { name: string; url: string; kind: SourceKind };

const googleNews = (q: string) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

export const SOURCES: Source[] = [
  // Tech press
  { name: "9to5Mac", url: "https://9to5mac.com/feed/", kind: "news" },
  { name: "9to5Google", url: "https://9to5google.com/feed/", kind: "news" },
  { name: "MacRumors", url: "https://feeds.macrumors.com/MacRumors-All", kind: "news" },
  { name: "AppleInsider", url: "https://appleinsider.com/rss/news/", kind: "news" },
  { name: "The Verge", url: "https://www.theverge.com/rss/index.xml", kind: "news" },
  { name: "TechCrunch", url: "https://techcrunch.com/feed/", kind: "news" },
  { name: "Engadget", url: "https://www.engadget.com/rss.xml", kind: "news" },
  { name: "Android Police", url: "https://www.androidpolice.com/feed/", kind: "news" },
  { name: "Android Authority", url: "https://www.androidauthority.com/feed/", kind: "news" },
  { name: "Neowin", url: "https://www.neowin.net/news/rss/", kind: "news" },

  // Company blogs & changelogs
  { name: "GitHub Changelog", url: "https://github.blog/changelog/feed/", kind: "first-party" },
  { name: "OpenAI", url: "https://openai.com/news/rss.xml", kind: "first-party" },
  { name: "Google Workspace Updates", url: "https://workspaceupdates.googleblog.com/feeds/posts/default", kind: "first-party" },
  { name: "Vercel Changelog", url: "https://vercel.com/atom", kind: "first-party" },
  { name: "Spotify Newsroom", url: "https://newsroom.spotify.com/feed/", kind: "first-party" },
  { name: "Meta Newsroom", url: "https://about.fb.com/feed/", kind: "first-party" },
  { name: "Duolingo Blog", url: "https://blog.duolingo.com/rss/", kind: "first-party" },
  { name: "Slack iOS Release Notes", url: "https://slack.com/release-notes/ios/rss", kind: "first-party" },

  // Web-wide search
  { name: "Google News", url: googleNews('app "new update" when:3d'), kind: "aggregator" },
  { name: "Google News", url: googleNews('app "rolling out" when:3d'), kind: "aggregator" },
  { name: "Google News", url: googleNews('app "latest version" OR "now available" when:3d'), kind: "aggregator" },
  { name: "Hacker News", url: "https://hnrss.org/newest?q=release+OR+update+OR+changelog+OR+launch&points=40", kind: "aggregator" },
];
