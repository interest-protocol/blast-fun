import type { ReactNode } from "react";
import "../../../../src/app/globals.css";
import "../../../../src/components/blast-ui/blast-ui.css";
import "@fontsource/patrick-hand/400.css";

export default function Layout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
