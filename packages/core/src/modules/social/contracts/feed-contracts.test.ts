import assert from "node:assert/strict";
import test from "node:test";

import { socialActivityPageSchema } from "./activity.ts";
import { socialFeedNewResponseSchema, socialFeedPageSchema } from "./feed.ts";
import { socialItemResponseSchema } from "./item-routes.ts";
import { socialFeedItemSchema } from "./items.ts";
import { socialNotificationPageSchema, socialNotificationWirePageSchema } from "./notifications.ts";
import { socialViewerStateResponseSchema } from "./viewer-state.ts";
import { createSocialValidator, type SocialSchemaName } from "./validate.ts";

const published = createSocialValidator();
const asOf = { checkpoint: 1, timestamp_ms: 1, lag_ms: 0 };
const presaleId = `0x${"a".repeat(64)}`;
const item = {
  entry_id: "a:1:0:0:0",
  kind: "future_kind",
  occurred_at_ms: 1,
  presale: null,
  actor: null,
  amounts: null,
  digest: null,
  milestone_value: null,
  presale_post: false,
  big: false,
  why: null,
  reactions: { rocket: 0 },
  through: { people: 0, volume_usd: "0.00" },
  do_the_same: null,
  call: false,
  backers: null,
};

type Parser = { safeParse(value: unknown): { success: boolean } };

function agrees(name: SocialSchemaName, schema: Parser, value: unknown, valid: boolean) {
  assert.equal(published.validate(name, value).valid, valid, `${name}: published acceptance`);
  assert.equal(schema.safeParse(value).success, valid, `${name}: Zod acceptance`);
}

test("feed contracts preserve open kinds, nested validation, and Unicode bounds", () => {
  agrees("feed-item", socialFeedItemSchema, item, true);
  agrees("feed-item", socialFeedItemSchema, { ...item, kind: "😀".repeat(64) }, true);
  agrees("feed-item", socialFeedItemSchema, { ...item, kind: "😀".repeat(65) }, false);
  agrees(
    "feed-item",
    socialFeedItemSchema,
    { ...item, through: { people: -1, volume_usd: "0.00" } },
    false,
  );
  agrees("feed-item", socialFeedItemSchema, { ...item, reactions: { "invalid-key": 1 } }, false);
  agrees("feed-item", socialFeedItemSchema, { ...item, unexpected: true }, false);
  const page = { items: [item], next_cursor: null, as_of: asOf };
  agrees("feed-page", socialFeedPageSchema, page, true);
  agrees("feed-page", socialFeedPageSchema, { ...page, items: Array(51).fill(item) }, false);
  agrees("item-response", socialItemResponseSchema, { item, as_of: asOf }, true);
  agrees(
    "feed-new-response",
    socialFeedNewResponseSchema,
    { count: 50, more: true, actors: [], as_of: asOf },
    true,
  );
  agrees(
    "feed-new-response",
    socialFeedNewResponseSchema,
    { count: 51, more: true, actors: [], as_of: asOf },
    false,
  );
});

test("activity reuses feed actor validation and preserves decimal units", () => {
  const event = {
    activity_id: "1:0:0:0",
    kind: "presale_claim",
    occurred_at_ms: 1,
    actor: { type: "address", address: presaleId, short: "0xaaaa…aaaa" },
    presale_id: presaleId,
    sale_name: "",
    symbol: "",
    quote_symbol: "",
    usd: "0.00",
    quote: null,
    tokens: "0.000000000000000001",
    refund: null,
  };
  const page = { events: [event], next_cursor: "1:1:0:0:0", as_of: asOf };
  agrees("activity-page", socialActivityPageSchema, page, true);
  agrees(
    "activity-page",
    socialActivityPageSchema,
    { ...page, events: [{ ...event, tokens: "1e-18" }] },
    false,
  );
  agrees("activity-page", socialActivityPageSchema, { ...page, next_cursor: "bad" }, false);
});

test("viewer state checks keyed records and duplicate reaction keys", () => {
  const state = {
    reactions: { "a:1:0:0:0": ["rocket"] },
    follows: { accounts: {}, presales: {} },
    backers: {},
    follows_you: {},
  };
  agrees("viewer-state-response", socialViewerStateResponseSchema, state, true);
  agrees(
    "viewer-state-response",
    socialViewerStateResponseSchema,
    { ...state, reactions: { "a:1:0:0:0": ["rocket", "rocket"] } },
    false,
  );
  agrees(
    "viewer-state-response",
    socialViewerStateResponseSchema,
    { ...state, follows_you: { "bad key": true } },
    false,
  );
});

test("published notification copy bounds remain distinct from first-party read-time copy", () => {
  const notification = {
    id: "1",
    kind: "follow",
    title: "A follow",
    sub: "",
    occurred_at_ms: 1,
    read: false,
    href: "/presale/x",
    presale: null,
    actor: null,
  };
  const page = { items: [notification], next_cursor: null, unread_count: 0 };
  agrees("notification-page", socialNotificationPageSchema, page, true);
  const longCopy = {
    ...page,
    items: [{ ...notification, title: "x".repeat(301), sub: "x".repeat(601) }],
  };
  agrees("notification-page", socialNotificationPageSchema, longCopy, false);
  assert.deepEqual(socialNotificationWirePageSchema.parse(longCopy), longCopy);
  assert.equal(
    socialNotificationWirePageSchema.safeParse({
      ...page,
      items: [{ ...notification, kind: "unknown" }],
    }).success,
    false,
  );
});
