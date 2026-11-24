"use client";

// Development harness for the Theses destination against this dev server's
// real routes: GET/POST /api/launchpad/theses, Wallet Proof challenges and
// the CSRF cookie. Posting needs the dev server's launchpad runtime (rate
// and subject peppers, a database with the chain views); a Privy post needs
// a token from the fixture Privy the server's Privy settings name. Fixture
// wallets sign personal messages with test keys; nothing signs a transaction.

import { useEffect, useRef, useState } from "react";

import styles from "../transaction/TransactionHarness.module.css";
import { LaunchpadSignerProvider } from "#web/components/launchpad/transaction/LaunchpadSignerProvider.tsx";
import type { RegisterSignerBridge } from "#web/components/launchpad/transaction/launchpad-signer-provider-model.ts";
import type { LaunchpadSigner } from "#web/components/launchpad/transaction/signer.ts";
import { THESES_FIXTURE_WALLETS, thesesFixturePrivy, thesesFixtureWallet, type FixtureWallet } from "./theses-fixtures.ts";
import { ThesesBoard } from "#web/components/launchpad/theses/ThesesBoard.tsx";
import { ThesisComposer } from "#web/components/launchpad/theses/ThesisComposer.tsx";

type Controls = { privyToken: string; privyWallet: string; wallet: FixtureWallet };

function FixtureBridge({ register, controls }: Readonly<{ register: RegisterSignerBridge; controls: { current: Controls } }>) {
  useEffect(() => {
    let connected: LaunchpadSigner | null = null;
    register({
      current: () => connected,
      async connect(kind) {
        const { privyToken, privyWallet, wallet } = controls.current;
        connected = kind === "privy" ? thesesFixturePrivy(privyToken.trim() || null, privyWallet.trim()) : thesesFixtureWallet(wallet);
        return connected;
      },
    });
    return () => register(null);
  }, [controls, register]);
  return null;
}

export function ThesesHarness({ launchId }: Readonly<{ launchId: string }>) {
  const [controls, setControls] = useState<Controls>({ privyToken: "", privyWallet: `0x${"42".repeat(32)}`, wallet: "creator" });
  // The bridge reads the latest controls when a post connects a signer.
  const latest = useRef(controls);
  useEffect(() => {
    latest.current = controls;
  }, [controls]);
  const set = (change: Partial<Controls>) => setControls((current) => ({ ...current, ...change }));

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Thesis fixtures</h1>
      <p className={styles.note}>
        Development only. Launch <code>{launchId}</code> (set <code>?launchId=</code>). Posts go to this server&apos;s real
        routes and database.
      </p>
      <div className={styles.controls}>
        <label className={styles.control}>
          <span className={styles.controlLabel}>Privy session token</span>
          <input className={styles.select} value={controls.privyToken} onChange={(event) => set({ privyToken: event.target.value })} />
        </label>
        <label className={styles.control}>
          <span className={styles.controlLabel}>Privy embedded wallet</span>
          <input className={styles.select} value={controls.privyWallet} onChange={(event) => set({ privyWallet: event.target.value })} />
        </label>
        <label className={styles.control}>
          <span className={styles.controlLabel}>Fixture wallet</span>
          <select className={styles.select} value={controls.wallet} onChange={(event) => set({ wallet: event.target.value as FixtureWallet })}>
            <option value="creator">Creator wallet {THESES_FIXTURE_WALLETS.creator}</option>
            <option value="other">Other wallet {THESES_FIXTURE_WALLETS.other}</option>
          </select>
        </label>
      </div>
      <section className={styles.panel} aria-labelledby="theses-heading">
        <h2 id="theses-heading" className={styles.heading}>Thesis</h2>
        <ThesesBoard
          launchId={launchId}
          symbol={null}
          composer={(onPublished) => (
            <LaunchpadSignerProvider kinds={["privy", "wallet"]} renderBridge={(register) => <FixtureBridge register={register} controls={latest} />}>
              <ThesisComposer launchId={launchId} onPublished={onPublished} />
            </LaunchpadSignerProvider>
          )}
        />
      </section>
    </div>
  );
}
