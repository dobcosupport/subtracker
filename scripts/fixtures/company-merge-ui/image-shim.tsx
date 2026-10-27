import type { ImgHTMLAttributes } from "react";

export default function Image(props: ImgHTMLAttributes<HTMLImageElement>) {
  // The shim intentionally bypasses Next's image optimizer in the isolated test harness.
  // eslint-disable-next-line @next/next/no-img-element
  return <img {...props} alt={props.alt ?? ""} />;
}
