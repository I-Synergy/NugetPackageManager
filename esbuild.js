const { build } = require("esbuild");

const baseConfig = {
  bundle: true,
  minify: process.env.NODE_ENV === "production",
  sourcemap: process.env.NODE_ENV !== "production",
  define: {
    "process.env.ENVIRONMENT": JSON.stringify(process.env.ENVIRONMENT ?? "debugging"),
    "process.env.TELEMETRY_ADDRESS": JSON.stringify(process.env.TELEMETRY_ADDRESS ?? ""),
  },
  loader: {
    ".png": "dataurl",
    ".woff": "dataurl",
    ".woff2": "dataurl",
    ".eot": "dataurl",
    ".ttf": "dataurl",
    ".svg": "dataurl",
  },
};

const extensionConfig = {
  ...baseConfig,
  platform: "node",
  mainFields: ["module", "main"],
  format: "cjs",
  entryPoints: ["./src/NugetPackageManager.VSCode.Host/extension.ts"],
  outfile: "./dist/extension.js",
  external: ["vscode"],
};

const webConfig = {
  ...baseConfig,
  target: "es6",
  format: "esm",
  entryPoints: ["./src/NugetPackageManager.VSCode.Webview/main.ts"],
  outfile: "./dist/web.js",
};

Promise.all([extensionConfig, webConfig].map((config) => build(config)))
  .then(() => {
    console.log("build complete");
  })
  .catch((err) => {
    process.stderr.write(err.stderr);
    process.exit(1);
  });
