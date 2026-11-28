export const FEEDBACK_KINDS = ["feature_request", "feedback"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_MESSAGE_LIMIT = 1_000;

export const FEEDBACK_BODY_LIMIT = 6_144;
