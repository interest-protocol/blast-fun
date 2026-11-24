import { Button } from "#web/components/blast-ui/Button.tsx";
import type { useViewerPresalesRead } from "./presales-client";

export function ViewerPositionFeedback({ read }: Readonly<{ read: ReturnType<typeof useViewerPresalesRead> }>) {
  if (read.status === "loading") return <span className="sr" role="status" aria-label="Loading your position" />;
  if (read.status !== "error") return null;
  return <div role="alert">
    <p>{read.data ? "Your position could not refresh. Showing previous details." : "Your position could not load. Balances and claims are unavailable."}</p>
    <Button size="sm" onClick={read.retry}>Try again</Button>
  </div>;
}
