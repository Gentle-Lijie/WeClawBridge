#!/usr/bin/env node
// Launcher for the compiled CLI. Works on Node; the source also runs on Bun/Deno.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, "..", "dist", "cli.js");
// On Windows, dynamic import() requires a file:// URL, not a bare D:\... path.
const entryUrl = pathToFileURL(entry).href;

try {
  await import(entryUrl);
} catch (err) {
  if (err && (err.code === "ERR_MODULE_NOT_FOUND" || err.code === "MODULE_NOT_FOUND")) {
    process.stderr.write(
      "weclaw: dist/ 未构建。请先运行 `npm install && npm run build`，或用 `node --experimental-strip-types src/cli.ts`。\n",
    );
    process.exit(1);
  }
  throw err;
}
