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

import { IlinkClient } from "./ilink/client.js";
import { runInteractiveLogin } from "./auth/login.js";
import { BridgeServer } from "./bridge/server.js";
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

  weclaw send    单次把一段文字转发给微信用户
    --text "..."           要发送的内容 (必填)
    --to USER              目标用户 (xxx@im.wechat)；缺省用绑定时扫码的用户
    --account ID           指定账号 (多账号时必填)

  weclaw status  列出已绑定账号
  weclaw accounts 列出 accountId
  weclaw logout  [--account ID]  解绑账号
  weclaw service <install|uninstall|status|restart>
                          安装/卸载/查询/重启后台自启服务 (systemd / launchd / 计划任务)
  weclaw help    显示本帮助

环境变量:
  WECLAW_STATE_DIR         状态目录 (默认 ~/.weclaw-bridge)
  WECLAW_PORT / WECLAW_HOST / WECLAW_API_TOKEN / WECLAW_INBOUND_WEBHOOK
  OPENCLAW_STATE_DIR       复用已有 openclaw 绑定 (可选)

webhook 接口 (start 后可用):
  GET  /health
  GET  /status
  GET  /accounts
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
    case "send":
      return await cmdSend(flags);
    case "status":
      return cmdStatus();
    case "accounts":
      return cmdAccounts();
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
