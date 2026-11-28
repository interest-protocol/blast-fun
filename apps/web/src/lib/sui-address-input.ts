"use client";

import { isWholeSuiAddressInput } from "@blast/core/lib/sui/ids.ts";
import { SUI_MAINNET_GRPC_URL } from "@blast/core/lib/sui-mainnet.ts";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { isValidSuiNSName, normalizeSuiNSName } from "@mysten/sui/utils";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import { diagnosticMessage } from "./errors.ts";
import { isEnterSubmit } from "./ime-enter.ts";

export const SUI_ADDRESS_PLACEHOLDER = "0x… or name.sui";
export const SUI_NAME_LOOKUP_LABEL = "Looking up SuiNS name…";

export const SUI_NAME_LOOKUP_ERROR_CODE = "service_unavailable";

const inFlight = new Map<string, Promise<string | null>>();
let client: Promise<SuiGrpcClient> | undefined;

/** Mainnet's node client, loaded at the first name lookup (its gRPC code stays out of the page); a failed load is tried again next time. */
function nameClient(): Promise<SuiGrpcClient> {
  client ??= import("@mysten/sui/grpc").then(
    ({ SuiGrpcClient: Client }) => new Client({ network: "mainnet", baseUrl: SUI_MAINNET_GRPC_URL }),
    (error: unknown) => {
      client = undefined;
      throw error;
    },
  );
  return client;
}

function suiName(value: string): string | null {
  const name = value.trim();
  return isValidSuiNSName(name) ? normalizeSuiNSName(name, "dot") : null;
}

export async function resolveSuiName(value: string): Promise<string | null> {
  const name = suiName(value);
  if (!name) return null;
  const pending = inFlight.get(name);
  if (pending) return pending;

  const lookup = nameClient().then((node) => node.resolveNameServiceAddress({ name, signal: AbortSignal.timeout(5_000) })).then(({ address }) => {
    if (address === null) return null;
    const target = address.trim().toLowerCase();
    if (!isWholeSuiAddressInput(target) || /^0x0{64}$/.test(target)) throw new Error("Invalid SuiNS target address");
    return target;
  });
  inFlight.set(name, lookup);
  try {
    return await lookup;
  } finally {
    inFlight.delete(name);
  }
}

/** The default SuiNS name the wallet owner chose to display. */
export async function resolveDefaultSuiName(address: string): Promise<string | null> {
  if (!isWholeSuiAddressInput(address)) return null;
  try {
    const node = await nameClient();
    const { data: { name } } = await node.core.defaultNameServiceName({ address, signal: AbortSignal.timeout(5_000) });
    return name ? suiName(name) : null;
  } catch {
    return null;
  }
}

/** Safari can leave focus on a text field when a step button is clicked. */
export function blurAllocationAddress(): void {
  const input = document.activeElement;
  if (input instanceof HTMLInputElement && input.hasAttribute("data-allocation-address")) input.blur();
}

type LookupState = Readonly<{ value: string; status: "pending" | "not-found" | "error" | "resolved" }>;

export function useSuiAddressLookup(value: string, onResolved: (address: string) => void) {
  const [state, setState] = useState<LookupState | null>(null);
  const active = useRef<LookupState | null>(null);
  const resolveForCurrentField = useRef(onResolved);
  useLayoutEffect(() => {
    resolveForCurrentField.current = onResolved;
    if (active.current?.value !== value) active.current = null;
  });
  useLayoutEffect(() => () => { active.current = null; }, []);

  const name = suiName(value) !== null;
  const status = state?.value === value ? state.status : "idle";

  function invalidate() {
    active.current = null;
    setState(null);
  }

  function lookup(input: string = value) {
    if (!suiName(input) || active.current?.value === input) return;
    const request = { value: input, status: "pending" } as const;
    active.current = request;
    setState(request);
    void resolveSuiName(input).then((address) => {
      if (active.current !== request) return;
      active.current = null;
      if (address === null) {
        setState({ value: input, status: "not-found" });
      } else {
        setState({ value: address, status: "resolved" });
        resolveForCurrentField.current(address);
      }
    }, () => {
      if (active.current !== request) return;
      active.current = null;
      setState({ value: input, status: "error" });
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!name || !isEnterSubmit(event)) return;
    event.preventDefault();
    lookup();
  }

  const error = status === "not-found" ? "This SuiNS name has no wallet address. Check the name or enter an address."
    : status === "error" ? diagnosticMessage("Couldn’t look up this SuiNS name. Press Enter to retry or enter an address.", { code: SUI_NAME_LOOKUP_ERROR_CODE }) : null;

  const confirmation = status === "resolved" ? `SuiNS name resolved to ${value}.` : "";

  return { name, status, error, confirmation, lookup, invalidate, onKeyDown };
}
