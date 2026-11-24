import { DisclosureButton, IconButton, type Button } from "#web/components/blast-ui/Button.tsx";
import { InfoIcon } from "#web/components/blast-ui/Icons.tsx";
import { useContext, useId, useRef, useState, type ReactNode, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { Collapse } from "#web/components/blast-ui/Collapse.tsx";
import { PanelAssetContext } from "./panel-context";
import { Popover, PopoverSurface } from "#web/components/blast-ui/Popover.tsx";
import styles from "./CoinPanel.module.css";

import { CoinDetailsSlots } from "./panel-context";

type DetailsKind = "chart" | "trade";

/**
 * Local presentation only: current facts remain mounted and closed controls are inert. Trade details open inline under
 * their button; a chart card's few lines open as a small popover beside its info button (audit F19, F39): neither
 * covers the board with a blurred sheet.
 */
export function CoinDetails(props: Readonly<{ kind: DetailsKind; label: string; text?: string; icon?: ReactNode; children: ReactNode }>) {
  const inCard = useContext(PanelAssetContext) !== null;
  return inCard && props.kind === "chart" ? <ChartDetailsPopover {...props} /> : <InlineDetails {...props} />;
}

function InlineDetails({
  kind,
  label,
  text = label,
  icon,
  children,
}: Readonly<{ kind: DetailsKind; label: string; text?: string; /** Draws the trigger as this icon alone; `label` stays its name and tooltip. */ icon?: ReactNode; children: ReactNode }>) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  function close() {
    if (content.current?.contains(document.activeElement))
      trigger.current?.focus();
    setOpen(false);
  }
  const slots = useContext(CoinDetailsSlots);
  const [wasVisible, setWasVisible] = useState(slots.visible);
  if (slots.visible !== wasVisible) {
    setWasVisible(slots.visible);
    if (slots.visible === false) setOpen(false);
  }
  const slot = slots[kind];
  const triggerProps = {
    variant: "secondary" as const,
    "aria-label": label,
    "aria-controls": id,
    "aria-expanded": open,
    ref: trigger,
    onClick: () => (open ? close() : setOpen(true)),
  };
  const button = <DetailsTrigger props={triggerProps} icon={icon} kind={kind} text={text} />;
  return (
    <div
      className={styles.details}
      data-details={kind}
      data-open={String(open)}
      onKeyDown={(event) => {
        if (open && event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      {slot ? createPortal(button,slot) : button}
      <Collapse open={open} id={id}><div className={styles.detailsContent} ref={content}>{children}</div></Collapse>
    </div>
  );
}

function ChartDetailsPopover({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  const [open, setOpen] = useState(false);
  const slots = useContext(CoinDetailsSlots);
  const [wasVisible, setWasVisible] = useState(slots.visible);
  if (slots.visible !== wasVisible) {
    setWasVisible(slots.visible);
    if (slots.visible === false) setOpen(false);
  }
  const trigger = <Popover.Trigger render={<IconButton variant="ghost" size="sm" aria-label={label} />}><InfoIcon /></Popover.Trigger>;
  return (
    <div className={styles.details} data-details="chart" data-open={String(open)}>
      <Popover.Root open={open && slots.visible !== false} onOpenChange={setOpen}>
        {slots.chart ? createPortal(trigger, slots.chart) : trigger}
        <PopoverSurface
          positioner={{ side: "bottom", align: "end", sideOffset: 6, collisionPadding: 12, className: styles.detailsLayer }}
          popup={{ className: styles.detailsPopover, "aria-label": label }}
        >
          <div className={styles.detailsContent}>{children}</div>
        </PopoverSurface>
      </Popover.Root>
    </div>
  );
}

function DetailsTrigger({ props, icon, kind, text }: Readonly<{ props: ComponentProps<typeof Button> & { "aria-label": string }; icon?: ReactNode; kind: DetailsKind; text: string }>) {
  if (icon) return <IconButton {...props} size="sm">{icon}</IconButton>;
  if (kind === "chart") return <IconButton {...props} variant="ghost" size="sm"><InfoIcon /></IconButton>;
  return <DisclosureButton {...props} variant="ghost" size="sm">{text}</DisclosureButton>;
}
