import type { PresaleShellProps } from "../providers/slot";
import { PresaleProviders } from "../providers/PresaleProviders";
import { HeaderSlot } from "./HeaderSlot";
import { HeadSlot } from "./HeadSlot";

/** Every presale page: the provider root, then HeadSlot, HeaderSlot and the page. */
export function PresaleShell({ config, nonce, children }: PresaleShellProps) {
  return (
    <PresaleProviders config={config} nonce={nonce}>
      <HeadSlot config={config} nonce={nonce} />
      <HeaderSlot config={config} nonce={nonce} />
      {children}
    </PresaleProviders>
  );
}
