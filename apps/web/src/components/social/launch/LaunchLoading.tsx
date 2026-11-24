import { PageHeader } from "#web/components/blast-ui/PageHeader.tsx";
import { SkeletonBox, SkeletonRegion } from "#web/components/blast-ui/Skeleton.tsx";
import { LOGO_GUIDE } from "#web/components/social/create/create-field-model.ts";

import { cx } from "../create/cx";
import { lcx } from "./lcx";

/** `/launch` while its rules load: the page's frame, its first card drawn as skeleton fields. */
export function LaunchLoading() {
  return (
    <div className={`${cx("createPage")} ${lcx("lc-page")}`} data-create-page="" data-shell-aside="medium">
      <PageHeader title="Launch a coin" />
      <div className={cx("cr-body")}>
        <LaunchLoadingFields />
      </div>
    </div>
  );
}

/**
 * Pending fields inside an already mounted launch page: the Coin card's own
 * layout (logo, name and ticker, description, Advanced row) with each
 * control drawn as a box of its final size and each line of copy as the real
 * words under a bar (`SkeletonLine`), wrapping as they will, so nothing moves
 * when the draft arrives. It shows only after 300 ms (`--t4`), so a fast load
 * never flashes it.
 */
export function LaunchLoadingFields() {
  return (
    <SkeletonRegion className={`${cx("card cr-card cr-g")} ${lcx("lc-wait")}`} label="Loading launch settings">
      <h2 aria-hidden="true">Coin</h2>
      <div className={cx("cr-ident")}>
        <div className={cx("cr-logo-col")}>
          <SkeletonBox className={`${cx("cr-logo")} ${lcx("lc-logo-skel")}`} />
          <span className={cx("cr-logo-title")}><SkeletonLine>Upload logo</SkeletonLine></span>
          <span className={cx("cr-logo-note")}><SkeletonLine>{LOGO_GUIDE}</SkeletonLine></span>
        </div>
        <div className={cx("cr-ident-fields")}>
          <SkeletonField label="Name" />
          <SkeletonField label="Ticker" />
        </div>
      </div>
      <SkeletonField control="lc-area-skel" label="Description" />
      <SkeletonBox className={lcx("lc-row-skel")} />
    </SkeletonRegion>
  );
}

/** One labelled field: the real label, its control as a box, its help line as a bar. */
function SkeletonField({ label, help, control = "lc-input-skel" }: Readonly<{ label: string; help?: string; control?: string }>) {
  return (
    <div aria-hidden="true" className={cx("cr-field")}>
      <span className={cx("cr-label")}>{label}</span>
      <SkeletonBox className={lcx(control)} />
      {help ? <span className={cx("cr-help")}><SkeletonLine>{help}</SkeletonLine></span> : null}
    </div>
  );
}

/** The real words, hidden under a bar per line: they wrap and set line height exactly as the loaded copy does (the shared one-line `SkeletonText` would not). */
function SkeletonLine({ children }: Readonly<{ children: string }>) {
  return <span aria-hidden="true" className={lcx("lc-line-skel")}>{children}</span>;
}
