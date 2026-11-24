import { SkeletonText as Text } from "./Skeleton";

type SaleRailClasses = Readonly<{ panel: string; heading: string; terms: string }>;

export function SaleRailLoading({ classes }: Readonly<{ classes: SaleRailClasses }>) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading presale action"
      className={classes.panel}
      data-route-loading="rail"
    >
      <div aria-hidden="true" className={classes.heading}>
        <b>
          <Text>Presale action</Text>
        </b>
      </div>
      <dl aria-hidden="true" className={classes.terms}>
        {[0, 1, 2].map((key) => (
          <div key={key}>
            <dt>
              <Text>Term</Text>
            </dt>
            <dd>
              <Text>Value</Text>
            </dd>
          </div>
        ))}
      </dl>
      <button
        aria-label="Loading presale action"
        className="btn btn-primary btn-lg btn-block"
        disabled
        type="button"
      >
        <Text>Action</Text>
      </button>
    </div>
  );
}
