import { isAbsolute } from "node:path";
import { globSync as tinyGlobSync } from "tinyglobby";

// shortcut: only Next's root-directory globSync API; remove when its upstream dependency drops braces (GHSA-vfj7-8cjw-p6xm).
export const globSync = (pattern, options) => tinyGlobSync(pattern, {
  ...options,
  absolute: isAbsolute(pattern),
  expandDirectories: false,
}).map((directory) => directory.replace(/(.+)\/$/, "$1"));
