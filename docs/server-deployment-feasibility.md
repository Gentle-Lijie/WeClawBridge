# 服务端自部署可行性评估

> 把 WeClawBridge 服务端放到用户自己的服务器（VPS / 云主机 / 家用 NAS）上运行，从而让 webhook 功能对公网（或受控网络）可达。
>
> **版本** v0.1 · 2026-08-13
> 本评估基于对 `src/ilink/client.ts`、`src/bridge/server.ts`、`src/auth/login.ts` 的代码审查。涉及腾讯服务端风控的部分属于协议黑盒，标注为「待实测」。

---

## 摘要（结论先行）

- **技术上可行。** 桥接只用 `fetch` / `node:http` / `node:crypto`，Linux + Node ≥ 18 无需任何改造即可在服务器常驻；已有 `weclaw service install` 生成 systemd unit。
- **协议层不绑 IP。** iLink 请求不带持久设备指纹（`X-WECHAT-UIN` 每次随机），`bot_token` 是纯凭证，可随状态目录迁移到服务器，无需在服务器重新扫码绑定。
- **当前 webhook 实现不可直接公网暴露。** 默认 `127.0.0.1` 是安全的；一旦改成对外监听，若无 `WECLAW_API_TOKEN`，`/send` 即裸奔——任何人可往你的微信发消息 / 触发指令。必须前置反向代理 + TLS + 强制鉴权。
- **核心未知是腾讯侧 IP 风控。** 代码层不报客户端 IP，但服务端可能基于 TCP 源 IP 做异常检测。换地域 / 换 IP 长跑是否触发 `errcode` 或封禁，**只能实测**。
- **合规面收紧。** 7×24 常驻 + 对外 webhook + 凭证迁移，比「本地个人实验」更偏离官方预期用途，违约认定风险上升。

**建议**：自用、低频、不公开端点；部署形态选「服务器 + 反向代理（TLS）+ 强制 token + IP 白名单 + 关闭 `/login/*`」，并以「本地绑定 → 拷贝凭证 → 服务器独占运行」的方式上线。

---

## 一、目标：什么是「webhook 功能」

本桥接里有两种 webhook 语义，本地部署都受限，服务器部署同时解决两者：

| | 方向 | 本地部署的限制 | 服务器部署后 |
|---|---|---|---|
| **A. 出站 webhook** | 外部 → 微信 | `/send` 仅 `127.0.0.1` 可达，公网服务调不到 | 公网服务可直接 `POST https://your-server/send` → 微信 |
| **B. 入站 webhook** | 微信 → 外部 | `WECLAW_INBOUND_WEBHOOK` 目标必须公网可达；本地桥接能出站但受网络环境限制 | 服务器出站稳定，可推到任意公网 / 同机服务 |

用户场景通常是 A：把微信变成一个**公网可达的通知/推送通道**，从任意 agent、脚本、手机快捷指令触发。

---

## 二、技术可行性（逐项，基于代码）

### 2.1 运行时与部署 ✓

- 纯标准 API（`fetch` / `node:http` / `node:crypto`），Linux 服务器 Node ≥ 18 直接跑，无原生依赖。
- 已有 `weclaw service install` 生成 systemd user unit（`src/service/install.ts`），开箱即得常驻 + 开机自启 + 日志。
- 长轮询 `getUpdates` 本来就需要 7×24 保活，服务器常驻是更自然的运行环境，而非更差。

### 2.2 凭证与 IP 绑定 ✓（代码层）/ ⚠（风控层待实测）

代码审查结论：

- `authHeaders()`（`client.ts:119-128`）只发 `iLink-App-Id`、`iLink-App-ClientVersion`、`AuthorizationType`、`Authorization: Bearer <token>`、`X-WECHAT-UIN`。
- `X-WECHAT-UIN` 由 `randomWechatUin()`（`client.ts:59-62`）**每次请求随机生成**，不是持久设备指纹。
- 协议层**不主动上报客户端真实 IP**。
- 绑定流程 `confirmed` 分支（`login.ts:156-165`）只持久化 `bot_token` / `accountId` / `baseUrl` / `userId`，不记录绑定时的客户端 IP。

