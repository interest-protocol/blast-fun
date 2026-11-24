"use client";

import Link, { useLinkStatus } from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type ComponentProps, type ReactNode } from "react";

export function NavPending({ label, children }: Readonly<{ label?: string; children?: ReactNode }> = {}) {
  const { pending } = useLinkStatus();
  if (label) return (
    <>
      <span data-pending={pending ? "" : undefined}>{children}</span>
      <span className="sr-only" aria-atomic="true" aria-live="polite">{pending ? label : ""}</span>
    </>
  );
  return pending ? <i data-pending="" hidden /> : null;
}

/** Cached pages can still need rendering time; acknowledge their transition too. */
export function PrimaryLink({
  children,
  href,
  scroll,
  replace,
  ...props
}: Omit<ComponentProps<typeof Link>, "href" | "onNavigate"> & {
  href: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Link
      {...props}
      href={href}
      scroll={scroll}
      onNavigate={(event) => {
        event.preventDefault();
        startTransition(() =>
          replace
            ? router.replace(href, { scroll })
            : router.push(href, { scroll }),
        );
      }}
    >
      {children}
      {pending ? <i data-pending="" hidden /> : null}
    </Link>
  );
}

/** Detail lists prefetch only the link under the pointer or keyboard focus. */
export function IntentLink({
  children,
  onMouseEnter,
  onFocus,
  ...props
}: Omit<ComponentProps<typeof Link>, "prefetch">) {
  const [active, setActive] = useState(false);
  return (
    <Link
      {...props}
      prefetch={active ? null : false}
      onMouseEnter={(event) => {
        onMouseEnter?.(event);
        setActive(true);
      }}
      onFocus={(event) => {
        onFocus?.(event);
        setActive(true);
      }}
    >
      {children}
      <NavPending />
    </Link>
  );
}
