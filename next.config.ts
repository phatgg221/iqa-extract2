import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfjs ships its own worker and font plumbing and does not survive being
  // bundled; leaving it external lets the route require it from node_modules.
  serverExternalPackages: ["pdfjs-dist", "tesseract.js"],

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
  // Tesseract needs both halves of the same treatment, for a reason worth
  // writing down because it cost several deploys to find.
  //
  // It starts its engine with `new Worker(workerPath)`, where workerPath is
  // built from `__dirname`. Bundled, the compiler inlines `__dirname` as the
  // *build machine's* path, so the deployed function ends up calling:
  //
  //   new Worker("/ROOT/node_modules/tesseract.js/src/worker-script/node/index.js")
  //
  // which does not exist at runtime — the function lives in /var/task. A
  // Worker over a missing file never comes up, and tesseract's createWorker
  // never settles, so the symptom is a hang rather than an error. Tracing the
  // files alone did not help: they were deployed to /var/task while the code
  // was looking in /ROOT. Keeping the package external is what makes
  // `__dirname` real again; tracing is what puts the runtime-loaded worker
  // script and WASM core beside it.
  outputFileTracingIncludes: {
    "/api/**": [
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
      "./node_modules/tesseract.js/src/**",
      "./node_modules/tesseract.js-core/**",
    ],
  },
};

export default nextConfig;
