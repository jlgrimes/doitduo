import { getUpdates } from "@/lib/apple";
import UpdatesList from "./updates-list";

export const revalidate = 1800; // re-scrape every 30 minutes

export default async function Home() {
  const { updates, checkedAt, appsScanned } = await getUpdates();

  return (
    <main>
      <header>
        <h1>App Updates</h1>
        <p className="sub">
          When popular App Store apps ship new versions. Tracking {appsScanned} apps.
        </p>
      </header>
      <UpdatesList updates={updates} checkedAt={checkedAt} />
    </main>
  );
}
