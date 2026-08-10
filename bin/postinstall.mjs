#!/usr/bin/env node
/**
 * postinstall banner — prints platform-aware auto-start guidance.
 *
 * Runs on `npm install` / `npm add weclaw-bridge`. It is intentionally
 * NON-INTERACTIVE (safe for CI, never blocks): it just detects the OS and
 * prints the exact commands to bind + enable the daemon.
 *
 * Skipped during local development of this repo (when the package is NOT
 * sitting inside a parent's node_modules).
 */

import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");

// Skip when developing locally (the package is the project root, not a dep).
if (!pkgRoot.includes(path.join("node_modules"))) {
  process.exit(0);
}

// Allow opt-out in CI / automation.
if (process.env.WECLAW_SKIP_POSTINSTALL === "1" || process.env.CI === "true" && process.env.WECLAW_SKIP_POSTINSTALL_CI === "1") {
  // Still print one line so it's discoverable.
  process.stdout.write(`${CYAN}[weclaw-bridge]${RESET} installed. Run \`npx weclaw login\` to bind, then \`npx weclaw start\`.\n`);
  process.exit(0);
}

function detectManager() {
  const platform = process.platform;
  if (platform === "linux") return { kind: "systemd", platform: "linux" };
  if (platform === "darwin") return { kind: "launchd", platform: "darwin" };
  if (platform === "win32") return { kind: "schtasks", platform: "windows" };
  return { kind: "manual", platform };
}

const { kind, platform } = detectManager();
const pkg = (() => {
  try {
    const require = createRequire(import.meta.url);
    return require(path.join(pkgRoot, "package.json"));
  } catch {
    return { version: "" };
  }
})();

const banner = [
  ``,
  `${CYAN}┌──────────────────────────────────────────────────────┐${RESET}`,
  `${CYAN}│  weclaw-bridge${pkg.version ? ` v${pkg.version}` : ""} installed                  │${RESET}`,
  `${CYAN}│  Standalone WeChat ClawBot bridge — no openclaw       │${RESET}`,
  `${CYAN}└──────────────────────────────────────────────────────┘${RESET}`,
  ``,
  `${BOLD}第一步 · 绑定微信 ClawBot（终端扫码）${RESET}`,
  `  npx weclaw login`,
  ``,
  `${BOLD}第二步 · 运行桥接服务${RESET}`,
  `  npx weclaw start            # 前台运行（监听 + webhook，默认 :4789）`,
  ``,
  `${BOLD}第三步 · 配置开机自启${RESET}  ${YELLOW}(${platform} / ${kind})${RESET}`,
  `  npx weclaw service install  # 自动生成并启用 ${kind} 服务`,
  `  npx weclaw service status   # 查看运行状态`,
  `  npx weclaw service uninstall`,
  ``,
  `${GREEN}绑定后转发消息：${RESET}curl -X POST http://127.0.0.1:4789/send -H 'Content-Type: application/json' -d '{"text":"hello"}'`,
  ``,
  `提示：首次发送前，请先在微信里给 ClawBot 发一条消息以建立会话。`,
  `${YELLOW}⚠️  本工具是对 iLink 协议的独立实现（非官方 openclaw 路径）。${RESET}`,
  `${YELLOW}    依据微信 ClawBot 使用条款 4.7 / 6.x，使用未授权客户端类型可能被腾讯拦截/封禁，${RESET}`,
  `${YELLOW}    存在账号或服务受限风险，请自行评估。详见 README「合规与风险提示」。${RESET}`,
  `文档：https://github.com/LijieZhou/WeClawBridge#readme`,
  ``,
].join("\n");

process.stdout.write(banner);
process.exit(0);
