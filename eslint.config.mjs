import { defineConfig } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import shared from "./scripts/eslint/non-web.mjs";

// Next/React rules apply only to the web app. Keep their parser out of
// scoped backend installs, which intentionally do not install Next.
const web = nextVitals.map((config) => ({ ...config, basePath: "apps/web" }));
export default defineConfig([...web, ...shared]);
