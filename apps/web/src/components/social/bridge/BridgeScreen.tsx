"use client";

import clsx from "clsx";
import { Component, lazy, Suspense, useState, type ReactNode } from "react";

import { Button } from "#web/components/blast-ui/Button.tsx";
import { DiagnosticText } from "#web/components/blast-ui/DiagnosticText.tsx";

import coinStyles from "../coins/coins.module.css";

import type { BridgeCardProps } from "./BridgeCard.tsx";
import { BridgeLoading } from "./BridgeLoading.tsx";
import { LOAD_FAILED_TEXT } from "./bridge-model.ts";
import styles from "./bridge.module.css";

// The Mayan SDK, ethers and web3.js load only when someone opens Bridge to Sui.
const loadCard = () => import("./BridgeCard.tsx");
// Shared across visits, so a reopened card does not suspend again.
let lazyCard = lazy(loadCard);

export function BridgeScreen(props: BridgeCardProps) {
  const [BridgeCard, setBridgeCard] = useState(() => lazyCard);
  // React keeps a failed lazy load and throws it again, so a retry needs a new one.
  const retry = () => {
    lazyCard = lazy(loadCard);
    setBridgeCard(() => lazyCard);
  };
  return (
    <ChunkBoundary onRetry={retry}>
      <Suspense fallback={<BridgeLoading />}>
        <BridgeCard {...props} />
      </Suspense>
    </ChunkBoundary>
  );
}

/** A failed download (offline, a new deploy) or render stays inside the card, with a way to try again. */
class ChunkBoundary extends Component<Readonly<{ onRetry: () => void; children: ReactNode }>, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Bridge to Sui failed to load", error);
  }

  retry = () => {
    this.props.onRetry();
    this.setState({ failed: false });
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className={styles.form}>
        <p className={clsx(coinStyles.status, styles.note)} role="alert"><DiagnosticText message={LOAD_FAILED_TEXT} /></p>
        <Button onClick={this.retry} size="lg" variant="secondary">Try again</Button>
      </div>
    );
  }
}
