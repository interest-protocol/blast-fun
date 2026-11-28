import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "#web/components/blast-ui/Button.tsx";
import { CopyAddress } from "#web/components/blast-ui/CopyAddress.tsx";
import { DiagnosticText } from "#web/components/blast-ui/DiagnosticText.tsx";
import { Sheet, SheetCta, SheetHeading } from "#web/components/blast-ui/Sheet.tsx";
import { diagnosticMessage } from "#web/lib/errors.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { useDebouncedValue } from "#web/lib/use-debounced-value.ts";

import { useAccountWallets, useWalletSuiName, walletSessionName } from "../account-wallets";
import { walletIdentityQuery } from "../queries";
import { switchWithWalletDraft, type WalletActionInput } from "./wallet-action-draft";
import { walletCoinBalanceQuery } from "./use-wallet-coin-balance";
import { withdrawalSwitchBlock } from "./withdraw-attempt";
import styles from "./coins.module.css";

const ZERO_ATOMS = 0n;

type Funds = Readonly<{ address: string; atoms: bigint }>;

export function useSwapWalletFunding(address: string | null | undefined, coinType: string, atoms: bigint | null, check: boolean) {
  const funding = useOtherWalletFunds(address, coinType, check && atoms !== null && atoms > ZERO_ATOMS);
  const qualifies = (funds: Funds) => atoms !== null && funds.atoms >= atoms;
  return { funding, qualifies, canSwitch: funding.funds !== null && qualifies(funding.funds) };
}

/** Read just the asset the other signer would spend. Blast sponsors both sign-in types. */
export function useOtherWalletFunds(activeAddress: string | null | undefined, coinType: string, check: boolean) {
  const client = useAppQueryClient();
  const wallets = useAccountWallets();
  const wantsCheck = !!activeAddress && check && wallets.hasOther;
  const stableCheck = useDebouncedValue(wantsCheck ? coinType : null, 300);
  const enabled = wantsCheck && stableCheck === coinType;
  const identity = walletIdentityQuery(wallets.otherScope, wallets.otherToken);
  const identityRead = useQuery({ ...identity, enabled, refetchOnWindowFocus: false }, client);
  const wallet = identityRead.isError ? undefined : identityRead.data;
  const otherAddress = enabled && wallet?.address !== activeAddress ? wallet?.address : null;
  const query = (address: string, coin: string) => ({
    ...walletCoinBalanceQuery(address, coin, wallets.otherToken),
    gcTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const input = useQuery({ ...query(otherAddress ?? "", coinType), enabled: !!otherAddress }, client);
  const suiName = useWalletSuiName(otherAddress);
  const funds: Funds | null = otherAddress && input.isSuccess
    ? { address: otherAddress, atoms: input.data.atoms }
    : null;

  return {
    funds,
    name: suiName ?? (wallets.otherSession === "privy" ? wallets.oauthName : walletSessionName(otherAddress)),
    async switchAccount(surface: string, draft: WalletActionInput, qualifies: (available: Funds) => boolean, canContinue: () => boolean) {
      if (!funds || withdrawalSwitchBlock()) return false;
      const target = await client.fetchQuery({ ...identity, staleTime: 0 });
      if (target.address !== funds.address) return false;
      const balance = await client.fetchQuery({ ...query(funds.address, coinType), staleTime: 0 });
      return canContinue()
        && qualifies({ address: funds.address, atoms: balance.atoms })
        && switchWithWalletDraft(surface, wallets.otherSession, funds.address, draft);
    },
  };
}

export function WalletFundingSwitch({ funding, qualifies, surface, draft, fallback }: Readonly<{
  funding: ReturnType<typeof useOtherWalletFunds>;
  qualifies: (available: Funds) => boolean;
  surface?: string;
  draft: WalletActionInput | null;
  fallback: ReactNode;
}>) {
  const id = useId();
  const cancelButton = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const offer = !!surface && draft !== null && funding.funds !== null && qualifies(funding.funds);
  const address = funding.funds?.address;
  useLayoutEffect(() => () => request.current?.abort(), []);

  function cancel() {
    request.current?.abort();
    request.current = null;
    setOpen(false);
    setPending(false);
  }

  async function confirm() {
    if (request.current || !offer || !draft || !surface) return;
    const attempt = new AbortController();
    request.current = attempt;
    setPending(true);
    setFailed(false);
    const current = () => request.current === attempt && !attempt.signal.aborted;
    const switched = await funding.switchAccount(surface, draft, qualifies, current).catch(() => false);
    if (!current() || switched) return;
    request.current = null;
    setPending(false);
    setFailed(true);
  }

  return (
    <>
      {offer || open ? <Button aria-haspopup="dialog" aria-expanded={open} disabled={!offer} onClick={() => { setFailed(false); setOpen(true); }} size="lg" variant="primary">
        Switch account
      </Button> : fallback}
      <Sheet describedBy={`${id}-lead`} hasCta initialFocus={() => cancelButton.current} labelledBy={id} onRequestClose={cancel} open={open}>
        <SheetHeading id={id} leadId={`${id}-lead`} title={`Switch to ${funding.name}?`}
          lead="Your draft stays open for review after switching." />
        {address ? <CopyAddress copyLabel="Copy wallet address" label="Wallet" value={address} /> : null}
        <SheetCta className={styles.walletSwitchCta}>
          <div className={styles.walletSwitchStatus} aria-live="polite">
            {failed ? <DiagnosticText message={diagnosticMessage("Couldn’t switch accounts. Check the balance and try again.", { code: "account_switch_failed" })} /> : null}
          </div>
          <Button ref={cancelButton} onClick={cancel} size="lg">Cancel</Button>
          <Button disabled={!offer || pending} loading={pending} loadingLabel="Switching accounts" onClick={() => void confirm()} size="lg" variant="primary">Switch account</Button>
        </SheetCta>
      </Sheet>
    </>
  );
}
