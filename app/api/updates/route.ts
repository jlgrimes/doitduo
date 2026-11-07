import { getFeed } from "@/lib/feed";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  return Response.json(await getFeed());
}
