// Registers the @/* path aliases for the CommonJS test runner.
// TypeScript compiles sources and tests to out/ but leaves `require('@/...')`
// literals intact; this shim resolves them against the compiled tree at runtime.
const path = require('node:path');
require('tsconfig-paths').register({
  baseUrl: path.resolve(__dirname, 'out'),
  paths: {
    '@/common/*': ['./src/NugetPackageManager.VSCode.Common/*'],
    '@/host/*': ['./src/NugetPackageManager.VSCode.Host/*'],
    '@/web/*': ['./src/NugetPackageManager.VSCode.Webview/*'],
  },
});
