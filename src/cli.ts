#!/usr/bin/env node
/**
 * weclaw — standalone WeChat ClawBot bridge CLI.
 *
 *   weclaw login   [--base-url URL] [--channel-version V]   bind a WeChat ClawBot via QR
 *   weclaw start   [--port N] [--host H] [--api-token T]    run monitor(s) + webhook server
 *   weclaw send    --text "..." [--to USER] [--account ID]  one-shot forward to a WeChat user
 *   weclaw status                                           list bound accounts + monitors
 *   weclaw accounts                                         list bound accountIds
 *   weclaw logout [--account ID]                            remove a bound account
 *   weclaw help
 */

import process from "node:process";
import { spawnSync } from "node:child_process";

import { IlinkClient } from "./ilink/client.js";
import { runInteractiveLogin } from "./auth/login.js";
import { BridgeServer } from "./bridge/server.js";
import { RelayServer } from "./bridge/relay.js";
import { sendText } from "./bridge/send.js";
import {
  clearAccount,
  listAccountIds,
  loadAccount,
  resolveAccount,
} from "./store/account.js";
import { getContextToken } from "./store/account.js";
import { Logger } from "./util/log.js";
import {
  serviceInstall,
  serviceUninstall,
  serviceStatus,
  serviceRestart,
} from "./service/install.js";
import { deployRemote } from "./service/deploy.js";
import { runHook } from "./hooks/hook.js";
import { runCodexHook, installCodexHooks, uninstallCodexHooks } from "./hooks/codex.js";
import { installHooks, uninstallHooks } from "./hooks/install.js";
import { listSessions } from "./store/sessions.js";
import { searchArchive } from "./store/archive.js";

interface ParsedArgs {
  command: string;
  flags: Record<string, string>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const eq = key.indexOf("=");
      if (eq >= 0) {
        flags[key.slice(0, eq)] = key.slice(eq + 1);
      } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        flags[key] = args[++i];
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(a);
    }
  }
  return { command: positional[0] ?? "help", flags, positional };
}

function help(): void {
  process.stdout.write(`\
weclaw — standalone WeChat ClawBot bridge (no openclaw required)

用法:
  weclaw login   绑定微信 ClawBot（终端扫码）
    --base-url URL         覆盖 iLink 服务地址
    --channel-version V    声明的插件版本号
    --verbose              打印轮询进度

  weclaw start   运行入站监听 + webhook 服务
    --port N               端口 (默认 4789 或 WECLAW_PORT)
    --host H               监听地址 (默认 127.0.0.1)
    --api-token T          保护写接口的 Bearer token (默认 WECLAW_API_TOKEN)
    --inbound-webhook URL  把入站消息镜像到该 URL (默认 WECLAW_INBOUND_WEBHOOK)
    --disable-login true   关闭 /login/* 端点 (公网部署建议)
    --allow-ips IP,IP      非健康检查端点的 IP 白名单 (逗号分隔)
    --trust-proxy true     信任 X-Forwarded-For (反代后必填)
    --rate-limit N         每个 IP 每分钟 /send 上限 (0=不限)

  weclaw relay   本地中继：claude 在本地、桥接在服务器时使用
    --remote URL           服务器桥接地址 (必填，或 WECLAW_REMOTE_URL)
    --api-token T          服务器桥接的 Bearer token
    --port N               本地监听端口 (默认 4789，让 skill/hooks 零改动)
    --host H               本地监听地址 (默认 127.0.0.1)

  weclaw hooks <install|uninstall>  注册/移除 Claude Code hooks (双向触发面)
    --local true          写到项目 ./.claude 而非 ~/.claude
    --target URL          分发器推送目标 (默认 127.0.0.1:4789，即本地 relay)
    --token T / --api-token T
    --notify-stop true    claude 停止时把摘要推到微信
    --high-risk "Bash(git push *),Bash(rm -rf *)"  高危工具告警
    --async-rewake false  关闭回合制回复注入
    --codex true          同时把 Codex CLI notify 写进 ~/.codex/config.toml

  weclaw hooks codex <install|uninstall>  单独管理 Codex CLI notify 钩子

  weclaw hook        Claude Code hooks 分发器 (由 claude 自动调用，读 stdin)
  weclaw codex-hook  Codex CLI notify 分发器 (由 codex 自动调用，读 argv)

  weclaw deploy  一键把桥接部署到你的服务器 (SSH 进去装、迁凭证、配 HTTPS)
    --ssh user@host        SSH 目标 (必填，或 WECLAW_DEPLOY_SSH)
    --ssh-port N / --ssh_identity FILE
    --domain D             公网域名 (nginx 反代；TLS 由你在服务器侧配置)
    --allow-ips IP,IP      服务器 IP 白名单
    --api-token T          自定义 token (不填则自动生成)

  weclaw send    单次把一段文字转发给微信用户
    --text "..."           要发送的内容 (必填)
    --to USER              目标用户 (xxx@im.wechat)；缺省用绑定时扫码的用户
    --account ID           指定账号 (多账号时必填)

  weclaw config  在浏览器打开推送规则配置面板（事件开关/高危工具/关键词/免打扰）
    --port N / --host H     指定桥接地址（默认 127.0.0.1:4789）

  weclaw status  列出已绑定账号
  weclaw accounts 列出 accountId
  weclaw logout  [--account ID]  解绑账号
  weclaw service <install|uninstall|status|restart>
                          安装/卸载/查询/重启后台自启服务 (systemd / launchd / 计划任务)
  weclaw help    显示本帮助

环境变量:
  WECLAW_STATE_DIR         状态目录 (默认 ~/.weclaw-bridge)
  WECLAW_PORT / WECLAW_HOST / WECLAW_API_TOKEN / WECLAW_INBOUND_WEBHOOK
  WECLAW_DISABLE_LOGIN=1   关闭 /login/* (公网部署)
  WECLAW_ALLOW_IPS=IP,IP   IP 白名单
  WECLAW_TRUST_PROXY=1     信任 X-Forwarded-For (反代后)
  WECLAW_RATE_LIMIT=N      每 IP 每分钟 /send 上限
  WECLAW_NO_REDACT=1       关闭出站脱敏
  OPENCLAW_STATE_DIR       复用已有 openclaw 绑定 (可选)

webhook 接口 (start 后可用):
  GET  /health               存活 + monitor/SSE/队列概览 (公开)
  GET  /status               账号 + 监听 + token 新鲜度 + 队列
  GET  /accounts             列出 accountId
  GET  /events               SSE 入站消息流 (可按 ?accountId / ?userId / ?session 过滤)
  POST /send            { "text": "...", "to"?, "account"? }
  POST /login/start     → { qrcodeUrl, qrcodePayload, sessionKey }
  POST /login/wait      { "sessionKey", "verifyCode"? }
`);
}

