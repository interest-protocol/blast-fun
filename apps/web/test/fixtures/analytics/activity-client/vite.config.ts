import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const web = fileURLToPath(new URL("../../../../", import.meta.url));
export default defineConfig({
  root,
  publicDir: false,
  define: { "process.env.NODE_ENV": JSON.stringify("development") },
  resolve: {
    alias: [{ find: "#web", replacement: `${web}/src` }],
    dedupe: ["react", "react-dom"],
  },
  server: { host: "127.0.0.1", port: 42989, strictPort: true, hmr: false },
});
