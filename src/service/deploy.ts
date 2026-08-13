/**
 * One-shot remote deployment: `weclaw deploy --ssh user@host`.
 *
 * Orchestrates the whole server-side setup so a user with SSH access ends up
 * with a hardened, HTTPS-fronted bridge their local relay can talk to:
 *
 *   1. probe the host (OS, node, caddy)
 *   2. install Node ≥ 18 + weclaw-bridge
 *   3. atomically transfer bound credentials (local keeps a copy; server takes
 *      over the long-poll — never run the monitor in two places)
 *   4. front it with Caddy (auto-HTTPS when --domain is given)
 *   5. generate a strong API token, install a systemd service (loopback + token
 *      + login disabled + allow-list)
 *   6. write back local remote.env (WECLAW_REMOTE_URL + token) so the relay
 *      and skill/hooks pick it up
 *   7. smoke-test /health + a test send
 *
 * Failure handling: each step logs what it did; on error we print the exact
 * manual rollback commands rather than silently leaving a half-installed host.
 */

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../store/account.js";
import { Logger } from "../util/log.js";

export interface DeployOptions {
  /** SSH target, e.g. user@host or user@host:port (port via --ssh-port). */
  ssh: string;
  /** Custom ssh port (default 22). */
  sshPort?: number;
  /** Extra ssh flags/identity, passed verbatim. */
  sshIdentity?: string;
  /** Public domain for Caddy auto-HTTPS. Omit to skip TLS (Tailscale/tunnel use). */
  domain?: string;
  /** Internal bridge port on the server (default 4789). */
  port?: number;
  /** Email for Caddy ACME. */
  email?: string;
  /** Pre-existing API token; generated if omitted. */
  apiToken?: string;
  /** Comma-separated IP allowlist forwarded to the server. */
  allowIps?: string;
  logger?: Logger;
}

export interface DeployResult {
  ok: boolean;
  remoteUrl?: string;
  apiToken?: string;
  smoke?: { health: boolean; send: "ok" | "queued" | "failed" };
  error?: string;
}

