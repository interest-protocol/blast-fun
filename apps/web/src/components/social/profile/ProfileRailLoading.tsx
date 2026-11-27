import clsx from "clsx";
import { SkeletonText as Text } from "#web/components/blast-ui/Skeleton.tsx";
import profile from "./Profile.module.css";

const title = "In right now";

export function ProfileRailLoading() {
  return (
    <div
      aria-busy="true"
      aria-label={`Loading ${title}`}
      className={clsx("card", profile.listCard)}
      data-route-loading="rail"
    >
      <h3 className={profile.lcH}>
        <span>{title}</span>
      </h3>
      {[0, 1, 2].map((key) => (
        <div aria-hidden="true" className={profile.lrow} key={key}>
          <span className={profile.mk} />
          <span className={profile.t}>
            <b>
              <Text>Presale name</Text>
            </b>
            <span>
              <Text>Position</Text>
            </span>
          </span>
          <span className={profile.v}>
            <b>
              <Text>Value</Text>
            </b>
            <span>
              <Text>Status</Text>
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}
