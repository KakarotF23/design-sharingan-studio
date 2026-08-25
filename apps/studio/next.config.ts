import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  transpilePackages: [
    "@design-sharingan/core",
    "@design-sharingan/project-adapters",
    "@design-sharingan/ui"
  ]
};

export default nextConfig;
