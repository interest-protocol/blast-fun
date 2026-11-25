/** The review's outcomes, apart from the send path so screens can match them without loading the node client. */

/** Execution stopped before submission; a fresh review can safely replace these bytes. */
export class VestingReviewRequiredError extends Error {}

/** Submission may have reached the network. Only reconcile the original digest. */
export class VestingSubmissionPendingError extends Error {}
