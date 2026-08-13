/**
 * Install/uninstall Claude Code hooks into `.claude/settings.json`.
 *
 * Every registered hook runs the same command — `weclaw hook` — so settings.json
 * stays small and stable; behavior is driven by hooks.json (see config.ts).
 *
 * Registered events:
 *   SessionStart  → route learning
 *   Stop          → completion notify (opt-in) + asyncRewake reply injection
 *   Notification  → permission/idle/needs-input mirror
 *   PostToolUse   → high-risk tool alerts (matchers from highRiskTools)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { saveHooksConfig, defaultHooksConfig, type HooksConfig } from "./config.js";
import { Logger } from "../util/log.js";

export interface InstallHooksOptions {
  /** Write to ~/.claude (default) instead of project ./.claude. */
  global?: boolean;
  /** Target URL the dispatcher pushes to (default 127.0.0.1:4789). */
  target?: string;
  token?: string;
  notifyStop?: boolean;
  notifyNotification?: boolean;
  highRiskTools?: string[];
  asyncRewake?: boolean;
  logger?: Logger;
}

/** Absolute path to the compiled hook dispatcher entry. */
function hookCommand(): string {
  // Prefer `weclaw` on PATH; fall back to the absolute node + cli.js.
  const here = path.dirname(fileURLToPath(import.meta.url)); // dist/hooks
  const cliJs = path.resolve(here, "..", "cli.js");
  return `weclaw hook || node ${JSON.stringify(cliJs)} hook`;
}

function settingsPath(global: boolean): string {
  const dir = global ? path.join(os.homedir(), ".claude") : path.join(process.cwd(), ".claude");
  return path.join(dir, "settings.json");
}

function readSettings(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

interface HookEntry {
  type: "command";
  command: string;
  asyncRewake?: boolean;
  timeout?: number;
}
interface MatcherGroup {
  matcher?: string;
  hooks: HookEntry[];
}

function buildHooksConfig(opts: InstallHooksOptions): Record<string, MatcherGroup[]> {
  const cmd = hookCommand();
  const stopHooks: HookEntry[] = [];
  // The asyncRewake entry must be its own hook so Claude Code runs it as a
  // background process that can exit 2 to wake the idle session.
  if (opts.asyncRewake !== false) {
    stopHooks.push({ type: "command", command: cmd, asyncRewake: true, timeout: 540 });
  }
  // notifyStop just needs the same dispatcher to push; reuse one entry.
  // (runHook on Stop does both notify + pending check.)

  const groups: Record<string, MatcherGroup[]> = {
    SessionStart: [{ matcher: "", hooks: [{ type: "command", command: cmd }] }],
    SessionEnd: [{ matcher: "", hooks: [{ type: "command", command: cmd }] }],
    Stop: stopHooks.length > 0 ? [{ matcher: "", hooks: stopHooks }] : [{ matcher: "", hooks: [{ type: "command", command: cmd }] }],
    Notification: [{ matcher: "", hooks: [{ type: "command", command: cmd }] }],
  };

  if (opts.highRiskTools && opts.highRiskTools.length > 0) {
    groups.PostToolUse = [{ matcher: "", hooks: [{ type: "command", command: cmd }] }];
  }
  return groups;
}

export function installHooks(opts: InstallHooksOptions): { file: string } {
  const log = opts.logger ?? new Logger();
  const cfg: HooksConfig = {
    ...defaultHooksConfig(),
    target: opts.target ?? defaultHooksConfig().target,
    token: opts.token,
    notifyStop: opts.notifyStop ?? false,
    notifyNotification: opts.notifyNotification ?? true,
    highRiskTools: opts.highRiskTools ?? [],
    asyncRewake: opts.asyncRewake ?? true,
  };
  saveHooksConfig(cfg);

  const file = settingsPath(opts.global ?? true);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const settings = readSettings(file);
  const prevHooks = (settings.hooks as Record<string, MatcherGroup[]> | undefined) ?? {};

  // Merge: replace our event groups but keep unrelated ones.
  const next = { ...prevHooks, ...buildHooksConfig(opts) };
  settings.hooks = next;
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf-8");

  log.info(`hooks written to ${file}`);
  log.info(`dispatcher config → ${path.join(os.homedir(), ".weclaw-bridge", "hooks.json")}`);
  log.info(
    `enabled: notifyStop=${cfg.notifyStop} notifyNotification=${cfg.notifyNotification} asyncRewake=${cfg.asyncRewake} highRisk=${cfg.highRiskTools.length}`,
  );
  return { file };
}

export function uninstallHooks(opts: { global?: boolean; logger?: Logger }): { file: string } {
  const log = opts.logger ?? new Logger();
  const file = settingsPath(opts.global ?? true);
  const settings = readSettings(file);
  const hooks = (settings.hooks as Record<string, MatcherGroup[]> | undefined) ?? {};
  // Remove only the events we manage.
  for (const ev of ["SessionStart", "SessionEnd", "Stop", "Notification", "PostToolUse"]) {
    delete hooks[ev];
  }
  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
  } else {
    settings.hooks = hooks;
  }
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  log.info(`removed weclaw hooks from ${file}`);
  return { file };
}
