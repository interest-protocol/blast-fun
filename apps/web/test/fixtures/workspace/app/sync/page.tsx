"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SyncFixture } from "../../sync/SyncFixture";
import { CapacityProbe } from "../../capacity/CapacityProbe";
export default function Page() {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <SyncFixture />
      <CapacityProbe />
    </QueryClientProvider>
  );
}
