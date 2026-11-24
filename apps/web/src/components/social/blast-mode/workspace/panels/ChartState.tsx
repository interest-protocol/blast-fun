import { Button } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import styles from "./CoinChartVisual.module.css";

const TITLES = {
  empty: "No recorded prices in this range",
  "no-history": "No price history yet",
  unavailable: "Price history unavailable",
  error: "Price history could not load",
  sparse: "Not enough price history",
} as const;

/**
 * Same plot frame for pending, empty, unavailable and failed reads. Each offers at most one
 * primary recovery action: a longer range for an empty window or Retry for a failed read.
 */
export function ChartState({ state, retry, onAll, range }: Readonly<{ state: "loading" | keyof typeof TITLES; retry?: () => void; onAll?: () => void; range?: string }>) {
  if (state === "loading") return <div className={styles.empty} data-chart-empty="loading" role="status" aria-label="Loading price history"><SkeletonText>Price history and observations</SkeletonText></div>;
  const action = state === "empty" || state === "sparse"
    ? onAll && <Button variant="secondary" size="sm" type="button" onClick={onAll}>View all history</Button>
    : state === "error" && retry && <Button variant="secondary" size="sm" type="button" aria-label="Retry price history" onClick={retry}>Retry</Button>;
  return <div className={styles.empty} data-chart-empty={state}>
    <EmptyState action={action} compact role={state === "error" ? "alert" : "status"} title={state === "sparse" && range ? `${TITLES.sparse} for ${range}` : TITLES[state]} />
  </div>;
}
