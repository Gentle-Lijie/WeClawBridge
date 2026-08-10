<p align="center">
  <img src="assets/banner.png" alt="WeClawBridge" width="720">
</p>
<!-- 
<h1 align="center">
  <img src="assets/icon.png" alt="logo" width="96"><br>
  WeClawBridge
</h1> -->

<p align="center">
  <a href="https://github.com/Gentle-Lijie/WeClawBridge/actions/workflows/ci.yml"><img src="https://github.com/Gentle-Lijie/WeClawBridge/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/weclaw-bridge"><img src="https://img.shields.io/npm/v/weclaw-bridge.svg" alt="npm version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/Gentle-Lijie/WeClawBridge" alt="license"></a>
</p>

独立、跨平台的微信 **ClawBot**（iLink）协议桥接 —— **无需安装 openclaw 本体**，即可绑定微信 ClawBot 并把任意指令/消息转发到微信。

WeClawBridge 重新实现了 `@tencent-weixin/openclaw-weixin` 插件所用的 iLink HTTP 协议（`ilinkai.weixin.qq.com`）。openclaw 只是一个"宿主框架"，插件本身才是协议实现，因此本桥接可以完全脱离它独立运行。

## 特性

- ✅ **无需 openclaw**：纯协议复刻，零宿主依赖
- ✅ **跨平台 / 跨运行时**：仅用标准 API（`fetch` / `node:http` / `node:crypto`），Node ≥ 18、Bun、Deno 均可
- ✅ **二维码绑定**：终端渲染二维码，手机微信扫码即绑
- ✅ **Webhook 服务**：`POST /send` 把指令转发给微信用户
- ✅ **入站监听**：`getUpdates` 长轮询保活，自动捕获 `context_token`
- ✅ **开机自启**：`weclaw service install` 自动生成 systemd / launchd / 计划任务
- ✅ **Claude Code Skill**：自带一个自愈型 skill `/weclaw-bridge`
- ✅ **多账号**：支持绑定多个微信账号

## ⚠️ 合规与风险提示（务必阅读）

本项目是对微信 ClawBot（iLink）公开协议的**独立重新实现**，仅供学习与个人实验。使用前请对照腾讯《微信 ClawBot 功能使用条款》自行评估：

- **未破解任何技术保护**：本桥接使用与官方插件相同的 iLink 协议和二维码登录流程，未进行 hook、抓包破解或绕过反作弊机制。
- **但属于未授权客户端类型**：官方授权路径为 `openclaw 宿主 + 官方插件`。依据条款 **4.7**，腾讯保留决定可使用的客户端类型、并对未授权客户端采取**风险提示、拦截、封禁**的权利。
- **账号与服务风险**：不走官方路径，可能被认定为条款 **4.6**（绕开技术保护措施）情形，触发 **6.1 / 6.4** 违约处理——从警告、暂停服务，到**终止微信账号服务**。
- **用途偏离**：ClawBot 设计用途是连接"用户自己部署的第三方 AI 服务"（条款 **3.1 / 4.3**）。将其用作通用推送/通知通道偏离预期用途。
- **数据合规**：条款 **5.1** 要求涉及他人个人信息的内容须在授权范围内使用；转发内容请确保合法合规、已获授权。

**正式或商用场景请使用官方 openclaw 路径。** 本项目作者不对因使用本工具导致的任何账号限制、服务中断或法律后果承担责任。使用即代表你已阅读、理解并接受上述全部风险。

## 安装

### 方式一：npx（无需安装，直接用）

```bash
npx -y weclaw-bridge login     # 绑定
npx -y weclaw-bridge start     # 运行
```

### 方式二：全局安装

```bash
npm install -g weclaw-bridge
weclaw login
weclaw start
```

> 安装时会自动检测你的系统（Linux/macOS/Windows）并打印对应的开机自启指引。CI 环境下自动静默（设 `WECLAW_SKIP_POSTINSTALL=1` 可彻底关闭）。

### 方式三：从源码

```bash
git clone https://github.com/LijieZhou/WeClawBridge.git
cd WeClawBridge
npm install && npm run build
node bin/weclaw.mjs login
```

## 5 分钟快速开始

```bash
# 1) 绑定（终端出现二维码，用手机微信扫描并输入配对数字）
weclaw login

# 2) 启动桥接服务（监听 + webhook，默认 http://127.0.0.1:4789）
weclaw start

# 3) 在手机微信里给 ClawBot 发一条 "hello"（首次必需，用于建立会话）

# 4) 转发一条指令到微信
curl -X POST http://127.0.0.1:4789/send \
  -H "Content-Type: application/json" \
  -d '{"text":"你好，这是来自桥接的测试"}'
```