**含义**：`bot_token` 是纯凭证，**换机器、换 IP、换地域，代码层都能正常工作**。这也意味着凭证可以拷贝迁移（见 2.3）。

**未知**：腾讯服务端可能基于 TCP 源 IP 做风控（异地登录、IDC IP 段、流量异常等）。这层在协议黑盒内，代码无法预判，**必须实测**（见 §7）。

### 2.3 部署方式：凭证迁移，无需服务器扫码 ✓

服务器通常无交互终端，扫码绑定不便。利用 2.2 的「纯凭证」特性，可以：

1. 在**本地**跑 `weclaw login` 完成扫码绑定，生成状态目录；
2. 把 `~/.weclaw-bridge/openclaw-weixin/`（含 `accounts.json`、`<id>.json`、`<id>.sync.json`、`<id>.context-tokens.json`）整体拷到服务器同路径（权限 `0600`）；
3. 服务器 `weclaw start` 独占运行。

> **关键约束：同一 `bot_token` 不能两处同时长轮询。** `get_updates_buf` 会被两边抢、消息错乱，还可能触发风控。部署是**转移**（本地停掉），不是**复制共用**。这也正是「做成 openclaw 扩展复用同一 session」思路要解决的，但那是另一条路（见 `feature-roadmap.md`）。

### 2.4 context_token 与发送链路 ✓

`context_token` 在服务器侧由 inbound monitor 捕获（`monitor.ts`）、`/send` 时读取（`server.ts:304`）。整条「捕获 → 发送」都在服务器自洽完成，不依赖本地。✓

---

## 三、安全评估：当前实现的公网暴露面 🔴

审查 `server.ts`，当前实现**默认安全（`127.0.0.1`），但不具备直接公网暴露的条件**：

| 问题 | 代码位置 | 风险 |
|---|---|---|
| 无 TLS | `http.createServer`（`server.ts:126`） | token、消息内容明文传输 |
| 无 token 时全裸奔 | `authorized()` 在 `apiToken` 未设时直接 `return true`（`server.ts:211-212`） | 任何人可调 `/send` 往你微信发消息 / 触发 claude 指令 |
| `/login/*` 对外 | 路由（`server.ts:247-253`） | 远程触发绑定流程，可能被用来劫持账号 |
| 无速率限制 | 全局 | 滥用、刷指令 |
| 无 IP 白名单 | 全局 | 暴力扫描、未授权访问 |
| token 可走 query | `?token=`（`server.ts:216`） | 易泄露进访问日志 / Referer |
| `/status` 泄露账号 | `status()`（`server.ts:258-271`） | 暴露 accountId / userId / 监听状态 |

**最危险的是 `/send` 裸奔**：一旦无 token 公网可达，等于把「往你微信发任意消息」做成开放接口。若接了 claude 双向（见 `feature-roadmap.md`），更等于「远程指挥你的 claude」。

### 加固清单（公网部署的硬性前提）

1. **反向代理 + TLS**：Caddy / Nginx 前置，`https://`，自动证书；桥接仍听 `127.0.0.1`。
2. **强制 `WECLAW_API_TOKEN`**：长随机串；禁止用 `?token=` query（仅 header `Authorization: Bearer`）。
3. **IP 白名单**：反代层限制源 IP（家里出口 IP / 云函数段 / Tailsula 网段）。
4. **关闭 `/login/*`**：公网部署只复用迁移来的凭证，绑定只在本地做；反代层直接 403 这两个路径。
5. **速率限制**：反代层（`limit_req`）或桥接侧加中间件。
6. **`/health` 之外的端点统一鉴权**，并对 `/status` 脱敏。
7. 凭证文件 `0600`，目录不进版本库（已在 `.gitignore`）。

> 不做 1–4 就公网暴露，等于主动制造一个可被任意人操控你微信 + claude 的后门。

---

## 四、部署形态对比

