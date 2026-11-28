import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { SOCIAL_ERRORS } from "@blast/core/modules/social/contracts/errors.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import {
  SOCIAL_WHY_ID_PATTERN,
  WHY_REPORT_MAX_CODE_POINTS,
  socialItemWhyPath,
  socialWhyPath,
  socialWhyReportRequestSchema,
  socialWhyReportedSchema,
  socialWhyReportsPath,
} from "@blast/core/modules/social/contracts/whys.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { whyEntryParameter, whyIdParameter } from "@blast/server/modules/social/whys/route.ts";
import { dynamic, runtime } from "#web/app/api/[...path]/route.ts";
import { assertApiAllow } from "#web/test/fixtures/api-routes.ts";

const WHY_ID = "3f1c2d4e-5a6b-47c8-9d0e-1f2a3b4c5d6e";

test("T-022: why routes allow only their declared writes and run dynamically on Node", async () => {
  await assertApiAllow(`/api/social/whys/${WHY_ID}`, "DELETE, OPTIONS");
  await assertApiAllow(`/api/social/whys/${WHY_ID}/reports`, "OPTIONS, POST");
  await assertApiAllow("/api/social/items/a%3A12%3A0%3A0%3A0/why", "OPTIONS, POST");
  assert.equal(runtime, "nodejs");
  assert.equal(dynamic, "force-dynamic");
});

test("T-022: the paths are the contract's, and a why id is one canonical lowercase UUID segment", () => {
  assert.equal(socialWhyPath(WHY_ID), `/api/social/whys/${WHY_ID}`);
  assert.equal(socialWhyReportsPath(WHY_ID), `/api/social/whys/${WHY_ID}/reports`);
  assert.equal(socialItemWhyPath("a:12:0:0:0"), "/api/social/items/a%3A12%3A0%3A0%3A0/why");
  const parse = (path: string, withReports: boolean) => whyIdParameter(new Request(`https://blast.fun${path}`), withReports);
  assert.equal(parse(socialWhyPath(WHY_ID), false), WHY_ID);
  assert.equal(parse(socialWhyReportsPath(WHY_ID), true), WHY_ID);
  const refused = (path: string, withReports: boolean) =>
    assert.throws(() => parse(path, withReports), (error: unknown) =>
      error instanceof SocialRouteError && error.code === "invalid_parameter" && error.extra.parameter === "why_id", path);
  for (const [path, withReports] of [
    ["/api/social/whys/not-a-uuid", false],
    [`/api/social/whys/${WHY_ID.toUpperCase()}`, false],
    [`/api/social/whys/${WHY_ID}1`, false],
    [`/api/social/whys/${WHY_ID}/reports`, false],
    [`/api/social/whys/${WHY_ID}/extra`, false],
    ["/api/social/whys/", false],
    ["/api/social/whys/%E0%A4%A", false],
    [`/api/social/items/${WHY_ID}`, false],
    [`/api/social/whys/${WHY_ID}`, true],
    [`/api/social/whys/${WHY_ID}/report`, true],
    [`/api/social/whys/${WHY_ID}/reports/1`, true],
  ] as const) {
    refused(path, withReports);
  }
  // The item's why route keeps its own parameter name.
  assert.throws(() => whyEntryParameter(new Request("https://blast.fun/api/social/items/not%20an%20id/why")), (error: unknown) =>
    error instanceof SocialRouteError && error.extra.parameter === "entry_id");
  // Every id the create route can answer is a path this pattern accepts.
  for (let n = 0; n < 16; n += 1) assert.match(randomUUID(), SOCIAL_WHY_ID_PATTERN);
});

test("T-022: the report parser normalizes and trims before applying the code-point limit", () => {
  const parse = (reason: unknown) => socialWhyReportRequestSchema.parse({ reason }).reason;
  assert.deepEqual(socialWhyReportRequestSchema.parse({}), {});
  assert.equal(parse(""), "");
  assert.equal(parse(" \t 　 "), "");
  assert.equal(parse("  Café claim  "), "Café claim");
  // A reason is private evidence, so a line break or a link is not refused the way a why's text is.
  assert.equal(parse("two\nlines, see https://x.io"), "two\nlines, see https://x.io");
  const limit = "\u{1F680}".repeat(WHY_REPORT_MAX_CODE_POINTS);
  assert.equal(parse(` ${limit} `), limit);
  const refused = (reason: unknown) =>
    assert.equal(socialWhyReportRequestSchema.safeParse({ reason }).success, false);
  refused("\u{1F680}".repeat(WHY_REPORT_MAX_CODE_POINTS + 1));
  refused("a".repeat(WHY_REPORT_MAX_CODE_POINTS + 1));
  refused(7);
  refused(null);
  refused({ reason: "x" });
});

test("T-022: the published schemas and the route agree on a report's body and answer", () => {
  const validator = createSocialValidator();
  const valid = (name: "why-report-request" | "why-report-response", body: unknown) => validator.validate(name, body).valid;
  const rocket = "\u{1F680}";
  // The request: closed, an optional reason of at most 280 code points (ajv counts code points, as the route does).
  assert.ok(valid("why-report-request", {}));
  assert.ok(valid("why-report-request", { reason: "spam" }));
  assert.ok(valid("why-report-request", { reason: rocket.repeat(WHY_REPORT_MAX_CODE_POINTS) }));
  assert.ok(!valid("why-report-request", { reason: rocket.repeat(WHY_REPORT_MAX_CODE_POINTS + 1) }));
  assert.ok(!valid("why-report-request", { reason: 7 }));
  assert.ok(!valid("why-report-request", { reason: "spam", extra: 1 }));
  assert.equal(socialWhyReportRequestSchema.safeParse({ reason: rocket.repeat(WHY_REPORT_MAX_CODE_POINTS) }).success, true);
  assert.equal(socialWhyReportRequestSchema.safeParse({ reason: rocket.repeat(WHY_REPORT_MAX_CODE_POINTS + 1) }).success, false);
  // The answer: the why's id and whether this account had already reported it, and nothing else (never the reason).
  assert.ok(valid("why-report-response", { why_id: WHY_ID, already_reported: false }));
  assert.ok(valid("why-report-response", { why_id: WHY_ID, already_reported: true }));
  assert.ok(!valid("why-report-response", { why_id: WHY_ID }));
  assert.ok(!valid("why-report-response", { why_id: WHY_ID.toUpperCase(), already_reported: true }));
  assert.ok(!valid("why-report-response", { why_id: WHY_ID, already_reported: true, reason: "spam" }));
  assert.equal(socialWhyReportedSchema.safeParse({ why_id: WHY_ID, already_reported: true, reason: "spam" }).success, false);
});

test("T-022: cannot_report_self is a published 422 and carries no Retry-After", () => {
  assert.deepEqual(SOCIAL_ERRORS.cannot_report_self, { status: 422, retryAfter: false });
  assert.equal(new SocialRouteError("cannot_report_self").status, 422);
  assert.equal(new SocialRouteError("cannot_report_self").retryAfterSeconds, null);
});
