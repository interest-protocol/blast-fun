import { IconButtonLink } from "./Button.tsx";
import { ExternalIcon } from "./Icons.tsx";

export function TransactionLink({ href, label = "View transaction" }: Readonly<{ href: string; label?: string }>) {
  return <IconButtonLink aria-label={label} href={href} rel="noopener noreferrer" size="touch" target="_blank" title={label}>
    <ExternalIcon />
  </IconButtonLink>;
}
