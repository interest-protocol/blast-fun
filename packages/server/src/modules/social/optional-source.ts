import { errorLabel, observeMetric } from "@blast/core/lib/metrics.ts";

export async function optionalSource<Value>(
  source: string,
  read: () => Promise<Value>,
  unavailable: Value,
): Promise<Value> {
  try {
    return await read();
  } catch (error) {
    observeMetric("social.source", {
      source,
      outcome: "unavailable",
      error: errorLabel(error),
    });
    return unavailable;
  }
}
