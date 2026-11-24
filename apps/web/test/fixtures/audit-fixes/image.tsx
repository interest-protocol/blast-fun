import { createElement, type ImgHTMLAttributes } from "react";
/** Native fixture adapter: layout/alt retained; no Next optimizer or preload. */
export default function Image(props: ImgHTMLAttributes<HTMLImageElement> & { priority?: boolean }) {
  const nativeProps = { ...props };
  delete nativeProps.priority;
  return createElement("img", nativeProps);
}
