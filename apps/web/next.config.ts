import type { NextConfig } from "next";

const apiUrl = process.env.NEXT_PUBLIC_API_URL || `http://127.0.0.1:${process.env.NEXT_PUBLIC_API_PORT || "4000"}`;

const nextConfig: NextConfig = {
  transpilePackages: ["@arceus/contracts", "@arceus/company-runtime"],
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
