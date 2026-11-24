// Prerendered at build; the CDN serves it. Segment config lives here because
// page.tsx is fingerprinted byte for byte into signed legal consent.
export const dynamic = "force-static";

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
