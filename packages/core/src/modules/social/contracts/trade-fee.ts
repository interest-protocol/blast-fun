import { z } from "zod";

import { financialAtomsSchema } from "./financial-wire.ts";

/** Additional fields of a sponsorship_unavailable refusal; its diagnostic fields remain intact. */
export const socialTradeFeeFieldsSchema = z.looseObject({
  fee_mist: financialAtomsSchema,
  required_mist: financialAtomsSchema.optional(),
});
