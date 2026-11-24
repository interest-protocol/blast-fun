import { SaleRailLoading } from "#web/components/blast-ui/RouteLoading.tsx";
import { cx } from "#web/components/presale-pages/cx.ts";

const classes = {
  panel: cx("card side-box"),
  heading: cx("side-h"),
  terms: cx("terms"),
};

export default function Loading() {
  return <SaleRailLoading classes={classes} />;
}
