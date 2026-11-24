"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { fetchCallsignAvailability } from "../create-account-client";
import type { AccessTokenSource } from "../social-fetch";
import { CALLSIGN_CHECK_DELAY_MS, checkFromReason, localCallsignCheck, suggestedCallsign, typedCallsign, type CallsignCheck } from "./onboarding-flow";

export function useCallsignInput(initial: string, getAccessToken: AccessTokenSource) {
  const [value, setValue] = useState(initial);
  const [check, setCheck] = useState<CallsignCheck>(() => checkFromReason(initial, null));
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => {
    clearTimeout(timer.current);
    request.current?.abort();
  }, []);

  const runCheck = useCallback(async (callsign: string) => {
    const controller = new AbortController();
    request.current = controller;
    try {
      const result = await fetchCallsignAvailability({ getAccessToken, callsign, signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.status !== "checked") {
        setCheck({ status: "unchecked", callsign });
        return;
      }
      let suggestion: string | null = null;
      if (result.availability.reason === "taken") {
        const candidate = suggestedCallsign(callsign);
        const next = await fetchCallsignAvailability({ getAccessToken, callsign: candidate, signal: controller.signal });
        if (controller.signal.aborted) return;
        if (next.status === "checked" && next.availability.available) suggestion = candidate;
      }
      setCheck(checkFromReason(callsign, result.availability.reason, suggestion));
    } catch {
      if (!controller.signal.aborted) setCheck({ status: "unchecked", callsign });
    }
  }, [getAccessToken]);

  const onChange = useCallback((input: string) => {
    const callsign = typedCallsign(input);
    setValue(callsign);
    clearTimeout(timer.current);
    request.current?.abort();
    const next = callsign === initial ? checkFromReason(callsign, null) : localCallsignCheck(callsign);
    setCheck(next);
    if (next.status === "checking") timer.current = setTimeout(() => void runCheck(callsign), CALLSIGN_CHECK_DELAY_MS);
  }, [initial, runCheck]);

  return { value, check, onChange, setCheck, ready: check.status === "available" && check.callsign === value };
}
