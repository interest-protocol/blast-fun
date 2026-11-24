import { serviceHealth } from "./runtime.ts";

export async function serviceHealthRoute() {
  return Response.json(await serviceHealth(), { headers: { "Cache-Control": "no-store" } });
}
export { serviceHealthRoute as GET };
