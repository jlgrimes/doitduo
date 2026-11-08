import { getFeed } from "@/lib/feed";
import DuoList from "./duo-list";

// Rendered per request from a 30-minute cache.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export default async function Home() {
  const feed = await getFeed();
  return (
    <main>
      <header>
        <h1>Works with iPhone Duo</h1>
        <p className="sub">
          App Store apps that have shipped iPhone Duo support, and exactly when, from developers&apos; release notes and
          the news, each with a confidence score.
        </p>
      </header>
      <DuoList feed={feed} />
    </main>
  );
}
