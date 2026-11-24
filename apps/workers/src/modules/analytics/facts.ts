// Source-neutral warehouse input. No source connection or collector runs here.
export type Fact = Readonly<{
  fact_id: string;
  checkpoint: string;
  timestamp_ms: string;
  digest: string | null;
  actor: string | null;
  kind: string;
  coin_type: string | null;
  usd_value: string | null;
  quote_type?: string | null;
  quote_amount?: string | null;
}>;
