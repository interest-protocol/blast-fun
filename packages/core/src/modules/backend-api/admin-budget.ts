/** Recognition includes checkout, lock wait, snapshots, publication and SQL completion. */
export const PARTNER_ADMIN_OPERATION_MS = 8_000;
export const PARTNER_ADMIN_HTTP_MS = PARTNER_ADMIN_OPERATION_MS + 1_000;
/** The independent admin-console relay allows one further second for its network hop. */
export const PARTNER_ADMIN_RELAY_MS = PARTNER_ADMIN_HTTP_MS + 1_000;
