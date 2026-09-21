import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfjs ships its own worker and font plumbing and does not survive being
  // bundled; leaving it external lets the route require it from node_modules.
  serverExternalPackages: ["pdfjs-dist"],

  // ...but "external" only means Vercel traces the package rather than bundling
  // it, and tracing follows static imports. pdfjs loads its worker through a
  // *dynamic* import when it sets up the fake worker in Node, so the tracer
  // never sees pdf.worker.mjs and the deployed function is missing it:
  //
  //   Cannot find module '/var/task/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'
  //
  // Naming the file here forces it into the bundle for every API route that
  // reads a PDF. It works locally without this because node_modules is right
  // there on disk.
  outputFileTracingIncludes: {
    "/api/**": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
  },
};

export default nextConfig;
