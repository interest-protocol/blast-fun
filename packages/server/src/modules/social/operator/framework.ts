import { z } from "zod";
import { DatabaseError } from "pg";

import type {
  ModuleTransaction,
  TransactionContext,
  TransactionOptions,
} from "@blast/core/modules/database/transaction.ts";
import type { AuthorizedOperator } from "@blast/server/modules/mission-control/operator/auth.ts";
import { OperatorError } from "@blast/server/modules/mission-control/operator/errors.ts";

/**
 * The social operator command framework behind `npm run social:operator`.
 * A command is a word path (`config set`), a parser for the remaining
 * arguments and a body that runs inside one primary transaction as the
 * `social` module. The framework appends exactly one `social_operator_log`
 * row in that same transaction, so a command either changes state and logs
 * once, or is refused and changes nothing. Later tickets add commands by
 * appending to `SOCIAL_OPERATOR_COMMANDS` (commands.ts).
 *
 * A batched command (`runBatches`, such as `backfill`) instead runs bounded
 * batches, each in its own transaction that commits when the batch returns,
 * so no lock is held for the whole run. Its single log row is appended in a
 * transaction of its own after the last batch. If a batch fails after
 * earlier ones committed, the framework logs what they did (the last
 * `progress` entry) before reporting the failure.
 */

/** What one command did, for its `social_operator_log` row. `before`/`after` are JSON or null. */
export type SocialOperatorLogEntry = Readonly<{
  action: string;
  target: string;
  before: unknown;
  after: unknown;
}>;

export type SocialOperatorContext = Readonly<{
  operator: AuthorizedOperator;
  transaction: ModuleTransaction<"social">;
  /** The operator's `--reason`, or null. */
  reason: string | null;
}>;

export type SocialOperatorOutcome = Readonly<{
  /** Printed as the command's JSON result. */
  result: unknown;
  log: SocialOperatorLogEntry;
}>;

/** Runs one batch in its own primary transaction, committed when the batch returns. */
export type SocialOperatorBatchRunner = <Result>(
  batch: (transaction: ModuleTransaction<"social">) => Promise<Result>,
) => Promise<Result>;

export type SocialOperatorBatchContext = Readonly<{
  operator: AuthorizedOperator;
  reason: string | null;
  batch: SocialOperatorBatchRunner;
  /** Records what the committed batches did so far; logged if a later batch fails. */
  progress(entry: SocialOperatorLogEntry): void;
}>;

type SocialOperatorCommandWords<Input> = Readonly<{
  /** The words that select the command, such as `["config", "set"]`. */
  path: readonly string[];
  /** One usage line, without the `npm run social:operator --` prefix. */
  usage: string;
  /** The input from the arguments after the path, or null to refuse them. */
  parse(args: readonly string[]): Input | null;
  /**
   * The command changes a judgement someone must account for (R3-23's trust
   * flags; T-023's moderation): it is refused as `OPERATOR_INPUT_INVALID`
   * without a `--reason`, before anything runs, so its log row always says why.
   */
  reasonRequired?: boolean;
}>;

export type SocialOperatorCommand<Input = unknown> = SocialOperatorCommandWords<Input> &
  (
    | Readonly<{ run(input: Input, context: SocialOperatorContext): Promise<SocialOperatorOutcome>; runBatches?: never }>
    | Readonly<{
        runBatches(input: Input, context: SocialOperatorBatchContext): Promise<SocialOperatorOutcome>;
        run?: never;
      }>
  );

/** Types a command's parser and body together, then erases its input type for the command list. */
export function socialOperatorCommand<Input>(command: SocialOperatorCommand<Input>): SocialOperatorCommand {
  return command as SocialOperatorCommand;
}

export type SocialOperatorInvocation = Readonly<{
  command: SocialOperatorCommand;
  input: unknown;
  reason: string | null;
}>;

const REASON_FLAG = "--reason";
const MAX_REASON_LENGTH = 500;

function invalid(): OperatorError {
  return new OperatorError("OPERATOR_INPUT_INVALID");
}

function reasonFrom(args: readonly string[]): { rest: string[]; reason: string | null } {
  const index = args.indexOf(REASON_FLAG);
  if (index < 0) return { rest: [...args], reason: null };
  const reason = args[index + 1]?.trim();
  const parsed = z.string().min(1).max(MAX_REASON_LENGTH).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)).safeParse(reason);
  if (!parsed.success) throw invalid();
  const rest = [...args.slice(0, index), ...args.slice(index + 2)];
  if (rest.includes(REASON_FLAG)) throw invalid();
  return { rest, reason: parsed.data };
}