export function deployRemote(opts: DeployOptions): DeployResult {
  const log = opts.logger ?? new Logger();
  const token = opts.apiToken ?? crypto.randomBytes(24).toString("hex");
  const port = opts.port ?? 4789;
  const remoteUrl = opts.domain ? `https://${opts.domain}` : undefined;
  const stateDir = resolveStateDir();
  const weixinDir = path.join(stateDir, "openclaw-weixin");

  const sshBase = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new"];
  if (opts.sshPort) sshBase.push("-p", String(opts.sshPort));
  if (opts.sshIdentity) sshBase.push("-i", opts.sshIdentity);

  const run = (label: string, cmd: string, args: string[], okStatus = 0): { stdout: string; stderr: string } => {
    log.info(`${label}…`);
    log.debug(`$ ${cmd} ${args.join(" ")}`);
    const res = spawnSync(cmd, args, { encoding: "utf-8" });
    if (res.status !== okStatus) {
      throw new DeployStepError(
        label,
        `${cmd} exited ${res.status}\nstderr: ${(res.stderr || "").trim()}\nstdout: ${(res.stdout || "").trim()}`,
      );
    }
    return { stdout: res.stdout || "", stderr: res.stderr || "" };
  };

  const ssh = (label: string, remoteCmd: string): { stdout: string; stderr: string } =>
    run(label, "ssh", [...sshBase, opts.ssh, remoteCmd]);

  const rollback: string[] = [];
  try {
    if (!fs.existsSync(weixinDir)) {
      throw new DeployStepError(
        "preflight",
        `本地未找到绑定凭证 ${weixinDir}。请先在本地运行 \`weclaw login\` 绑定微信 ClawBot，再部署。`,
      );
    }

    // ── 1. probe ────────────────────────────────────────────────────────────
    const probe = ssh("probe host", "cat /etc/os-release 2>/dev/null | head -1; echo ---; node --version 2>/dev/null; echo ---; which caddy 2>/dev/null; echo ---; which apt-get 2>/dev/null");
    const osId = /VERSION_CODENAME|^ID="?([a-z0-9]+)"?/im.exec(probe.stdout);
    const hasNode = /v(\d+)\./.test(probe.stdout);
    const nodeMajor = hasNode ? Number(/v(\d+)\./.exec(probe.stdout)?.[1]) : 0;
    const hasCaddy = probe.stdout.includes("/caddy");
    const hasApt = probe.stdout.includes("/apt-get");
    log.info(`host: ${opts.ssh} | os=${osId?.[1] ?? "?"} | node=${nodeMajor || "absent"} | caddy=${hasCaddy} | apt=${hasApt}`);

    if (!hasApt) {
      throw new DeployStepError("probe", "目标系统未检测到 apt-get。当前 deploy 仅自动支持 Debian/Ubuntu；其余发行版请手动安装 Node 与 weclaw-bridge 后重试。");
    }

    // ── 2. install node + weclaw ────────────────────────────────────────────
    if (nodeMajor < 18) {
      ssh("install node 18 (NodeSource)", "curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - && sudo apt-get install -y nodejs");
    }
    ssh("install weclaw-bridge", `sudo npm install -g weclaw-bridge`);
    rollback.push(`ssh ${opts.ssh} 'sudo npm uninstall -g weclaw-bridge'`);

    // ── 3. transfer credentials (atomic) ────────────────────────────────────
    ssh("prepare remote state dir", `mkdir -p ~/.weclaw-bridge && test ! -e ~/.weclaw-bridge/openclaw-weixin || mv ~/.weclaw-bridge/openclaw-weixin ~/.weclaw-bridge/openclaw-weixin.bak.$(date +%s)`);
    run("scp credentials to host", "scp", [...sshBase, "-r", weixinDir, `${opts.ssh}:~/.weclaw-bridge/openclaw-weixin`]);
    ssh("verify credentials on host", "test -f ~/.weclaw-bridge/openclaw-weixin/accounts.json && weclaw accounts");
    rollback.push(`ssh ${opts.ssh} 'rm -rf ~/.weclaw-bridge/openclaw-weixin'`);

    // ── 4. caddy front (auto-HTTPS if domain) ───────────────────────────────
    if (remoteUrl && opts.domain) {
      if (!hasCaddy) {
        ssh("install caddy", "sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list && sudo apt-get update && sudo apt-get install -y caddy");
        rollback.push(`ssh ${opts.ssh} 'sudo apt-get purge -y caddy'`);
      }
      const emailLine = opts.email ? `\n  encode zstd gzip` : "";
      const caddyfile = `${opts.domain} {${emailLine}
  reverse_proxy 127.0.0.1:${port}
}`;
      // Write Caddyfile via a heredoc over ssh.
      ssh("write Caddyfile", `echo ${shellQuote(caddyfile)} | sudo tee /etc/caddy/Caddyfile >/dev/null`);
      ssh("reload caddy", "sudo systemctl enable --now caddy; sudo systemctl reload caddy || sudo systemctl restart caddy");
      rollback.push(`ssh ${opts.ssh} 'sudo rm -f /etc/caddy/Caddyfile; sudo systemctl restart caddy'`);
    } else {
      log.warn("未提供 --domain，跳过 TLS/反代。桥接只监听 loopback；请用 Tailscale 或反向隧道暴露，否则本地 relay 无法到达。");
    }

    // ── 5. systemd service on host (loopback + token + login disabled) ──────
    const svcFlags = [
      `--host 127.0.0.1`,
      `--port ${port}`,
      `--api-token ${token}`,
      `--disable-login true`,
    ];
    if (opts.allowIps) svcFlags.push(`--allow-ips ${shellQuote(opts.allowIps)}`);
    ssh("install systemd service on host", `weclaw service install ${svcFlags.join(" ")}`);
    rollback.push(`ssh ${opts.ssh} 'weclaw service uninstall'`);

    // ── 6. write back local remote.env ──────────────────────────────────────
    const localEnvFile = path.join(stateDir, "remote.env");
    fs.mkdirSync(stateDir, { recursive: true });
    const envContent = [
      `# Generated by \`weclaw deploy\` — consumed by the local relay, skill, hooks.`,
      remoteUrl ? `export WECLAW_REMOTE_URL=${remoteUrl}` : `# WECLAW_REMOTE_URL=<set once you have a reachable URL>`,
      `export WECLAW_API_TOKEN=${token}`,
    ].join("\n") + "\n";
    fs.writeFileSync(localEnvFile, envContent, "utf-8");
    try { fs.chmodSync(localEnvFile, 0o600); } catch { /* best-effort */ }
    log.info(`wrote ${localEnvFile}`);
    log.warn("重要：本机若仍在跑 `weclaw start`，请先停掉（同一 bot_token 不能两处同时长轮询）。本地改用 `weclaw relay`。");

    // ── 7. smoke test ───────────────────────────────────────────────────────
    const base = remoteUrl ?? `http://${opts.ssh.split("@").pop()}:${port}`;
    let healthOk = false;
    let sendResult: "ok" | "queued" | "failed" = "failed";
    try {
      const h = spawnSync("curl", ["-sS", "-m", "8", `${base}/health`], { encoding: "utf-8" });
      healthOk = /"ok":\s*true/.test(h.stdout || "");
      if (healthOk) {
        const s = spawnSync("curl", [
          "-sS", "-m", "15", "-X", "POST", `${base}/send`,
          "-H", "Content-Type: application/json",
          "-H", `Authorization: Bearer ${token}`,
          "-d", JSON.stringify({ text: "🐶 weclaw deploy 冒烟测试：部署成功。" }),
        ], { encoding: "utf-8" });
        if (/"ok":\s*true/.test(s.stdout || "")) sendResult = "ok";
        else if (/"queued":\s*true/.test(s.stdout || "")) sendResult = "queued";
      }
    } catch (err) {
      log.warn(`smoke test threw: ${String(err)}`);
    }

    log.info(`✅ deploy 完成。remoteUrl=${base} token=${token.slice(0, 8)}… 健康检查=${healthOk ? "ok" : "FAIL"} 发送=${sendResult}`);
    if (sendResult === "queued") {
      log.warn("测试消息进入队列（缺少会话凭证）。在手机微信里给 bot 发一条消息，桥接会自动重发。");
    }
    return { ok: true, remoteUrl: base, apiToken: token, smoke: { health: healthOk, send: sendResult } };
  } catch (err) {
    const stepName = err instanceof DeployStepError ? err.step : "unknown";
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`❌ deploy 在「${stepName}」步骤失败：${msg}`);
    if (rollback.length > 0) {
      log.error("已完成的改动（手动回滚命令，按需执行）：");
      for (const r of rollback.reverse()) log.error(`  ${r}`);
    }
    return { ok: false, apiToken: token, remoteUrl, error: msg };
  }
}

class DeployStepError extends Error {
  constructor(public step: string, message: string) {
    super(message);
    this.name = "DeployStepError";
  }
}

/** Single-quote a string for safe inclusion in an ssh remote command. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}
