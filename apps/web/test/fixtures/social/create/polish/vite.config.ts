import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
const app = fileURLToPath(new URL("../../../../../", import.meta.url));
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: `${app}/public`,
  define: { "process.env": { NODE_ENV: "development" } },
  server: { host: "127.0.0.1", port: 42941, strictPort: true, fs: { allow: [fileURLToPath(new URL("../../../../../../../", import.meta.url))] } },
});
