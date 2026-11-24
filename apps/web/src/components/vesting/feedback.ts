import { ZodError } from "zod";

/** Keep asynchronous wallet failures in the review that initiated them. */
export async function reportVestingAction(
  work: () => Promise<void>,
  onError: (message: string) => void,
  onSettled?: () => void,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      onError(
        `Check ${issue?.path.join(" ") || "the schedule"}: ${issue?.message || "invalid value"}`,
      );
    } else
      onError(
        error instanceof Error
          ? error.message
          : "Unable to complete the vesting transaction.",
      );
  } finally {
    onSettled?.();
  }
}
