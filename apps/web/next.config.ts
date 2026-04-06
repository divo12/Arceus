import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@arceus/contracts", "@arceus/company-runtime"],
  async rewrites() {
    return [
      {
        source: "/backend/:path*",
        destination: `http://127.0.0.1:${process.env.NEXT_PUBLIC_API_PORT || "4000"}/:path*`
      }
    ];
  }
};

export default nextConfig;
