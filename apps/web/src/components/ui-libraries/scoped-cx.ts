import clsx from "clsx";

/** What a scoped mapper takes: class names (several to a string allowed), or a falsy part, which drops. */
export type ClassPart = string | false | null | undefined;

/**
 * A `cx` for pages whose CSS module mirrors the design's global class names
 * (the presale pages, the Create page): the parts are joined by `clsx`, then
 * each name the module defines becomes its scoped class plus the plain name
 * (so the shared global rules such as `.card`, `.btn`, `.up` still apply); any
 * other name passes through (OA-28 M6, `ui-libraries.md` §3.11).
 */
export function scopedCx(styles: Readonly<Record<string, string>>): (...names: readonly ClassPart[]) => string {
  return (...names) => {
    const out: string[] = [];
    for (const name of clsx(...names).split(" ")) {
      if (!name) continue;
      const scoped = styles[name];
      out.push(scoped ? `${scoped} ${name}` : name);
    }
    return out.join(" ");
  };
}
