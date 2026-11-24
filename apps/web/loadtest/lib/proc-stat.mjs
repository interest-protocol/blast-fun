/** Decode the fields used for benchmark accounting; command names may contain spaces and parentheses. */
export function parseProcStat(text) {
  const closing = text.lastIndexOf(") ");
  if (closing < 0) throw new Error("Invalid process stat record");
  const fields = text.slice(closing + 2).trim().split(/\s+/);
  const parent = Number(fields[1]);
  const userTicks = Number(fields[11]);
  const systemTicks = Number(fields[12]);
  const cpu = userTicks + systemTicks;
  if (fields.length < 13 || ![parent, userTicks, systemTicks, cpu].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("Invalid process stat counters");
  }
  return { parent, cpu };
}
