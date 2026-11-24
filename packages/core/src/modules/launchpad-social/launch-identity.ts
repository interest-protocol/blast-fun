import type { LaunchLifecycle } from "@blast/core/modules/launchpad-contract/discovery-views.ts";

/**
 * A canonical launch's identity as the chain views publish it, read at query
 * time and never stored with a social row: its coin's type and Coin Registry
 * metadata (`c`), its curve's lifecycle and creation time (`p`), and the
 * coin's creator. The query names the launch ID `launch_id`.
 */
export type LaunchIdentity = Readonly<{
  launchId: string;
  coinType: string;
  /** Coin Registry metadata; null until the launch reports it. */
  name: string | null;
  symbol: string | null;
  iconUrl: string | null;
  /** The curve's lifecycle. */
  lifecycle: LaunchLifecycle;
  /** The authoritative creator recipient; null until registered or claimed. */
  creator: string | null;
  /** The curve's creation checkpoint time, Unix ms. */
  createdAtMs: number;
}>;
