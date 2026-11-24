import type { LaunchPageDetails } from "@blast/core/modules/launchpad-coin/transfer.ts";

const PROJECT_LINKS = [
  ["telegram", "Telegram"],
  ["twitter", "X"],
  ["website", "Website"],
] as const;

export function poolCoinMetadata(description: string | undefined): {
  description: string | undefined;
  links: LaunchPageDetails["links"];
} {
  const separator = description?.indexOf("||") ?? -1;
  if (!description || separator < 0) {
    return { description, links: [] };
  }

  let metadata: unknown;
  try {
    metadata = JSON.parse(description.slice(separator + 2));
  } catch {
    return { description, links: [] };
  }

  if (!metadata || typeof metadata !== "object" || !PROJECT_LINKS.some(([key]) => Object.hasOwn(metadata, key))) {
    return { description, links: [] };
  }

  const links = PROJECT_LINKS.flatMap(([key, label]) => {
    const url = projectUrl(Object.getOwnPropertyDescriptor(metadata, key)?.value);
    return url ? [{ label, url }] : [];
  });
  return { description: description.slice(0, separator).trim(), links };
}

function projectUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