function assert(condition: unknown, msg: string): asserts condition {
  if (!condition) {
    process.stderr.write(`错误: ${msg}\n`);
    process.exit(1);
  }
}

async function cmdLogin(flags: Record<string, string>): Promise<void> {
  await runInteractiveLogin({
    baseUrl: flags["base-url"],
    channelVersion: flags["channel-version"],
    verbose: Boolean(flags.verbose),
  });
}

async function cmdStart(flags: Record<string, string>): Promise<void> {
  const log = new Logger();
  const server = new BridgeServer({
    port: flags.port ? Number(flags.port) : undefined,
    host: flags.host,
    apiToken: flags["api-token"],
    inboundWebhook: flags["inbound-webhook"],
    baseUrl: flags["base-url"],
    channelVersion: flags["channel-version"],
    disableLogin: flags["disable-login"] === "true" ? true : undefined,
    allowIps: flags["allow-ips"] ? flags["allow-ips"].split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    trustProxy: flags["trust-proxy"] === "true" ? true : undefined,
    rateLimitPerMin: flags["rate-limit"] ? Number(flags["rate-limit"]) : undefined,
    logger: log,
  });

  const shutdown = async (signal: string) => {
    log.info(`received ${signal}, shutting down…`);
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.start();
}

function cmdHooks(positional: string[], flags: Record<string, string>): void {
  const sub = positional[1] ?? "install";
  const log = new Logger();
  switch (sub) {
    case "install": {
      installHooks({
        global: flags.local !== "true", // default global; --local true → project
        target: flags.target ?? process.env.WECLAW_HOOK_TARGET,
        token: flags.token ?? flags["api-token"] ?? process.env.WECLAW_API_TOKEN,
        notifyStop: flags["notify-stop"] === "true",
        notifyNotification: flags["notify-notification"] !== "false",
        highRiskTools: flags["high-risk"] ? flags["high-risk"].split(",").map((s) => s.trim()).filter(Boolean) : [],
        asyncRewake: flags["async-rewake"] !== "false",
        logger: log,
      });
      // Optionally also wire Codex CLI's notify hook in the same install.
      if (flags.codex === "true") {
        const r = installCodexHooks({
          highRiskTools: flags["high-risk"] ? flags["high-risk"].split(",").map((s) => s.trim()).filter(Boolean) : [],
        });
        log.info(`codex hooks → ${r.file}`);
      }
      process.stdout.write("\n✅ hooks installed. 让 claude 重新加载会话即可生效。\n");
      return;
    }
    case "codex": {
      // weclaw hooks codex install|uninstall — manage ~/.codex/hooks.json
      const action = positional[2] ?? "install";
      if (action === "uninstall" || action === "remove") {
        const r = uninstallCodexHooks();
        process.stdout.write(r.removed > 0 ? `✅ 已从 ${r.file} 移除 ${r.removed} 个 Codex hooks\n` : `${r.file} 中未找到 weclaw hooks\n`);
        return;
      }
      const r = installCodexHooks({
        highRiskTools: flags["high-risk"] ? flags["high-risk"].split(",").map((s) => s.trim()).filter(Boolean) : [],
      });
      process.stdout.write(`✅ Codex hooks 已写入 ${r.file}（SessionStart/Stop/PermissionRequest${flags["high-risk"] ? "/PostToolUse" : ""}）\n`);
      return;
    }
    case "uninstall":
    case "remove":
      uninstallHooks({ global: flags.local !== "true", logger: log });
      if (flags.codex === "true") uninstallCodexHooks();
      return;
    default:
      process.stderr.write(`未知的 hooks 子命令: ${sub}\n  可用: install | uninstall\n`);
      process.exitCode = 1;
  }
}

function cmdDeploy(flags: Record<string, string>): void {
  const ssh = flags.ssh ?? process.env.WECLAW_DEPLOY_SSH;
  assert(typeof ssh === "string" && ssh.length > 0, "--ssh user@host 必填（或设 WECLAW_DEPLOY_SSH）");
  const result = deployRemote({
    ssh,
    sshPort: flags["ssh-port"] ? Number(flags["ssh-port"]) : undefined,
    sshIdentity: flags["ssh-identity"] ?? process.env.WECLAW_DEPLOY_IDENTITY,
    domain: flags.domain ?? process.env.WECLAW_DEPLOY_DOMAIN,
    port: flags.port ? Number(flags.port) : undefined,
    apiToken: flags["api-token"],
    allowIps: flags["allow-ips"],
  });
  process.stdout.write(
    "\n" + JSON.stringify({ ok: result.ok, remoteUrl: result.remoteUrl, smoke: result.smoke, error: result.error }, null, 2) + "\n",
  );
  if (!result.ok) process.exitCode = 1;
}

async function cmdRelay(flags: Record<string, string>): Promise<void> {
  const remote = flags.remote ?? process.env.WECLAW_REMOTE_URL;
  assert(typeof remote === "string" && remote.length > 0, "--remote <url> 必填（或设 WECLAW_REMOTE_URL），指向服务器上的桥接");
  const log = new Logger();
  const relay = new RelayServer({
    remoteUrl: remote,
    token: flags["api-token"] ?? process.env.WECLAW_API_TOKEN,
    port: flags.port ? Number(flags.port) : undefined,
    host: flags.host,
    logger: log,
  });
  const shutdown = async (signal: string) => {
    log.info(`received ${signal}, shutting down…`);
    await relay.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  await relay.start();
}

async function cmdSend(flags: Record<string, string>): Promise<void> {
  const text = flags.text;
  assert(typeof text === "string" && text.length > 0, "--text 为必填项");
  const account = resolveAccount(flags.account);
  assert(account.configured, `账号 ${account.accountId} 未配置，请先运行 weclaw login`);

  const to = flags.to?.trim() || account.userId;
  assert(to, "未指定 --to，且该账号没有已绑定的 userId（收件人需先给 bot 发过消息）");

  const client = new IlinkClient({
    baseUrl: account.baseUrl,
    token: account.token,
    channelVersion: flags["channel-version"],
  });
  const contextToken = getContextToken(account.accountId, to);
  const { messageId } = await sendText(client, { to, text, contextToken });
  process.stdout.write(
    JSON.stringify({ ok: true, account: account.accountId, to, messageId }, null, 2) + "\n",
  );
}

function cmdStatus(): void {
  const ids = listAccountIds();
  if (ids.length === 0) {
    process.stdout.write("尚未绑定任何账号。运行 `weclaw login` 开始。\n");
    return;
  }
  for (const id of ids) {
    const data = loadAccount(id);
    process.stdout.write(
      `• ${id}\n    userId: ${data?.userId ?? "(未知)"}\n    baseUrl: ${data?.baseUrl ?? "(默认)"}\n    configured: ${data?.token ? "yes" : "no"}\n`,
    );
  }
}

function cmdAccounts(): void {
  const ids = listAccountIds();
  process.stdout.write(JSON.stringify({ accounts: ids }, null, 2) + "\n");
}

function cmdConfig(flags: Record<string, string>): void {
  const port = flags.port ? Number(flags.port) : Number(process.env.WECLAW_PORT) || 4789;
  const host = flags.host ?? process.env.WECLAW_HOST ?? "127.0.0.1";
  const url = `http://${host}:${port}/`;
  const plat = process.platform;
  const opener = plat === "darwin" ? "open" : plat === "win32" ? "start" : "xdg-open";
  process.stdout.write(`配置面板：${url}\n`);
  try {
    spawnSync(opener, [url], { stdio: "ignore", shell: plat === "win32" });
  } catch {
    process.stdout.write(`（无法自动打开浏览器，请手动访问上面的 URL）\n`);
  }
}

function cmdSessions(): void {
  const sessions = listSessions();
  if (sessions.length === 0) {
    process.stdout.write("暂无已注册的 claude 会话（会话在首次 /send 或 SessionStart hook 后自动登记）。\n");
    return;
  }
  for (const s of sessions) {
    const age = Math.round((Date.now() - s.lastActive) / 1000);
    process.stdout.write(
      `• [${s.label}] ${s.sessionId}\n    user: ${s.userId ?? "(未绑定)"}  account: ${s.accountId ?? "?"}  活跃: ${age}s 前\n`,
    );
  }
}

function cmdSearch(flags: Record<string, string>): void {
  const q = flags.query ?? "";
  assert(typeof q === "string" && q.length > 0, "--query <关键词> 必填");
  const results = searchArchive(q, flags.limit ? Number(flags.limit) : undefined);
  if (results.length === 0) {
    process.stdout.write("（无匹配记录）\n");
    return;
  }
  for (const r of results) {
    const dir = r.dir === "in" ? "←" : "→";
    const time = new Date(r.ts).toISOString();
    process.stdout.write(`${time} ${dir} [${r.accountId}] ${r.text.slice(0, 120)}${r.text.length > 120 ? "…" : ""}\n`);
  }
}

function cmdLogout(flags: Record<string, string>): void {
  const ids = listAccountIds();
  if (ids.length === 0) {
    process.stdout.write("没有可解绑的账号。\n");
    return;
  }
  const target = flags.account?.trim() || (ids.length === 1 ? ids[0] : undefined);
  assert(target, "存在多个账号，请用 --account 指定");
  clearAccount(target);
  process.stdout.write(`已解绑账号 ${target}\n`);
}

function cmdService(positional: string[], flags: Record<string, string>): void {
  const sub = positional[1] ?? "status";
  const log = new Logger();
  const cfg = {
    port: flags.port,
    host: flags.host,
    apiToken: flags["api-token"] ?? process.env.WECLAW_API_TOKEN,
    inboundWebhook: flags["inbound-webhook"] ?? process.env.WECLAW_INBOUND_WEBHOOK,
    relay: flags.relay === "true",
    remoteUrl: flags.remote ?? process.env.WECLAW_REMOTE_URL,
  };
  switch (sub) {
    case "install":
      return serviceInstall(cfg, log);
    case "uninstall":
    case "remove":
      return serviceUninstall(log);
    case "restart":
      return serviceRestart(log);
    case "status":
      return serviceStatus(log);
    default:
      process.stderr.write(`未知的 service 子命令: ${sub}\n  可用: install | uninstall | status | restart\n`);
      process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const { command, flags, positional } = parseArgs(process.argv);
  switch (command) {
    case "login":
      return await cmdLogin(flags);
    case "start":
      return await cmdStart(flags);
    case "relay":
      return await cmdRelay(flags);
    case "deploy":
      return cmdDeploy(flags);
    case "hooks":
      return cmdHooks(positional, flags);
    case "hook":
      return await runHook();
    case "codex-hook":
      return await runCodexHook();
    case "send":
      return await cmdSend(flags);
    case "status":
      return cmdStatus();
    case "accounts":
      return cmdAccounts();
    case "sessions":
      return cmdSessions();
    case "search":
      return cmdSearch(flags);
    case "config":
      return cmdConfig(flags);
    case "logout":
      return cmdLogout(flags);
    case "service":
      return cmdService(positional, flags);
    case "help":
    case "--help":
    case "-h":
    default:
      return help();
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${String(err)}\n`);
  process.exit(1);
});
