import type { NextConfig } from "next";

const apiUrl = process.env.NEXT_PUBLIC_API_URL || `http://127.0.0.1:${process.env.NEXT_PUBLIC_API_PORT || "4000"}`;

const nextConfig: NextConfig = {
  // Docker container build sets NEXT_BUILD_STANDALONE=1 → small runtime image.
  // Vercel never sets it, so Vercel's bundling pipeline runs unchanged.
  output: process.env.NEXT_BUILD_STANDALONE === "1" ? "standalone" : undefined,
  transpilePackages: ["@arceus/contracts", "@arceus/company-runtime", "@arceus/db"],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".js"],
      ".jsx": [".tsx", ".jsx"],
    };
    return config;
  },
  async rewrites() {
    return [
      {
        source: "/backend/:path*",
        destination: `${apiUrl}/:path*`
      }
    ];
  }
};

export default nextConfig;
