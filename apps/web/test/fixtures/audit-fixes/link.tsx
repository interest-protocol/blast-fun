import type { AnchorHTMLAttributes } from "react";
export default function Link(props: AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean }) {
  const nativeProps = { ...props };
  delete nativeProps.prefetch;
  return <a {...nativeProps} />;
}
export function useLinkStatus() { return { pending: false }; }
