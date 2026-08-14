/**
 * Package version — read once from the package.json that ships alongside
 * dist/ (npm layout: <pkg>/dist/util/version.js → <pkg>/package.json).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

export function getVersion(): string {
  if (cached) return cached;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url)); // dist/util
    const pkg = JSON.parse(fs.readFileSync(path.resolve(here, "..", "..", "package.json"), "utf-8")) as {
      version?: string;
    };
    cached = pkg.version ?? "unknown";
  } catch {
    cached = "unknown";
  }
  return cached;
}
