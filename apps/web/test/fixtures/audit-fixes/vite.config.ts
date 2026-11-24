import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
const here = fileURLToPath(new URL(".", import.meta.url));
const app = fileURLToPath(new URL("../../../", import.meta.url));
export default defineConfig({
  root: here,
  publicDir: `${app}/public`,
  define: { "process.env": { NODE_ENV: "development" } },
  resolve: { alias: [
    { find: "#web", replacement: `${app}/src` },
    { find: "./creation-coins", replacement: `${here}/coins.ts` },
    { find: "./use-vesting-wallet", replacement: `${here}/wallet.ts` },
    { find: "next/image", replacement: `${here}/image.tsx` },
    { find: "next/link", replacement: `${here}/link.tsx` },
    { find: "next/navigation", replacement: `${here}/navigation.ts` },
  ], dedupe: ["react", "react-dom", "@tanstack/react-query"] },
  server: { host: "127.0.0.1", port: 42973, strictPort: true, fs: { allow: ["/home/ubuntu/blast-v2"] } },
});
