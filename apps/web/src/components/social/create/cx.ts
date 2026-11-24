import { scopedCx } from "#web/components/ui-libraries/scoped-cx.ts";

import styles from "./create.module.css";

/**
 * Class names for the Create page: each name the module defines becomes its
 * scoped class plus the plain name (so the shared global rules such as
 * `.card`, `.btn`, `.seg` still apply); any other name passes through.
 * Falsy parts drop. Joined by clsx (OA-28 M6).
 */
export const cx = scopedCx(styles);
