"use client";

import { WalletIcon } from "#web/components/blast-ui/Icons.tsx";
import { DiagnosticText } from "#web/components/blast-ui/DiagnosticText.tsx";
import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import { SUI_ADDRESS_PLACEHOLDER, SUI_NAME_LOOKUP_LABEL, useSuiAddressLookup } from "#web/lib/sui-address-input.ts";
import type { CreationInput } from "./creation-model";
import styles from "./Creation.module.css";

type AddressField = "beneficiary" | "refund" | "capRecipient";
export function WalletAddressField({
  form,
  field,
  label,
  help,
}: Readonly<{
  form: {
    draft: CreationInput;
    wallet: { wallet: string | null };
    update(patch: Partial<CreationInput>): void;
    touch(field: string): void;
    issue: { field: string; message: string } | null;
  };
  field: AddressField;
  label: string;
  help: string;
}>) {
  const address = form.wallet.wallet;
  const value = form.draft[field];
  const destination = useSuiAddressLookup(value, (resolved) => form.update({ [field]: resolved }));
  const findingAddress = destination.status === "pending";
  const own = !!address && value.trim().toLowerCase() === address.toLowerCase();
  const error = destination.name ? destination.error : form.issue?.field === field ? form.issue.message : null;
  const short = (text: string) => `${text.slice(0, 8)}…${text.slice(-6)}`;
  return (
    <div className={styles.walletField}>
      <div className={styles.walletLabel}>
        <label htmlFor={`vesting-${field}`}>{label}</label>
        <button
          type="button"
          className="btn btn-line btn-sm"
          disabled={!address}
          title={
            address
              ? `Fill ${label} with ${address}`
              : "Connect a wallet to fill this address"
          }
          onClick={() => {
            destination.invalidate();
            form.update({ [field]: address! });
          }}
        >
          <WalletIcon /> Use connected wallet
        </button>
      </div>
      <input
        id={`vesting-${field}`}
        value={value}
        onChange={(event) => {
          destination.invalidate();
          form.update({ [field]: event.target.value });
        }}
        onBlur={(event) => {
          destination.lookup(event.currentTarget.value);
          form.touch(field);
        }}
        onKeyDown={destination.onKeyDown}
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
        placeholder={SUI_ADDRESS_PLACEHOLDER}
        aria-invalid={!!error || undefined}
        aria-describedby={`vesting-${field}-help${error ? ` vesting-${field}-error` : ""}`}
      />
      <p id={`vesting-${field}-help`}>
        {own ? (
          <span className={styles.ownWallet} title={address!}>
            Your wallet · {short(address!)}.{" "}
          </span>
        ) : null}
        {help}
        {findingAddress ? <> <LoadingIndicator label={SUI_NAME_LOOKUP_LABEL} /></> : null}
      </p>
      <span aria-live="polite" className={error ? styles.fieldError : undefined} hidden={!error} id={`vesting-${field}-error`}>
        {error ? <DiagnosticText message={error} /> : null}
      </span>
      <span className="sr-only" role="status">{destination.confirmation}</span>
    </div>
  );
}
