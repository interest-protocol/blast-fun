"use client";

import { createContext, use, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { defineBlastDeployment, type BlastDeployment, type VenueAvailability } from "@interest-protocol/blast-sdk/deployments";

import { createActionController, type ActionController } from "../transaction/controller";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { invalidateAfter } from "#web/lib/query/invalidate.ts";
import { useFeelSound } from "#web/components/blast-feel/FeelProvider.tsx";
import { useBalancesContext } from "#web/components/social/coins/balances.tsx";
import { useCoinTradeWallet } from "./CoinTradeSignerProvider";
import { useLaunchpadSigners } from "../transaction/LaunchpadSignerProvider";
import type { LaunchpadChain } from "../transaction/preflight";
import { freshTrade } from "./amount";
import type { TradeDirection } from "./curve-adapter";
import { venueTradeAdapter, type VenueTradeInput } from "./venue-adapter";
import { readRecordedSwap, readVenueAvailability, readVenueRoute, type VenueLocator, type VenueRouteRead, type VenueTrade } from "./venue-route";
import { gateVenueTrades } from "./venue-session";

export const DEFAULT_VENUE_SLIPPAGE_BPS = 100n;

type Reading = Readonly<{ status: "reading" }>;
type Controllers = Readonly<Record<TradeDirection, ActionController<VenueTradeInput>>>;

export type VenueTradeSession = Readonly<{
  chain: LaunchpadChain;
  /** The app's deployment, whose venue packages an abort must come from to be read as theirs. */
  deployment: BlastDeployment;
  locator: VenueLocator;
  /** The recorded route as last read from chain records. */
  route: VenueRouteRead | Reading;
  /** Whether the confirmed deployment makes the recorded venue available; null before a supported route is read. */
  availability: VenueAvailability | Reading | null;
  /** The connected wallet's balances, once a wallet is connected. */
  balances: Readonly<{ quote: bigint; meme: bigint }> | null;
  balancesPending?: boolean;
  refresh(): void;
  direction: TradeDirection;
  setDirection(direction: TradeDirection): void;
  /** Both directions' controllers: gated while a trade is unresolved, and an expired quote is quoted again instead of approved. */
  controllers: Controllers;
  /** What each completed swap did, from its reconciled transaction, by digest. */
  completed: Readonly<Record<string, VenueTrade | "unavailable">>;
  /** The session's clock, which quote expiry is judged by. */
  now: () => number;
}>;

const Session = createContext<VenueTradeSession | null>(null);

export function useVenueTrade(): VenueTradeSession {
  const session = use(Session);
  if (!session) throw new Error("useVenueTrade needs a VenueTradeProvider.");
  return session;
}

/**
 * Owns both directions' venue trade controllers and the recorded route for
 * one migrated launch, above the terminal. Mount it under a
 * `LaunchpadSignerProvider`. The route is never chosen here: it is read from
 * the launch's chain records each time, and every review reads it again.
 */
export function VenueTradeProvider({
  chain,
  locator,
  onInvalidate,
  initialRoute,
  initialAvailability,
  controllers: provided,
  now = Date.now,
  children,
}: Readonly<{
  chain: LaunchpadChain;
  locator: VenueLocator;
  /** Called with the venue read keys a completed swap invalidates (pool, chart, activity, balances). */
  onInvalidate?: (keys: readonly string[]) => void;
  /** A route already read, for rendering without a node. */
  initialRoute?: VenueRouteRead;
  initialAvailability?: VenueAvailability;
  /** Controllers already created (tests); by default the provider creates them. */
  controllers?: Controllers;
  now?: () => number;
  children: ReactNode;
}>) {
  const { play } = useFeelSound();
  const signers = useLaunchpadSigners();
  const queries = useAppQueryClient();
  const shellBalances = useBalancesContext();
  const wallet = useCoinTradeWallet();
  const walletIdentity = wallet?.identity ?? "standalone";
  const [deployment] = useState(() => defineBlastDeployment(chain.manifest));
  const [controllers] = useState<Controllers>(() => {
    if (provided) return provided;
    const create = (direction: TradeDirection) =>
      createActionController({
        adapter: venueTradeAdapter(direction, { now }),
        chain,
        signers,
        input: { ...locator, direction, amount: "", slippageBps: DEFAULT_VENUE_SLIPPAGE_BPS },
        restart: freshTrade,
      });
    return { buy: create("buy"), sell: create("sell") };
  });
  const [gated] = useState(() => gateVenueTrades(controllers, now));
  const [route, setRoute] = useState<VenueTradeSession["route"]>(initialRoute ?? { status: "reading" });
  const [availability, setAvailability] = useState<VenueTradeSession["availability"]>(initialAvailability ?? null);
  const [refreshes, setRefreshes] = useState(0);
  const [balanceRead, setBalanceRead] = useState<Readonly<{ identity: string; value: VenueTradeSession["balances"] }> | null>(null);
  const balanceKey = `${walletIdentity}:${refreshes}`;
  const balances = balanceRead?.identity === balanceKey ? balanceRead.value : null;
  const balancesPending = Boolean(wallet?.identity && balanceRead?.identity !== balanceKey);
  const [direction, setDirection] = useState<TradeDirection>("buy");
  const [completed, setCompleted] = useState<VenueTradeSession["completed"]>({});
  const refresh = useCallback(() => setRefreshes((count) => count + 1), []);
  const routeRef = useRef(route);
  useEffect(() => {
    routeRef.current = route;
  }, [route]);

  // The recorded route, the venue's availability, and (with a wallet) balances, read fresh.
  useEffect(() => {
    let current = true;
    void readVenueRoute(chain.client, deployment, locator, Date.now()).then(async (read) => {
      if (!current) return;
      setRoute(read);
      setBalanceRead(null);
      setAvailability(null);
      if (read.status !== "ok") return;
      const venue = await readVenueAvailability(chain, read.recorded.venue);
      if (current) setAvailability(venue);
      const signer = signers.current();
      if (!signer) return;
      try {
        const [quote, meme] = await Promise.all([
          chain.client.core.getBalance({ owner: signer.address, coinType: read.recorded.launch.quoteType }),
          chain.client.core.getBalance({ owner: signer.address, coinType: read.recorded.launch.memeType }),
        ]);
        if (current) setBalanceRead({ identity: balanceKey, value: { quote: BigInt(quote.balance.balance), meme: BigInt(meme.balance.balance) } });
      } catch {
        if (current) setBalanceRead({ identity: balanceKey, value: null });
      }
    });
    return () => {
      current = false;
    };
  }, [chain, deployment, locator, refreshes, signers, balanceKey]);

  // A completed swap invalidates only venue reads: the rail refreshes its own, the page the rest.
  const invalidateRef = useRef(onInvalidate);
  const balancesRef = useRef(shellBalances);
  useEffect(() => {
    balancesRef.current = shellBalances;
    invalidateRef.current = onInvalidate;
  }, [onInvalidate, shellBalances]);
  useEffect(() => {
    const stops = (["buy", "sell"] as const).map((key) =>
      controllers[key].onInvalidate((keys) => {
        refresh();
        invalidateRef.current?.(keys);
        void invalidateAfter(queries, { kind: "trade" }).catch(() => {});
        void Promise.resolve().then(() => balancesRef.current.changed()).catch(() => {});
      }),
    );
    return () => stops.forEach((stop) => stop());
  }, [controllers, refresh, queries]);

  // What a reconciled swap did, from its own transaction; refresh reads when a review opens or is refused.
  useEffect(() => {
    function observe(key: "buy" | "sell") {
      const controller = controllers[key];
      let previous = controller.getState();
      return controller.subscribe(() => {
        const next = controller.getState();
        if (next.phase === "review" && (previous.phase !== "review" || next.review.id !== previous.review.id)) refresh();
        if (next.phase === "blocked" && previous.phase !== "blocked") refresh();
        if (next.phase === "succeeded" && previous.phase !== "succeeded") {
          const { digest } = next;
          const read = routeRef.current;
          void chain.client.core
            .getTransaction({ digest, include: { events: true } })
            .then((result) => {
              const transaction = result.Transaction;
              const trade =
                read.status === "ok" && transaction
                  ? readRecordedSwap({ digest, status: transaction.status, events: transaction.events ?? [] }, read.recorded)
                  : null;
              setCompleted((entries) => ({ ...entries, [digest]: trade ?? "unavailable" }));
              if (trade) play({ kind: key });
            })
            .catch(() => setCompleted((entries) => ({ ...entries, [digest]: "unavailable" })));
        }
        previous = next;
      });
    }
    const stopBuy = observe("buy");
    const stopSell = observe("sell");
    return () => { stopBuy(); stopSell(); };
  }, [chain, controllers, play, refresh]);

  return (
    <Session value={{ chain, deployment, locator, route, availability, balances, balancesPending, refresh, direction, setDirection, controllers: gated, completed, now }}>
      {children}
    </Session>
  );
}
