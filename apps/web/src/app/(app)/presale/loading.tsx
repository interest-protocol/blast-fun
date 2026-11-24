"use client";

import { useParams } from "next/navigation";

import { PresalesLoading } from "#web/components/presale-pages/PresalesLoading.tsx";
import { SaleLoading } from "#web/components/presale-pages/SaleLoading.tsx";

/** The sales layout reads request flags; its fallback must sit above it. */
export default function Loading() {
  return useParams().presaleId ? <SaleLoading /> : <PresalesLoading />;
}