| 形态 | webhook 可达性 | 安全风险 | 适合场景 |
|---|---|---|---|
| **本地（现状）** | 仅本机 | 低 | 单机开发、自用 |
| **服务器全公网裸奔** | 全球 | 🔴 极高 | ❌ 不可接受 |
| **服务器 + 反代 + TLS + token + 白名单** | 全球（受控） | 🟡 中可控 | ✅ 推荐：需外部服务触发推送 |
| **服务器 + Tailscale 私网** | 仅私网设备 | 🟢 低 | ✅ 多台自有设备互访，不触公网 |
| **服务器跑桥接，claude 在本地** | 跨设备 | 🟡 中 | 需要额外的跨设备链路（见下） |

---

## 五、与 claude / openclaw 的关系

把桥接放服务器后，要回答「claude 在哪跑」：

- **claude 也在服务器**：同机，`127.0.0.1` 即可，无跨设备问题。最简单。适合「服务器跑一个常驻 claude agent」。
- **claude 在本地，桥接在服务器**：又回到「运行 claude 的设备 ↔ openclaw/桥接」的跨设备链路问题，已在 `feature-roadmap.md` 讨论（Tailscale / 中继 / 隧道三选一）。服务器部署不消除这条链路，只是把桥接端固定在有公网的位置——反而让「中继/隧道」更好搭。
- **做成 openclaw 扩展**：若服务器上本就跑着 openclaw，桥接寄生进去复用其 session，不占名额、合规更稳（见 `feature-roadmap.md` 方向一）。这其实是服务器部署最干净的形态。

---

## 六、合规面

服务器部署**不改变**「独立客户端 = 未授权客户端类型」的性质，反而几个特征会让风险**上升**：

- 7×24 常驻长轮询（更像生产服务，非个人偶发实验）；
- 凭证迁移、异地 IP；
- 对外提供 webhook（偏离「个人学习」叙事，更接近通用推送通道）。

依据腾讯《ClawBot 功能使用条款》4.6 / 4.7 / 6.1 / 6.4，未授权客户端可被风险提示、拦截、封禁，直至终止微信账号服务。服务器常驻 + 公网 webhook 是这些条款更明确的命中情形。

**缓解**：仅自用、不公开端点、低频、不商用；正式或商用场景走官方 openclaw 路径。

---

## 七、待验证项（上线前必做）

| 项 | 方法 | 判定 |
|---|---|---|
| **iLink IP 风控** | 凭证迁移到服务器后，连续长轮询 24–72h | 是否出现新 `errcode`、`ret=-2`、封禁提示 |
| **异地登录提示** | 手机微信是否弹「异地登录」类告警 | 有则说明服务端在做 IP 风控 |
| **IDC IP 段歧视** | 用云厂商 IP vs 家用出口 IP 分别跑 | IDC 段是否更易被拦 |
| **加固链路** | 反代 + TLS + token + 白名单 + 关 `/login` 后做端口扫描与未授权探测 | 确认无非预期暴露 |
| **凭证转移完整性** | 拷贝状态目录后 `weclaw status` / `/status` | 账号、context_token 是否齐全可用 |

---

## 八、结论

| 维度 | 判断 |
|---|---|
| 代码可行性 | ✅ 可行，无 IP 绑定，凭证可迁移 |
| 运行环境 | ✅ Linux + Node ≥ 18，已有 systemd 自启 |
| 公网安全 | 🔴 当前实现不可直接暴露，必须反代 + TLS + 强制 token + 白名单 + 关 `/login` |
| 协议风控 | ⚠️ 黑盒，换 IP 长跑需实测 24–72h |
| 合规 | 🟡 风险高于本地，建议仅自用低频 |

**推荐路径**：

1. 先本地绑定，拷贝凭证到服务器；
2. 服务器前置 Caddy/Nginx（TLS）+ 强制 token + IP 白名单 + 关闭 `/login/*`；
3. 小流量实测 24–72h 观察 iLink 风控；
4. 通过后再接 webhook 调用方与 claude 双向链路。

若服务器上已有 openclaw，优先走「openclaw 扩展寄生」形态（见 `feature-roadmap.md`），既不占名额又合规更稳，比独立服务器部署更值得投入。
