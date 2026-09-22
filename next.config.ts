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

  // Tesseract's files were traced here too for a while, on the theory that it
  // hung on Vercel for the same reason pdfjs did — it starts its engine with
  // `new Worker(workerPath)`, a path resolved at runtime that the tracer
  // cannot see. Tracing them (verified present in the .nft.json) and pointing
  // its cache at a writable directory both turned out to be necessary but not
  // sufficient: `createWorker` still never returns on Vercel, at 60s and at
  // 150s alike. So the 43 MB is not carried for something that does not work.
  // OCR runs in the standalone worker instead — see docs/supabase-setup.md.
};

export default nextConfig;
