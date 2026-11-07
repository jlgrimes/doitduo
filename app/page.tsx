import { getFeed } from "@/lib/feed";
import FeedList from "./feed-list";

// Rendered per request from a 30-minute cache, so the first build doesn't
// have to scrape and run the AI.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export default async function Home() {
  const feed = await getFeed();
  return (
    <main>
      <header>
        <h1>App Updates</h1>
        <p className="sub">Updates to App Store apps, found in tech news and company blogs and checked against the App Store, with a confidence score for each.</p>
      </header>
      <FeedList feed={feed} />
    </main>
  );
}
