import { CopyAddress } from "./CopyAddress";

export function CoinTypeTag({ coinType }: Readonly<{ coinType: string | null | undefined }>) {
  if (!coinType) return null;

  return (
    <span data-coin-type-tag="">
      <CopyAddress value={coinType} label="Address" copyLabel="Copy full coin address" />
    </span>
  );
}
