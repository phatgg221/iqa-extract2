import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfjs ships its own worker and font plumbing and does not survive being
  // bundled; leaving it external lets the route require it from node_modules.
  serverExternalPackages: ["pdfjs-dist"],
};

export default nextConfig;
