import { useCallback, useEffect, useState } from "react";

const HINT_MS = 1600;
const KEY = "blast:chart-zoom-hint";
let shown = false;

/** The zoom hint shows once per browser session; true for the wheel that may show it. */
function claim(): boolean {
  if (shown) return false;
  shown = true;
  try {
    if (sessionStorage.getItem(KEY)) return false;
    sessionStorage.setItem(KEY, "1");
  } catch {
    // Without storage the hint still shows, once per page.
  }
  return true;
}

/**
 * "Ctrl + scroll to zoom": shown by the first plain wheel of the session, hidden after
 * a moment. The timer lives here, apart from the chart's mount, so a chart that
 * re-mounts on a live candle cannot strand the hint on screen.
 */
export function useZoomHint() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => setVisible(false), HINT_MS);
    return () => clearTimeout(timer);
  }, [visible]);
  const show = useCallback(() => {
    if (claim()) setVisible(true);
  }, []);
  const hide = useCallback(() => setVisible(false), []);
  return { visible, show, hide };
}
