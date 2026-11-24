import { z } from "zod";

export const WORKSPACE_SECTIONS = ["chart", "trade", "activity", "details"] as const;
export type WorkspaceSection = (typeof WORKSPACE_SECTIONS)[number];
export const TERMINAL_COLUMNS = ["chart", "activity", "trade"] as const;
export type TerminalColumn = (typeof TERMINAL_COLUMNS)[number];
const TerminalGridItemSchema = z.strictObject({
  i: z.enum(TERMINAL_COLUMNS),
  x: z.number().int().min(0).max(23),
  y: z.number().int().min(0).max(1000),
  w: z.number().int().min(1).max(24),
  h: z.number().int().min(1).max(100),
}).refine(item => item.x + item.w <= 24);
const TerminalGridSchema = z.array(TerminalGridItemSchema).length(3)
  .refine(items => new Set(items.map(item => item.i)).size === 3)
  .refine(items => items.every((a, index) => items.slice(index + 1).every(b =>
    a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)));
export type TerminalGridItem = z.infer<typeof TerminalGridItemSchema>;
const TerminalPairGridSchema = z.array(TerminalGridItemSchema).length(2)
  .refine(items => items.every(item => item.i !== "activity") && new Set(items.map(item => item.i)).size === 2)
  .refine(items => items.every((a, index) => items.slice(index + 1).every(b =>
    a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)));
const TerminalLayoutSchema = z.strictObject({
  order: z.array(z.enum(TERMINAL_COLUMNS)).length(3).refine(order => new Set(order).size === 3),
  stacked_order: z.array(z.enum(TERMINAL_COLUMNS)).length(3).refine(order => new Set(order).size === 3).optional(),
  widths: z.array(z.number().int().min(20).max(60)).length(3).refine(widths => widths.reduce((sum, width) => sum + width, 0) === 100),
  height: z.number().int().min(280).max(900),
  stacked_height: z.number().int().min(280).max(900).optional(),
  grid: TerminalGridSchema.optional(),
  stacked_grid: TerminalGridSchema.optional(),
  without_activity_grid: TerminalPairGridSchema.optional(),
  stacked_without_activity_grid: TerminalPairGridSchema.optional(),
});
export type TerminalLayout = Readonly<{ order: readonly TerminalColumn[]; stacked_order?: readonly TerminalColumn[]; widths: readonly number[]; height: number; stacked_height?: number; grid?: readonly TerminalGridItem[]; stacked_grid?: readonly TerminalGridItem[]; without_activity_grid?: readonly TerminalGridItem[]; stacked_without_activity_grid?: readonly TerminalGridItem[] }>;
export const DEFAULT_TERMINAL_LAYOUT: TerminalLayout = { order: ["chart", "trade", "activity"], widths: [45, 30, 25], height: 520 };
export const WorkspaceLayoutSchema = z.strictObject({
  order: z.array(z.enum(WORKSPACE_SECTIONS)).length(4).refine(order => new Set(order).size === 4),
  hidden: z.array(z.enum(["activity", "details"])).max(2).refine(hidden => new Set(hidden).size === hidden.length),
  split: z.number().int().min(45).max(70),
  heights: z.partialRecord(z.enum(WORKSPACE_SECTIONS), z.number().int().min(200).max(900)).optional(),
  terminal: TerminalLayoutSchema.optional(),
});
export type WorkspaceLayout = Readonly<{
  order: readonly WorkspaceSection[];
  hidden: readonly ("activity" | "details")[];
  split: number;
  heights?: Readonly<Partial<Record<WorkspaceSection, number>>>;
  terminal?: TerminalLayout;
}>;
export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayout = { order: WORKSPACE_SECTIONS, hidden: [], split: 64 };