/**
 * The command `argv` names and its parsed input. An optional
 * `--reason <text>` (1 to 500 characters) may appear anywhere after the path;
 * a `reasonRequired` command is refused without one. Anything else the
 * command does not accept is refused as `OPERATOR_INPUT_INVALID`.
 */
export function parseSocialOperatorInvocation(
  argv: readonly string[],
  commands: readonly SocialOperatorCommand[],
): SocialOperatorInvocation {
  const command = commands.find((candidate) => candidate.path.every((word, index) => argv[index] === word));
  if (!command) throw invalid();
  const { rest, reason } = reasonFrom(argv.slice(command.path.length));
  if (command.reasonRequired && reason === null) throw invalid();
  const input = command.parse(rest);
  if (input === null) throw invalid();
  return { command, input, reason };
}

/** Appends one `social_operator_log` row and returns its `log_id`. */
export async function appendSocialOperatorLog(
  transaction: ModuleTransaction<"social">,
  operator: AuthorizedOperator,
  entry: SocialOperatorLogEntry,
  reason: string | null,
): Promise<string> {
  const { rows } = await transaction.write<{ log_id: string }>(
    "social_operator_log",
    `INSERT INTO social_operator_log (operator_id, action, target, before, after, reason)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
     RETURNING log_id`,
    [
      operator.operatorId,
      entry.action,
      entry.target,
      entry.before === null || entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === null || entry.after === undefined ? null : JSON.stringify(entry.after),
      reason,
    ],
  );
  return rows[0].log_id;
}

export type SocialOperatorResult = Readonly<{
  command: string;
  logId: string;
  result: unknown;
}>;

/** Runs a transaction on the primary; the CLI passes `withTransaction` over its pool. */
export type RunInTransaction = <Result>(
  operation: (transaction: TransactionContext) => Promise<Result>,
  options?: Pick<TransactionOptions, "retry" | "timeouts">,
) => Promise<Result>;

/**
 * Each batch of a batched command: re-run whole after a deadlock or lock
 * timeout (everything it does is inside its transaction), and bounded so no
 * batch waits on or holds a lock for long.
 */
export const SOCIAL_OPERATOR_BATCH_TRANSACTION = Object.freeze({
  retry: true,
  timeouts: Object.freeze({ lockTimeoutMs: 5_000, statementTimeoutMs: 60_000 }),
});

/**
 * Runs one parsed invocation as `operator`: the command's body and its log
 * row in one transaction. A database refusal of the input (a CHECK or a
 * malformed value) is reported as `OPERATOR_INPUT_INVALID`.
 */
export async function runSocialOperatorInvocation(
  invocation: SocialOperatorInvocation,
  operator: AuthorizedOperator,
  runInTransaction: RunInTransaction,
): Promise<SocialOperatorResult> {
  try {
    if (invocation.command.runBatches) {
      return await runBatchedInvocation(invocation, operator, runInTransaction);
    }
    const run = invocation.command.run;
    return await runInTransaction(async (context) => {
      const transaction = context.forModule("social");
      const outcome = await run(invocation.input, {
        operator,
        transaction,
        reason: invocation.reason,
      });
      const logId = await appendSocialOperatorLog(transaction, operator, outcome.log, invocation.reason);
      return { command: invocation.command.path.join(" "), logId, result: outcome.result };
    });
  } catch (error) {
    if (error instanceof DatabaseError && (error.code === "23514" || error.code?.startsWith("22"))) throw invalid();
    throw error;
  }
}

async function runBatchedInvocation(
  invocation: SocialOperatorInvocation,
  operator: AuthorizedOperator,
  runInTransaction: RunInTransaction,
): Promise<SocialOperatorResult> {
  const runBatches = invocation.command.runBatches;
  if (!runBatches) throw new Error("The command is not batched.");
  const log = (entry: SocialOperatorLogEntry) =>
    runInTransaction((context) =>
      appendSocialOperatorLog(context.forModule("social"), operator, entry, invocation.reason));
  let committed: SocialOperatorLogEntry | null = null;
  let outcome: SocialOperatorOutcome;
  try {
    outcome = await runBatches(invocation.input, {
      operator,
      reason: invocation.reason,
      batch: (batch) =>
        runInTransaction((context) => batch(context.forModule("social")), SOCIAL_OPERATOR_BATCH_TRANSACTION),
      progress: (entry) => {
        committed = entry;
      },
    });
  } catch (error) {
    const partial: SocialOperatorLogEntry | null = committed;
    // Best effort: the batch's failure is what the operator must see.
    if (partial) await log(partial).catch(() => undefined);
    throw error;
  }
  return { command: invocation.command.path.join(" "), logId: await log(outcome.log), result: outcome.result };
}
