import { liveResponse } from "../../../../live-fixtures";

export async function GET(request: Request) {
  return liveResponse(new URL(request.url).searchParams.get("path") ?? "");
}
export async function POST(request: Request) {
  return liveResponse(new URL(request.url).searchParams.get("path") ?? "", await request.json());
}
