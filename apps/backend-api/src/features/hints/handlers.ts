import { publicErrorResponse } from "@blast/core/lib/http-errors.ts";
import { ACTIVITY_HINT_STREAM_BUDGET } from "@blast/core/modules/backend-api/stream-budget.ts";
import { MARKET_STREAM_BUDGET } from "@blast/core/modules/launchpad-contract/market-stream.ts";
import {
  instanceRouteLimiter,
  routeLimitRefusal,
} from "@blast/core/modules/web-security/route-limits.ts";
import type { HintSink, HintSubscription } from "@blast/server/lib/hint-subscription.ts";
import {
  MARKET_STREAM_HEADERS,
  type MarketStreamRelay,
} from "@blast/server/modules/launchpad-market/stream-relay.ts";
import {
  ACTIVITY_HINT_HEADERS,
  type ActivityHintRelay,
} from "@blast/server/modules/social/activity/hint-relay.ts";
import { hintOriginRefusal } from "@blast/server/modules/social/activity/hint-runtime.ts";
import type { PrivateContext } from "@blast/server/private/handler.ts";
import type { Done } from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import { HintsApi } from "../../data/api/hints/HintsApi.ts";

export class VerifiedHintsRequest extends Context.Service<VerifiedHintsRequest, PrivateContext>()(
  "blast/backend-api/hints/VerifiedHintsRequest",
) {}

export class HintRelays extends Context.Service<
  HintRelays,
  Readonly<{
    activity: () => ActivityHintRelay;
    market: (() => MarketStreamRelay) | null;
  }>
>()("blast/backend-api/hints/HintRelays") {}

export const hintHandlers = HttpApiBuilder.group(HintsApi, "hints", (handlers) =>
  Effect.gen(function* () {
    const relays = yield* HintRelays;
    return handlers
      .handle("activity", ({ request }) =>
        openStream(
          request,
          relays.activity,
          ACTIVITY_HINT_HEADERS,
          ACTIVITY_HINT_STREAM_BUDGET.queuedChunks,
          () => 1,
        ),
      )
      .handle("activityHead", ({ request }) =>
        streamHead(request, relays.activity, ACTIVITY_HINT_HEADERS),
      )
      .handle("market", ({ request }) =>
        openStream(
          request,
          relays.market,
          MARKET_STREAM_HEADERS,
          MARKET_STREAM_BUDGET.queueBytesPerClient,
          (chunk) => chunk.byteLength,
        ),
      )
      .handle("marketHead", ({ request }) =>
        streamHead(request, relays.market, MARKET_STREAM_HEADERS),
      );
  }),
);

type Relay = Readonly<{ subscribe(request: Request, sink?: HintSink): HintSubscription }>;
type RelayLookup = (() => Relay) | null;
type StreamHeaders = typeof ACTIVITY_HINT_HEADERS | typeof MARKET_STREAM_HEADERS;

const admittedRequest = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
  const { client } = yield* VerifiedHintsRequest;
  const web = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie);
  const rateRefusal = yield* Effect.promise(() =>
    routeLimitRefusal(client, ["social_read"], { limiter: instanceRouteLimiter() }),
  );
  return rateRefusal ?? hintOriginRefusal(web) ?? web;
});

const openStream = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
  relay: RelayLookup,
  headers: StreamHeaders,
  limit: number,
  measure: (chunk: Uint8Array) => number,
) {
  const admitted = yield* admittedRequest(request);
  if (admitted instanceof Response) {
    return relayError(admitted);
  }

  // Each queued chunk and the chunk on the Effect-to-Web boundary share the same cap.
  const queue = yield* Queue.dropping<Uint8Array, Done>(limit);
  let reserved = 0;
  let delivered = 0;
  const sink: HintSink = {
    send(chunk) {
      const size = measure(chunk);
      if (reserved + size > limit || !Queue.offerUnsafe(queue, chunk)) {
        return false;
      }
      reserved += size;
      return true;
    },
    close() {
      Queue.endUnsafe(queue);
    },
  };
  const subscription = yield* Effect.acquireRelease(
    subscribe(relay, admitted, sink),
    (subscription) =>
      Effect.sync(() => {
        if (typeof subscription === "function") {
          subscription();
        }
      }),
  );
  if (subscription instanceof Response) {
    return relayError(subscription);
  }

  const take = Effect.suspend(() => {
    reserved -= delivered;
    delivered = 0;
    return Queue.take(queue);
  }).pipe(
    Effect.tap((chunk) =>
      Effect.sync(() => {
        delivered = measure(chunk);
      }),
    ),
  );
  return HttpApiSchema.withHeaders({ body: Stream.fromEffectRepeat(take), headers });
});

const streamHead = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
  relay: RelayLookup,
  headers: StreamHeaders,
) {
  const admitted = yield* admittedRequest(request);
  if (admitted instanceof Response) {
    return relayError(admitted);
  }
  const subscription = yield* subscribe(relay, admitted);
  if (subscription instanceof Response) {
    return relayError(subscription);
  }
  return HttpApiSchema.withHeaders({ body: undefined, headers });
});

function subscribe(relay: RelayLookup, request: Request, sink?: HintSink) {
  return Effect.try({
    try: () =>
      relay === null
        ? publicErrorResponse("private_gateway_forbidden", "Not allowed.", 403)
        : relay().subscribe(request, sink),
    catch: (cause) =>
      publicErrorResponse(
        "INTERNAL_ERROR",
        "The request could not be completed. Please retry.",
        500,
        {
          cause,
          route: "social_read",
        },
      ),
  }).pipe(Effect.catch(Effect.succeed));
}

function relayError(response: Response) {
  return HttpServerResponse.raw(response, { status: response.status });
}