手机微信收到消息即代表链路打通。

## 工作原理

```
                你的指令                      微信 App
                   │                            │
                   ▼                            │
        ┌─────────────────────┐                 │
        │  WeClawBridge       │  iLink HTTP     │
        │  (本工具)            │ ◄──────────────►│  ilinkai.weixin.qq.com
        │  - getUpdates 长轮询 │                 │
        │  - sendMessage      │                 │
        │  - webhook /send    │                 │
        └─────────────────────┘                 │
                   ▲                            ▼
              webhook 调用                  用户在微信里收到消息
       (外部 agent / Claude / 脚本)
```

- **绑定**：`get_bot_qrcode` → 扫码 → 长轮询 `get_qrcode_status`（含配对码校验、过期刷新、IDC 重定向）→ `confirmed` 后保存 `bot_token` / `accountId` / `userId`。
- **转发**：webhook 收到 `{text, to?}` → 用缓存好的 `context_token` 调 `sendmessage` → 微信用户收到消息。

## CLI 命令

| 命令 | 说明 |
|------|------|
| `weclaw login` | 终端扫码绑定微信 ClawBot |
| `weclaw start` | 运行入站监听 + webhook 服务 |
| `weclaw send --text "..."` | 单次把文字转发给微信用户 |
| `weclaw status` | 列出已绑定账号 |
| `weclaw accounts` | 以 JSON 列出 accountId |
| `weclaw logout [--account ID]` | 解绑账号 |
| `weclaw service install` | 安装开机自启服务（systemd / launchd / 计划任务） |
| `weclaw service uninstall` | 卸载自启服务 |
| `weclaw service status` | 查看服务运行状态 |
| `weclaw service restart` | 重启服务 |

常用参数：`--port`、`--host`、`--api-token`、`--to`、`--account`、`--base-url`。

## 开机自启（systemd / launchd / Windows）

`weclaw service install` 会按当前系统生成并启用对应服务：

| 系统 | 服务类型 | 路径 |
|------|---------|------|
| Linux | systemd user unit | `~/.config/systemd/user/weclaw-bridge.service` |
| macOS | launchd LaunchAgent | `~/Library/LaunchAgents/com.weclaw.bridge.plist` |
| Windows | 计划任务（登录时运行） | 任务名 `weclaw-bridge` |

```bash
weclaw service install --port 4789 --host 127.0.0.1   # 安装并启动
weclaw service status                                  # 查看状态
weclaw service restart                                 # 重启
weclaw service uninstall                               # 卸载
```

- Linux：会尝试 `loginctl enable-linger`（让服务在未登录时也运行），需要时可加 sudo。
- macOS：日志写入 `~/.weclaw-bridge/weclaw.log` 与 `weclaw.err.log`。
- 服务用 `node <包路径>/dist/cli.js start` 启动，环境变量（端口/host/token）写入服务单元。

## Webhook 接口

| Method | Path | Body | 说明 |
|--------|------|------|------|
| GET | `/health` | — | 存活检查（公开） |
| GET | `/status` | — | 账号 + 监听状态 |
| GET | `/accounts` | — | 列出 accountId |
| POST | `/send` | `{"text","to"?,"account"?}` | 转发文字到微信 |
| POST | `/login/start` | — | 拉取二维码，返回 `{qrcodeUrl, sessionKey}` |
| POST | `/login/wait` | `{"sessionKey","verifyCode"?}` | 轮询登录状态 |

鉴权：设置 `WECLAW_API_TOKEN` 后，除 `/health` 外需 `Authorization: Bearer <token>`。

错误码：`400` 参数错误 · `401` 未授权 · `404` 未绑定账号 · `409` 账号未配置 · `502` 发送失败（`ret=-2 prepare failed` 多为缺 `context_token`；`errcode=-14` 为 token 失效需重新登录）。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `WECLAW_STATE_DIR` | `~/.weclaw-bridge` | 状态目录（凭证 / sync buf / context token） |
| `WECLAW_PORT` | `4789` | webhook 端口 |
| `WECLAW_HOST` | `127.0.0.1` | 监听地址 |
| `WECLAW_API_TOKEN` | — | webhook 写接口的 Bearer token |
| `WECLAW_INBOUND_WEBHOOK` | — | 把收到的微信消息镜像到该 URL（实现"微信→外部 agent"反向通知） |
| `OPENCLAW_STATE_DIR` | — | 复用已有 openclaw 绑定（可选） |
| `WECLAW_SKIP_POSTINSTALL` | — | 安装时跳过平台提示横幅 |

