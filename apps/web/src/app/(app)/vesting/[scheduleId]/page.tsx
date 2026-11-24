import { VestingReadError } from "@blast/core/modules/vesting/errors.ts";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { VestingDetail } from "#web/components/vesting/VestingDetail.tsx";
import { readVestingFromBackend } from "#web/lib/backend-api/vesting.ts";
import { vestingPath } from "@blast/core/modules/vesting/model.ts";
import { SITE_ORIGIN } from "#web/lib/site.ts";
const load = cache(readVestingFromBackend);
type Props = Readonly<{ params: Promise<{ scheduleId: string }> }>;
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { scheduleId } = await params;
  try {
    const { schedule } = await load(scheduleId),
      title = `${schedule.coin_symbol ?? "Coin"} vesting · Blast`;
    const description = `Public ${schedule.terms.kind === "linear" ? "regular" : "custom-date"} vesting schedule on Sui. ${schedule.refund_recipient ? "Cancelable" : "Irrevocable"}. Status: ${schedule.status}.`;
    return {
      title,
      description,
      alternates: { canonical: `${SITE_ORIGIN}${vestingPath(scheduleId)}` },
      openGraph: {
        title,
        description,
        url: `${SITE_ORIGIN}${vestingPath(scheduleId)}`,
      },
    };
  } catch {
    return { title: "Vesting · Blast", robots: { index: false } };
  }
}
export default async function VestingPage({ params }: Props) {
  const { scheduleId } = await params;
  const result = await load(scheduleId).then(
    (detail) => ({ detail, error: null }),
    (error: unknown) => ({ detail: null, error }),
  );
  if (result.detail) return <VestingDetail initial={result.detail} />;
  const { error } = result;
  if (error instanceof VestingReadError && error.reason === "not_found")
    notFound();
  return (
    <EmptyState
      action={<a className="btn btn-line" href={`/vesting/${scheduleId}`}>Retry</a>}
      framed
      role="alert"
      heading={1}
      title="Vesting unavailable"
    >
      {error instanceof VestingReadError && error.reason === "unsupported"
        ? "This object is not a supported Blast vesting schedule."
        : "Schedule history unavailable. Try again shortly."}
    </EmptyState>
  );
}
