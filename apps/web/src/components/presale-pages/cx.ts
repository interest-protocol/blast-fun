import { scopedCx } from "#web/components/ui-libraries/scoped-cx.ts";

import styles from "./presales.module.css";

/**
 * Class names for the presale pages: each name the module defines becomes its
 * scoped class plus the plain name (so shared global rules such as `.card`,
 * `.btn`, `.up` still apply); any other name passes through. Falsy parts drop.
 * Joined by clsx (OA-28 M6).
 */
export const cx = scopedCx(styles);
