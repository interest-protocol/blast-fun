import { SkeletonText as Text } from "#web/components/blast-ui/Skeleton.tsx";

import { cx } from "./cx";

export function PresaleRowsSkeleton() {
  return <div aria-busy="true" aria-label="Loading presales" className={cx("card list-loading")} role="status"><b><Text>Presales</Text></b><span><Text>Reading the latest presales.</Text></span></div>;
}

export function PresaleCalendarSkeleton() {
  return <div aria-busy="true" aria-label="Loading scheduled presales" className={cx("card list-loading")} role="status"><b><Text>Scheduled presales</Text></b><span><Text>Reading opening and closing dates.</Text></span></div>;
}