## 完整测试指南

### 冒烟测试（无需手机）

```bash
npm install && npm run build

# CLI 基础
weclaw help          # 打印用法
weclaw status        # 提示"尚未绑定任何账号"
weclaw accounts      # {"accounts":[]}

# 真实拉取二维码（验证与 ilinkai.weixin.qq.com 连通，不扫码，Ctrl+C 退出）
weclaw login

# 服务起停 + 错误码
WECLAW_PORT=4791 WECLAW_API_TOKEN=test123 weclaw start &
sleep 1.5
curl -s http://127.0.0.1:4791/health                                       # → {"ok":true}
curl -s -o /dev/null -w "%{http}\n" http://127.0.0.1:4791/status           # → 401
curl -s -H "Authorization: Bearer test123" http://127.0.0.1:4791/status    # → {"accounts":[]}
curl -s -w "%{http}\n" -X POST -H "Authorization: Bearer test123" \
     -H "Content-Type: application/json" -d '{}' http://127.0.0.1:4791/send # → 400
kill %1
```

### 端到端测试（需要手机微信）

```bash
# 1. 绑定
weclaw login            # 扫码 → 看到 "✅ 已绑定"

# 2. 启动服务（常驻）
weclaw start

# 3. 手机微信 ClawBot 对话里发一条 "hello"
#    （服务端日志应出现 inbound from=...@im.wechat: hello）

# 4. 转发
curl -X POST http://127.0.0.1:4789/send \
  -H "Content-Type: application/json" -d '{"text":"桥接测试：你好"}'
# → {"ok":true,...}，手机收到消息即成功
```

### 自动化测试矩阵（CI 已覆盖）

GitHub Actions 在 `ubuntu / macos / windows` × `Node 18/20/22` 上运行 `typecheck + build + CLI 冒烟`。打 `v*` tag 自动发布到 npm。

## 作为库使用

```ts
import { IlinkClient, loginWithQr, sendText } from "weclaw-bridge";

const result = await loginWithQr({ verbose: true });           // 绑定
const client = new IlinkClient({ baseUrl: result.baseUrl, token: result.botToken });
await sendText(client, { to: result.userId, text: "hello" });  // 转发
```

## Claude Code Skill

自带的 `/weclaw-bridge` skill 是**自愈型**的：服务没起会自动后台拉起，没绑账号会引导 `login`，发送遇到 `prepare failed` 会提示用户先在微信发条消息建立会话。

- 全局可用：`~/.claude/skills/weclaw-bridge/`
- 仓库内：`skill/weclaw-bridge/SKILL.md`（提交到 git）

安装到本地全局：
```bash
mkdir -p ~/.claude/skills && cp -r skill/weclaw-bridge ~/.claude/skills/
```

之后在任意 Claude Code 会话里说"用 weclaw-bridge 把 xxx 发到微信"即可。

## 跨运行时

编译产物 `dist/` 仅依赖标准 Web API + Node 内建模块：

```bash
node bin/weclaw.mjs start
bun  bin/weclaw.mjs start
deno run --allow-net --allow-read --allow-write --allow-env bin/weclaw.mjs start
```

## 项目结构

```
src/
├── ilink/        # 协议层：types + HTTP client
├── store/        # 账号 / sync buf / context token 持久化
├── auth/         # 二维码登录流程
├── bridge/       # 监听循环 + webhook server + 发送
├── service/      # systemd/launchd/计划任务 自启管理
├── util/         # id / logger
├── index.ts      # 公共 API
└── cli.ts        # CLI 入口
bin/
├── weclaw.mjs        # CLI 启动器
└── postinstall.mjs   # 平台识别 + 自启指引
skill/weclaw-bridge/SKILL.md   # Claude Code skill
.github/workflows/ci.yml       # CI
```

## 重要说明

- **首次回复需 context_token**：微信要求回复必须携带入站消息的 `context_token`。绑定后，目标用户需先在微信里给 ClawBot 发过至少一条消息（桥接会自动捕获 token）；或显式传 `--to <xxx@im.wechat>`。
- 本项目是对公开协议的独立实现，仅用于学习与个人桥接实验。
- 凭证文件权限设为 `0600`，请勿提交到版本库（`.weclaw/` 已在 `.gitignore`）。

## 许可证

MIT
