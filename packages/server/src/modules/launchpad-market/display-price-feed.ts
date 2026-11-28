import {
  MARKET_STREAM_BUDGET,
  displayPriceSchema,
  displayPriceSnapshotSchema,
  type DisplayPrice,
  type DisplayPriceFrame,
} from "@blast/core/modules/launchpad-contract/market-stream.ts";
import {
  deploymentMismatch,
  parseInfraProvenance,
  type ExpectedDeployment,
} from "@blast/core/modules/launchpad-contract/provenance.ts";
import {
  blastInfraApiKey,
  blastInfraFetch,
  blastInfraReadOrigin,
} from "@blast/core/modules/read-routing/blast-infra.ts";
import { CREATE_QUOTE_TYPES } from "@blast/core/modules/social/contracts/create.ts";
import { readBoundedText } from "../../lib/web-security/request-body.ts";

/**
 * The coins that count toward a price limit: all but Create's quote coins. Every coin page prices its quote and
 * every tab shares those few rows, so the shared table keeps a row for each. Exact (normalized) strings only, so
 * the reserve stays at their count and one read still fits blast-infra's 128 coins.
 */
export function limitedPriceCoins(coins: Iterable<string>): string[] {
  return [...coins].filter((coin) => !CREATE_QUOTE_TYPES.has(coin));
}

export type DisplayPriceReader = (
  coins: readonly string[],
  signal: AbortSignal,
) => Promise<DisplayPriceFrame>;

export function committedDisplayPrices(expected: ExpectedDeployment): DisplayPriceReader {
  const origin = blastInfraReadOrigin();
  if (!origin) throw new Error("The display price feed requires the committed reader.");
  const fetchPrices = blastInfraFetch({
    infra: { origin, readOrigin: null, apiKey: blastInfraApiKey() },
  });
  const path = new URL("/v1/display-prices", origin);
  return async (coins, signal) => {
    const response = await fetchPrices(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coins }),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("The display price read failed.");
    }
    const text = await readBoundedText(response, 72 * 1024, { signal });
    const snapshot = displayPriceSnapshotSchema.parse(JSON.parse(text ?? ""));
    const provenance = parseInfraProvenance(snapshot.provenance);
    if (deploymentMismatch(provenance, expected) || provenance.checkpoint === null) {
      throw new Error("The display price snapshot is from an unexpected deployment.");
    }
    return {
      checkpoint: provenance.checkpoint,
      prices: snapshot.prices.flatMap((item) => {
        const price = displayPriceSchema.safeParse(item);
        return price.success && price.data.as_of_ms <= provenance.observedAt ? [price.data] : [];
      }),
    };
  };
}

type Subscriber = {
  coins: readonly string[];
  send: (frame: DisplayPriceFrame) => void;
  last: Map<string, DisplayPrice>;
};
/** One subscriber's handle: `update` changes its coins in place, so kept coins are not sent again. */
export type DisplayPriceSubscription = Readonly<{
  stop(): void;
  update(coins: readonly string[]): void;
}>;

const READ_INTERVAL_MS = 1_000;
const RETRY_INTERVAL_MS = 10_000;

/** The hints process reads once for all subscribed rows, and sends only changed observations. */
export class DisplayPriceFeed {
  readonly #subscribers = new Set<Subscriber>();
  readonly #snapshot: DisplayPriceReader;
  #timer?: ReturnType<typeof setTimeout>;
  #read?: AbortController;
  #nextReadAt = 0;
  #checkpoint = -1;

  constructor(snapshot: DisplayPriceReader) {
    this.#snapshot = snapshot;
  }

  #coins() {
    return new Set([...this.#subscribers].flatMap((subscriber) => subscriber.coins));
  }

  /** Whether these coins fit the shared price table next to every current subscriber's; quote coins always fit. */
  admits(coins: readonly string[]): boolean {
    return new Set(limitedPriceCoins([...this.#coins(), ...coins])).size <= MARKET_STREAM_BUDGET.maxPriceCoins - CREATE_QUOTE_TYPES.size;
  }

  subscribe(coins: readonly string[], send: Subscriber["send"]): DisplayPriceSubscription | undefined {
    if (!coins.length || !this.admits(coins)) return;
    const subscriber: Subscriber = { coins, send, last: new Map() };
    this.#subscribers.add(subscriber);
    this.#schedule();
    return {
      stop: () => {
        this.#subscribers.delete(subscriber);
        if (this.#subscribers.size) return;
        clearTimeout(this.#timer);
        this.#timer = undefined;
        this.#read?.abort();
        this.#checkpoint = -1;
      },
      // The caller checked `admits` for the added coins; a dropped coin is sent again if it returns.
      update: (next) => {
        subscriber.coins = next;
        for (const coin of subscriber.last.keys()) if (!next.includes(coin)) subscriber.last.delete(coin);
      },
    };
  }

  #schedule(): void {
    if (this.#timer || this.#read || !this.#subscribers.size) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#sample();
    }, Math.max(0, this.#nextReadAt - performance.now()));
  }

  async #sample(): Promise<void> {
    const read = new AbortController();
    this.#read = read;
    let delay = READ_INTERVAL_MS;
    try {
      const frame = await this.#snapshot([...this.#coins()], AbortSignal.any([
        read.signal,
        AbortSignal.timeout(3_000),
      ]));
      if (read.signal.aborted || frame.checkpoint < this.#checkpoint) return;
      this.#checkpoint = frame.checkpoint;
      const current = new Map(frame.prices.map((price) => [price.coin_type, price]));
      for (const { coins, send, last } of this.#subscribers) {
        const changed = coins.flatMap((coin) => {
          const price = current.get(coin);
          const previous = last.get(coin);
          if (!price || (previous &&
            (price.as_of_ms < previous.as_of_ms ||
              (price.as_of_ms === previous.as_of_ms && price.usd_price === previous.usd_price)))) return [];
          last.set(coin, price);
          return [price];
        });
        if (changed.length) send({ checkpoint: frame.checkpoint, prices: changed });
      }
    } catch {
      if (!read.signal.aborted) delay = RETRY_INTERVAL_MS;
    } finally {
      this.#read = undefined;
      this.#nextReadAt = performance.now() + delay;
      this.#schedule();
    }
  }
}
