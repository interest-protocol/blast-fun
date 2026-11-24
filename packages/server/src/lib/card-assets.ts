import { fileURLToPath } from "node:url";

const assetRoot = new URL("../../assets/mission-control/", import.meta.url);

export function cardAssetPath(relativePath: string): string {
  if (!/^(?:fonts\/Inter-[A-Za-z]+\.ttf|editions\/[a-z0-9-]+\.png|default-avatar\.png)$/.test(relativePath)) {
    throw new Error("Invalid card asset path");
  }
  return fileURLToPath(new URL(relativePath, assetRoot));
}
