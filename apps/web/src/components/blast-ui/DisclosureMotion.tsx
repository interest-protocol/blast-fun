"use client";

import { useEffect } from "react";
import { installDisclosureMotion } from "./disclosure-motion";

export function DisclosureMotion() {
  useEffect(() => installDisclosureMotion(document), []);
  return null;
}
