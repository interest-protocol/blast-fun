import { fixtureToken } from "../../../../portfolio/server";
export function GET(request: Request) {
  return Response.json({ token: fixtureToken(Number(new URL(request.url).searchParams.get("account"))) }, { headers: { "cache-control": "no-store" } });
}
