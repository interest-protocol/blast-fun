"use client";

import { useEffect, useState } from "react";

import { scheduleDelay } from "./schedule-delay.ts";

export function useDebouncedValue<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(() => value);
  useEffect(() => scheduleDelay(() => setSettled(() => value), delay), [value, delay]);
  return settled;
}
