import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@arceus/contracts", "@arceus/company-runtime"],
  async rewrites() {
    return [
      {
        source: "/backend/:path*",
        destination: "http://127.0.0.1:4000/:path*"
      }
    ];
  }
};

export default nextConfig;
