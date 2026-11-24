import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const web = fileURLToPath(new URL("../../../../", import.meta.url));
const adapters = fileURLToPath(new URL("../../audit-fixes/", import.meta.url));

export default defineConfig({
  root,
  publicDir: `${web}/public`,
  define: { "process.env": { NODE_ENV: "development" } },
  resolve: {
    alias: [
      { find: "#web", replacement: `${web}/src` },
      { find: "next/link", replacement: `${adapters}/link.tsx` },
      { find: "next/navigation", replacement: `${adapters}/navigation.ts` },
    ],
    dedupe: ["react", "react-dom", "@tanstack/react-query"],
  },
  server: { host: "127.0.0.1", port: 42979, strictPort: true },
});
