import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  outputFileTracingIncludes: {
    "/coin/*/share-image": [
      "../../packages/server/assets/launchpad/coin-share-background.jpg",
      "./public/blast-ui/coins/{sui,usdc}.svg",
      "./public/blast-ui/coins/v1-*.jpg",
      "../../packages/server/assets/mission-control/fonts/Inter-{Bold,ExtraBold,Black}.ttf",
    ],
  },
  allowedDevOrigins: ["127.0.0.1"],
  devIndicators: false,
  experimental: {
    cpus: 1,
    // A page visited in the last 30 s opens from the router's cache instead of
    // waiting on the server again (Home and Portfolio back and forth). Live
    // reads on the pages keep their figures current.
    staleTimes: { dynamic: 30 },
  },
  // The Blast SDK's Meme template reads its WASM beside its Node entry, so
  // that package must load from node_modules rather than the server bundle.
  serverExternalPackages: ["@resvg/resvg-js", "@mysten/move-bytecode-template"],
  images: {
    unoptimized: true,
    remotePatterns: [
      { protocol: "https", hostname: "pbs.twimg.com" },
    ],
  },
};

export default nextConfig;
