import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AccountActivity } from "#web/components/analytics/AccountActivity.tsx";

declare global {
  interface Window {
    activityFixture: {
      signals: { type: string; trusted: boolean }[];
      stop(): void;
    };
  }
}

const root = createRoot(document.getElementById("root")!);
const signals: { type: string; trusted: boolean }[] = [];
document.addEventListener("pointerdown", (event) =>
  signals.push({ type: event.type, trusted: event.isTrusted }),
);
document.addEventListener("keydown", (event) =>
  signals.push({ type: event.type, trusted: event.isTrusted }),
);
function render(enabled: boolean) {
  root.render(
    <StrictMode>
      <h1>Account activity fixture</h1>
      <button type="button">Activity target</button>
      <label>
        Keyboard target
        <input aria-label="Keyboard target" />
      </label>
      {enabled && (
        <AccountActivity
          session={{
            accountId: "fixture-account-only-local",
            identity: "wallet",
            mode: "wallet",
          }}
        />
      )}
    </StrictMode>,
  );
}
Object.assign(window, {
  activityFixture: { signals, stop: () => render(false) },
});
render(true);
