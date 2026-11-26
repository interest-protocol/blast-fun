import { scopedCx } from "#web/components/ui-libraries/scoped-cx.ts";

import styles from "./launch.module.css";

/** Class names for `/launch`'s own parts (`lc-*`); Create's shared parts use Create's `cx`. */
export const lcx = scopedCx(styles);
