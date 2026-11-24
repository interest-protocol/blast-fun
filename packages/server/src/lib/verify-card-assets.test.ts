import test from "node:test";

test("the packaged card assets match the manifest exactly", async () => {
  await import("./verify-card-assets.ts");
});
