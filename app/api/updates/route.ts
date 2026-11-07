import { getUpdates } from "@/lib/apple";

export const revalidate = 1800;

export async function GET() {
  return Response.json(await getUpdates());
}
