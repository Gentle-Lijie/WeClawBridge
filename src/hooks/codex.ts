/**
 * Codex CLI support — handles OpenAI Codex's `notify` hook and wires it into
 * ~/.codex/config.toml.
 *
 * Codex's notify is simpler than Claude Code's hooks:
 *   • payload comes as a CLI arg (sys.argv[1]), not stdin
 *   • one event: `agent-turn-complete`
 *   • fields: type, thread-id, turn-id, cwd, input-messages, last-assistant-message
 * It's outbound-only (no asyncRewake equivalent), so we push the completion
 * summary to WeChat — same hooks.json config (target/token/notifyStop/filters/
 * quietHours) drives both Claude Code and Codex.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadHooksConfig, pushDecision, type HooksConfig } from "./config.js";
import { findHostProcess } from "../store/liveness.js";

interface CodexPayload {
  type?: string;
  "thread-id"?: string;
  "turn-id"?: string;
  cwd?: string;
  "last-assistant-message"?: string;
  "input-messages"?: unknown[];
}

/** Absolute path to the compiled CLI entry, for the notify command line. */
function cliEntryPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // dist/hooks
  return path.resolve(here, "..", "cli.js");
}

/** Push a message to WeChat via the configured target, honoring filters. */
async function maybePush(text: string, cfg: HooksConfig, session?: string): Promise<void> {
  const decision = pushDecision(text, cfg);
  if (!decision.push) {
    process.stderr.write(`codex-hook: suppressed (${decision.reason})\n`);
    return;
  }
  const body: Record<string, unknown> = { text };
  if (session) {
    body.session = session;
    // Liveness anchor: let the relay tie this session to the codex process.
    const host = findHostProcess();
    if (host) {
      body.pid = host.pid;
      body.hostStartedAt = host.startedAt;
      body.host = host.comm;
    }
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  try {
    await fetch(new URL("/send", cfg.target + "/").toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    process.stderr.write(`codex-hook: push failed (${String(err)})\n`);
  }
}

/** Entry point for `weclaw codex-hook` — Codex passes the payload as argv. */
export async function runCodexHook(): Promise<void> {
  const cfg = loadHooksConfig();
  if (!cfg) process.exit(0); // not configured → no-op
  // Codex appends the JSON payload as the last argument.
  const raw = process.argv[process.argv.length - 1] ?? "";
  let payload: CodexPayload = {};
  try {
    payload = JSON.parse(raw) as CodexPayload;
  } catch {
    process.exit(0); // malformed/missing payload
  }
  if (payload.type === "agent-turn-complete") {
    if (cfg.notifyStop) {
      const summary = String(payload["last-assistant-message"] ?? "").slice(0, cfg.summaryLength ?? 800);
      const session = payload["thread-id"] ? `codex:${payload["thread-id"]}` : undefined;
      await maybePush(`✅ Codex 任务完成：\n${summary || "(无摘要)"}`, cfg, session);
    }
  }
  process.exit(0);
}

function codexHooksPath(): string {
  return path.join(os.homedir(), ".codex", "hooks.json");
}

/** The command every Codex hook runs — the SAME dispatcher Claude Code uses. */
function hookCommand(): string {
  const entry = cliEntryPath();
  return `weclaw hook || node ${JSON.stringify(entry)} hook`;
}

const CODEX_EVENTS = ["SessionStart", "SessionEnd", "Stop", "PermissionRequest", "PostToolUse"] as const;

/**
 * Install weclaw hooks into ~/.codex/hooks.json. Codex's hook system is nearly
 * identical to Claude Code's (stdin JSON payload, PascalCase events, Stop exit-2
 * continue), so we register the SAME `weclaw hook` dispatcher and get:
 *   SessionStart → session route learning
 *   Stop         → completion summary only (no asyncRewake — see below)
 *   PermissionRequest → permission-needed mirror to WeChat (Codex has no Notification)
 *   PostToolUse  → high-risk tool alert
 */
export function installCodexHooks(opts: { highRiskTools?: string[] } = {}): { file: string } {
  const file = codexHooksPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cmd = hookCommand();
  const events: string[] = opts.highRiskTools && opts.highRiskTools.length > 0 ? [...CODEX_EVENTS] : CODEX_EVENTS.filter((e) => e !== "PostToolUse");
  const hooks: Record<string, unknown> = {};
  for (const ev of events) {
    // No asyncRewake here: codex Stop hooks run synchronously and hold the
    // turn (and the whole session slot) until they exit, so a reply-waiting
    // Stop hook would block new sessions for the entire wait window.
    const entry = { type: "command", command: cmd };
    hooks[ev] = [{ matcher: "", hooks: [entry] }];
  }
  // Merge: keep unrelated events the user may have configured.
  let existing: { hooks?: Record<string, unknown> } = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, "utf-8")) as { hooks?: Record<string, unknown> };
  } catch {
    // none
  }
  const merged = { ...(existing.hooks ?? {}), ...hooks };
  fs.writeFileSync(file, JSON.stringify({ hooks: merged }, null, 2) + "\n", "utf-8");
  return { file };
}

/** Remove weclaw-managed events from ~/.codex/hooks.json (preserves others). */
export function uninstallCodexHooks(): { file: string; removed: number } {
  const file = codexHooksPath();
  let parsed: { hooks?: Record<string, unknown> } = {};
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { hooks?: Record<string, unknown> };
  } catch {
    return { file, removed: 0 };
  }
  const hooks = parsed.hooks ?? {};
  let removed = 0;
  for (const ev of CODEX_EVENTS) {
    if (hooks[ev]) {
      delete hooks[ev];
      removed += 1;
    }
  }
  if (Object.keys(hooks).length === 0) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  } else {
    fs.writeFileSync(file, JSON.stringify({ hooks }, null, 2) + "\n", "utf-8");
  }
  return { file, removed };
}
