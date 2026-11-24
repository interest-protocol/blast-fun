import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  agentRules: false,
  devIndicators: false,
  // As the web app: the coin chart reaches the launch economics, whose bytecode template loads its own WASM file.
  serverExternalPackages: ["@mysten/move-bytecode-template"],
  experimental: { cpus: 1, webpackMemoryOptimizations: true },
  webpack(config, { webpack }) {
    if (process.env.BLAST_ACCEPTANCE_FIXTURE === "1") {
      const stub = path.resolve(import.meta.dirname, "acceptance-auth-stub.tsx");
      config.plugins.push(new webpack.NormalModuleReplacementPlugin(
        /components\/(?:presale\/providers\/PrivySessionProvider|social\/coins\/signers|social\/use-social-account)(?:\.tsx?)?$/,
        stub,
      ));
    }
    return config;
  },
  turbopack: { root: path.resolve(import.meta.dirname, "../../../../..") },
};
export default config;
