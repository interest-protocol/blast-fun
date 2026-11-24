import { fixtureToken } from "../../../../confirmation/server";
export function GET(request: Request) {
  const url = new URL(request.url);
  return Response.json(
    {
      token: fixtureToken(
        Number(url.searchParams.get("account")),
        url.searchParams.has("expired"),
      ),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
