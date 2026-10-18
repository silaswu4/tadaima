import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // chat images read the font with readFile, which tracing can miss
  outputFileTracingIncludes: { "/api/viz/**": ["./app/fonts/PaperMono-Regular.ttf"] },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
