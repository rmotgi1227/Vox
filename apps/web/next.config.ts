import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@vox/core"],
  devIndicators: false
};

export default nextConfig;
