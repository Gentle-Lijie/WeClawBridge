/**
 * Shared config-page + config-save helpers.
 *
 * Both the standalone bridge (`BridgeServer`) and the local `RelayServer` serve
 * the same config UI and read/write the SAME local hooks.json. In relay mode
 * the panel MUST edit the local config (the local hook reads local files), so
 * the relay cannot just proxy these to the remote server.
 *
 * Extracted here so both deployments share one implementation.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadHooksConfig,
  saveHooksConfig,
  defaultHooksConfig,
  type HooksConfig,
} from "../hooks/config.js";

/** Path to the bundled config page (assets/config.html relative to dist/bridge). */
export function configHtmlPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // dist/bridge
  return path.resolve(here, "..", "..", "assets", "config.html");
}

let cachedHtml: string | null = null;

/** Read (and cache) the config page HTML. Falls back to a stub if missing. */
export function readConfigHtml(): string {
  if (cachedHtml != null) return cachedHtml;
  try {
    cachedHtml = fs.readFileSync(configHtmlPath(), "utf-8");
  } catch {
    cachedHtml =
      "<!doctype html><meta charset=utf-8><title>weclaw</title><p>config.html not found (run from the installed package).</p>";
  }
  return cachedHtml;
}

export type ConfigSaveResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Parse a JSON body, merge it onto the existing local hooks.json, validate, and
 * persist. Returns a neutral result so callers (server / relay) can map errors
 * to their own response style.
 */
export function saveHooksFromJsonBody(bodyText: string): ConfigSaveResult {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { ok: false, status: 400, error: "invalid JSON body" };
  }
  // `mode` is a GET-response hint (which server served this page), not config.
  delete body.mode;
  // Merge onto the EXISTING config so partial saves don't reset other fields.
  const existing = loadHooksConfig() ?? defaultHooksConfig();
  const cfg = { ...existing, ...body } as HooksConfig;
  // Light validation on types we depend on.
  if (typeof cfg.target !== "string") {
    return { ok: false, status: 400, error: "target must be a string" };
  }
  saveHooksConfig(cfg);
  return { ok: true };
}
