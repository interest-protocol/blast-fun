"use client";

import { useEffect, useState } from "react";
import { useShellActions } from "../../../src/components/blast-ui/shell-actions.tsx";
import { useWorkspace } from "../../../src/components/social/blast-mode/workspace/workspace-context.ts";
import { startWorkspaceLiveRead, workspaceLiveClock } from "../../../src/components/social/blast-mode/workspace/live-read.ts";
import { tabsProbe, setFixtureDataPosition } from "./tabs-probe";
import type { PanelSetup } from "@blast/core/modules/social/blast-workspace/setup.ts";

export function FixturePanel({ panel }: Readonly<{ panel: PanelSetup }>) {
  const { dispatch } = useWorkspace();
  return (
    <>
      <h2>Simulated asset {panel.panel_id}</h2>
      <label>
        Draft amount {panel.panel_id}
        <input
          value={panel.coin.trade.buy.typed}
          onInput={(event) =>
            dispatch.patchPanel(panel.panel_id, {
              coin: {
                ...panel.coin,
                trade: {
                  ...panel.coin.trade,
                  buy: { typed: event.currentTarget.value, mode: "typed" },
                },
              },
            })
          }
        />
      </label>
      <button
        className="btn btn-quiet"
        onClick={() => dispatch.remove(panel.panel_id)}
        type="button"
      >
        Remove {panel.panel_id}
      </button>
    </>
  );
}

export function FixtureData() {
  const { snapshot, dispatch } = useWorkspace();
  const view = snapshot.data.selected_view!;
  const controls = snapshot.data.controls[view];
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const probe = tabsProbe();
    probe.start(view);
    const stop = startWorkspaceLiveRead({
      clock: workspaceLiveClock,
      intervalMs: 1000,
      read: (signal) => probe.read(view, signal),
      receive: (result) => { probe.accept(view); setReady(result.status === "ready"); },
    });
    return () => { stop(); probe.stop(view); };
  }, [view]);
  return (
    <div>
      <p>Simulated {view} Data adapter · No market requests</p>
      <p role="status">{ready ? "Controlled read ready" : "Controlled read pending"}</p>
      <label>
        Saved {view} position
        <input
          aria-label={`Saved ${view} position`}
          type="number"
          min={0}
          value={controls.navigation.scroll_top}
          onChange={(event) => {
            const value = event.currentTarget.valueAsNumber;
            if (Number.isFinite(value) && value >= 0) setFixtureDataPosition(dispatch, view, value);
          }}
        />
      </label>
    </div>
  );
}

export function FixtureControls() {
  const run = useShellActions();
  const { snapshot, dispatch, presentation, entry_generation } = useWorkspace();
  useEffect(() => { tabsProbe().setup(snapshot); }, [snapshot]);
  useEffect(() => {
    const timer = window.setInterval(() => tabsProbe().tickShell(), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const probe = window as unknown as {
      workspaceFixtureMounts?: number;
      workspaceFixtureUnmounts?: number;
    };
    probe.workspaceFixtureMounts = (probe.workspaceFixtureMounts ?? 0) + 1;
    return () => {
      probe.workspaceFixtureUnmounts =
        (probe.workspaceFixtureUnmounts ?? 0) + 1;
    };
  }, []);
  return (
    <div>
      <span>Fixture generation {entry_generation}</span>{" "}
      <button
        className="btn btn-quiet btn-sm"
        onClick={() => run("openSignIn")}
        type="button"
      >
        Open sign-in simulation
      </button>{" "}
      <button
        className="btn btn-quiet btn-sm"
        onClick={() => {
          for (const view of snapshot.data.enabled_views)
            dispatch.setDataViewEnabled(view, false);
        }}
        type="button"
      >
        Hide all Data views
      </button>
      {snapshot.visible_order.map((id) => (
        <button
          className="btn btn-quiet btn-sm"
          key={id}
          onClick={() => dispatch.selectMobile(id)}
          type="button"
        >
          Select {id}
        </button>
      ))}
      <output
        style={{ display: "block", overflowWrap: "anywhere" }}
        aria-label="Presentation facts"
      >
        {JSON.stringify(presentation)}
      </output>
    </div>
  );
}
