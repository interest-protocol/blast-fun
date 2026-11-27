import { normalizeSuiAddress } from "@mysten/sui/utils";
import { z } from "zod";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { SUI_ADDRESS_INPUT_PATTERN } from "@blast/core/lib/sui/ids.ts";
import { referralMonthSchema } from "@blast/core/modules/social/referrals/contracts.ts";
import { socialUuidSchema } from "@blast/core/modules/social/contracts/primitives.ts";
import { OperatorError } from "@blast/server/modules/mission-control/operator/errors.ts";
import { fullnodeTransferLookup } from "../coins/runtime.ts";
import type { TransferLookup } from "../coins/route.ts";
import { transferVerdict } from "../coins/transfers.ts";
import { socialOperatorCommand } from "../operator/framework.ts";
import { socialMainnetClient } from "../route-kit/shared-runtime.ts";

const address = z.string().regex(SUI_ADDRESS_INPUT_PATTERN).transform((value) => normalizeSuiAddress(value));
const paymentArgs = z.tuple([
  socialUuidSchema,
  referralMonthSchema,
  address,
  address,
  z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  z.string().regex(/^[1-9][0-9]{0,19}$/).refine((value) => BigInt(value) <= 18_446_744_073_709_551_615n),
]);

export function referralPaymentRecord(lookup: TransferLookup) {
  return socialOperatorCommand<z.infer<typeof paymentArgs>>({
    path: ["referral", "record"],
    usage: "referral record <account-id> <YYYY-MM> <sender> <recipient> <digest> <amount-in-mist> --reason <text>",
    reasonRequired: true,
    parse: (args) => {
      const parsed = paymentArgs.safeParse(args);
      return parsed.success && parsed.data[2] !== parsed.data[3] ? parsed.data : null;
    },
    run: async ([accountId, month, sender, recipient, digest, amount], { transaction }) => {
      const date = `${month}-01`;
      const payment = { month, recipient, digest, amount_atoms: amount };
      const parameters = [accountId, date, recipient, digest, amount];
      const match = `SELECT 1 FROM social_referral_payments WHERE account_id=$1 AND month=$2
        AND recipient=$3 AND digest=$4 AND amount_atoms=$5`;
      const outcome = (recorded: boolean) => ({
        result: { ...payment, recorded },
        log: { action: "referral.record", target: `${accountId}/${month}`, before: recorded ? null : payment, after: payment },
      });

      const { rows: [period] } = await transaction.read<{ closed: boolean; owns_wallet: boolean; already_recorded: boolean }>(
        `SELECT $2::date < date_trunc('month',now() AT TIME ZONE 'UTC') AS closed,
          EXISTS (SELECT 1 FROM social_wallet_owners WHERE account_id=$1 AND address=$3) AS owns_wallet,
          EXISTS (${match}) AS already_recorded`,
        parameters,
      );
      if (period?.already_recorded) return outcome(false);
      if (!period?.closed || !period.owns_wallet) throw new OperatorError("OPERATOR_INPUT_INVALID");

      const receipt = await lookup.executed(digest, AbortSignal.timeout(8_000));
      if (!receipt) throw new OperatorError("OPERATOR_TARGET_NOT_FOUND");
      if (transferVerdict({ sender, recipient, coin_type: SUI_COIN_TYPE, amount }, receipt).status !== "confirmed") {
        throw new OperatorError("OPERATOR_INPUT_INVALID");
      }

      const { rowCount } = await transaction.write("social_referral_payments",
        `INSERT INTO social_referral_payments (account_id,month,recipient,digest,amount_atoms)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        parameters,
      );
      if (rowCount === 1) return outcome(true);
      const { rows } = await transaction.read(match, parameters);
      if (!rows.length) throw new OperatorError("OPERATOR_CONFLICT");
      return outcome(false);
    },
  });
}

export const REFERRAL_PAYMENT_RECORD = referralPaymentRecord(
  fullnodeTransferLookup(() => socialMainnetClient("social.referral-payment")),
);
