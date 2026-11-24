import type { bcs } from "@mysten/sui/bcs";

type ProgrammableTransaction = NonNullable<(typeof bcs.TransactionKind.$inferType)["ProgrammableTransaction"]>;
type Argument = NonNullable<ProgrammableTransaction["commands"][number]["MoveCall"]>["arguments"][number];

/** What a Move-call argument is: an input of one kind, or an earlier command's result. */
export type SponsorArgumentKind = "pure" | "shared" | "owned" | "receiving" | "withdrawal" | "result" | "gas";

const DESCRIPTIONS: Record<SponsorArgumentKind, string> = {
  pure: "a pure value",
  shared: "a shared object",
  owned: "an owned object",
  receiving: "a Receiving object",
  withdrawal: "a funds withdrawal",
  result: "a result",
  gas: "the gas coin",
};

export function argumentKind(inputs: ProgrammableTransaction["inputs"], argument: Argument): SponsorArgumentKind {
  switch (argument.$kind) {
    case "GasCoin":
      return "gas";
    case "Result":
    case "NestedResult":
      return "result";
    case "Input": {
      const input = inputs[argument.Input];
      if (input?.Pure) return "pure";
      if (input?.FundsWithdrawal) return "withdrawal";
      if (input?.Object?.SharedObject) return "shared";
      if (input?.Object?.Receiving) return "receiving";
      return "owned";
    }
  }
}

export function describeArgumentKind(kind: SponsorArgumentKind): string {
  return DESCRIPTIONS[kind];
}
