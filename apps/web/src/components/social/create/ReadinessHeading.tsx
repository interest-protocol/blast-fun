import { cx } from "./cx";

/** The checklist's heading: whether everything is done, announced as it changes (no meter or count: the stepper shows progress). */
export function ReadinessHeading({ label, loading, loadingLabel, done }: Readonly<{
  label: string;
  loading: boolean;
  loadingLabel: string;
  done: boolean;
}>) {
  return (
    <span className={cx("cr-ready-head")}>
      <span role="status">{loading ? <>Checking readiness<span className="sr-only"> ({loadingLabel})</span></> : done ? label : "Complete required fields"}</span>
    </span>
  );
}
