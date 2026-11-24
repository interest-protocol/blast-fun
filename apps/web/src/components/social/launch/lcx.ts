import { scopedCx, type ClassPart } from "#web/components/ui-libraries/scoped-cx.ts";

import styles from "./launch.module.css";

const launchCx = scopedCx(styles);

/** Class names for `/launch`'s own parts (`lc-*`); Create's shared parts use Create's `cx`. */
export function lcx(...names: readonly ClassPart[]): string {
  return launchCx(...names);
}
