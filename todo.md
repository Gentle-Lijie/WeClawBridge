# WeClawBridge · TODO

> **既定前提**:claude 在本地,桥接在用户自己的服务器。目标:本地 skill/hooks 双向照常工作 + 一键部署服务端。
>
> 版本 v0.1 · 2026-08-13。整合自 `docs/feature-roadmap.md` 与 `docs/server-deployment-feasibility.md`。

---

## 架构总览

```
本地                                                          服务器
┌─ claude 会话 (session_id) ──────────────────┐
│   skill ──┐                                  │
│   hooks ──┤  都打 127.0.0.1 (零改动)         │
│   asyncRewake (Stop 自动起, 读 pending)     │
└───────────┼──────────────────────────────────┘
            │
   ┌────────▼───────── 本地 relay (常驻服务) ───────────────┐
   │  入站: 订阅 GET /events (SSE) → 写 pending/<sid>.json  │
   │  出站: /send 转发 → 带 token + TLS + 队列 + 脱敏        │
   └────────┬───────────────────────────────────────────────┘
            │ https://server  + Bearer
   ─────────┼──────────────────────────────────────────────►
            │
   ┌────────▼────────── 服务器桥接 (weclaw start) ──────────┐
   │  monitor (getUpdates 长轮询, 唯一占 token)             │
   │  POST /send · GET /events(SSE) · GET /health /status   │
   │  (/login/* 公网关闭)                                    │
   └────────┬───────────────────────────────────────────────┘
            │ iLink (ilinkai.weixin.qq.com)
            ▼
          微信 ◄═══► 手机
```

**两条数据流**
- 出站:本地 skill/hooks → relay(127.0.0.1)→ 服务器 /send → iLink → 微信
- 入站:微信 → iLink → 服务器 monitor → /events SSE → 本地 relay → 写 pending → asyncRewake/cron 唤醒本地 claude

---

## 关键设计决策

| 决策 | 说明 |
|---|---|
| **asyncRewake 自动** | hooks 配置挂 Stop,claude 运行时自动起,无需手动启动;one-shot,每轮 Stop 一个新进程 |
| **本地 relay 常驻** | 装成 launchd/systemd 服务(`weclaw service install --relay`),装一次开机自启;不是每次手动起 |
| **skill/hooks 零改动** | 都指向 127.0.0.1 relay,relay 对接服务器;远程细节集中在 relay |
| **同 token 唯一占** | 凭证迁移到服务器后,本地不跑 monitor;relay 不长轮询,只订阅 /events |
| **回合制为主** | 默认 Stop+asyncRewake(等一个回复);异步打断靠 session_crons(可选,有延迟) |

---

## 任务清单

### 阶段 0 · 桥接稳链路(P0 基础,与部署无关)
- [ ] **F1 context_token 自愈**:记录 token 捕获时间;`STALE_TOKEN_ERRCODE`(-14)自动降级攒队列,微信发任意消息触发重捕获后恢复;消除裸 502
- [ ] **F2 出站脱敏**:`/send` 出口加 redactor,正则遮蔽密钥/凭证/私钥块
- [ ] F1/F2 的可观测:日志记录降级/脱敏命中

### 阶段 1 · 服务器端:加固 + events 流
- [ ] **强制鉴权**:`WECLAW_API_TOKEN` 未设时拒绝启动(或仅允许 `127.0.0.1`);禁用 `?token=` query,仅 header Bearer
- [ ] **`GET /events` SSE 端点**:按 `session_id` 过滤,推送 inbound 消息 + 状态变更;供本地 relay 订阅(本地入站通道的 server 侧)
- [ ] **公网关闭 `/login/*`**:配置项 `WECLAW_DISABLE_LOGIN=1`,或反代层 403
- [ ] **IP 白名单**:`WECLAW_ALLOW_IPS` 或交反代层
- [ ] **速率限制**:`/send` 每分钟 N 次
- [ ] **`/status` 脱敏**:不回 userId 明文
- [ ] 健康度增强:`/health` 带 monitor 活性、token 新鲜度

### 阶段 2 · 一键远程部署 `weclaw deploy --ssh`
- [ ] **子命令骨架**:`weclaw deploy --ssh user@host [--domain d] [--email e] [--port 443]`
- [ ] **SSH 探测**:连上后探测 OS / 包管理器 / Node 版本 / 是否有 Caddy
- [ ] **远程装运行时**:按发行版装 Node ≥ 18 + `npm i -g weclaw-bridge`
- [ ] **凭证迁移(原子)**:本地停 monitor → scp `~/.weclaw-bridge/openclaw-weixin/` 到服务器 → 服务器校验 → 本地标记已迁移(防止两处同轮询)
- [ ] **反代 + TLS**:优先 Caddy 自动 HTTPS(需 `--domain`);无域名回退 self-signed + 警告
- [ ] **生成强 token**:服务器侧随机生成,回传本地
- [ ] **systemd 服务**:`weclaw service install` on remote,环境变量(端口/token/禁 login)写入 unit
- [ ] **回填本地配置**:写 `~/.weclaw-bridge/remote.env`(`WECLAW_URL` / `WECLAW_API_TOKEN`),供 relay 读取
- [ ] **冒烟**:`/health` 探活 + 用回填 token 试发一条 → 手机收到即通过
- [ ] **失败回滚**:每步可回滚(scp 失败、Caddy 起不来等)
- [ ] 文档:前置条件(SSH 密钥、域名 A 记录、服务器端口)

### 阶段 3 · 本地 relay(claude 在本地的核心)
- [ ] **`weclaw relay` 子命令**:`--remote <url> --token <t>`,启动本地中继
- [ ] **出站代理**:本地 `POST /send` → 加 Bearer + TLS 转发服务器;本地仍可裸调用
- [ ] **本地队列/脱敏落地**:relay 侧做 F2 脱敏与 F5 队列(早于服务器)
- [ ] **入站订阅**:`GET <remote>/events` SSE,按本机活跃 session 过滤 → 写 `~/.weclaw-bridge/pending/<sid>.json`
- [ ] **relay 模式 `weclaw service install`**:装成 launchd/systemd 常驻,开机自启
- [ ] **断线重连 + 缓存**:服务器不可达时,出站缓存待发、入站自动重连 SSE
- [ ] skill 自愈适配:`/health` 探 relay(本地),relay 没起才本地拉起;不再尝试起 monitor

### 阶段 4 · hooks 双触发面
- [ ] **`weclaw hooks install`**:自动写 `.claude/settings.json`,支持 `--remote`(指向 relay/服务器)与 `--local`(127.0.0.1)
- [ ] **http hook 出站**:Stop / Notification(permission_prompt, idle_prompt, agent_needs_input) / PostToolUse(高危 `if`)→ `/send`
- [ ] **session 注册**:SessionStart/End → `POST /sessions` 登记 session_id(本地 relay 汇总到服务器)
- [ ] **回合制注入(Stop + asyncRewake)**:Stop 挂 asyncRewake 进程,读本地 pending,有微信回复则 `exit 2` 注入 system reminder
- [ ] **异步注入(session_crons,可选)**:周期读 pending 注入,覆盖"不等 Stop 就打断";默认关,文档注明有延迟
- [ ] hooks uninstall / 升级路径

### 阶段 5 · 多会话路由
- [ ] **session 注册表**:服务器 + relay 维护 `session_id → {标签, pending, 最后活跃}`
- [ ] **微信端打标**:出站带 `[sid]`/会话名;入站按标签或"最近活跃"路由到对应 pending
- [ ] **每会话独立唤醒**:各 session 的 asyncRewake/cron 只读自己的 pending,天然隔离

### 阶段 6 · 体验增强(P1 / P2,按需)
- [ ] F5 持久化发送队列(relay + 服务器双层)
- [ ] F6 长文本/代码渲染(超 N 行转图片)
- [ ] F7 入站白名单(只认指定 userId 的指令)
- [ ] F9 微信端自助命令(`/status` `/switch` 等)
- [ ] F10 历史归档(SQLite)+ `weclaw search` / `/history`
- [ ] F11 富媒体入站(图片 OCR / 文件 / 链接)
- [ ] F12 语音指令 + 速率限制

---

## 发布形态(三个并列交付物,共用同一套远端配置)

1. **Skill**(已有,远程模式零改动)—— 交互式主动发送
2. **`weclaw hooks install`**(新)—— 事件驱动出站 + 双向注入
3. **`weclaw deploy --ssh` + `weclaw relay`**(新)—— 一键上服务器 + 本地双向中继

---

## 风险与待核实

| 项 | 处置 |
|---|---|
| iLink 服务端 IP 风控(黑盒) | `deploy` 后小流量实测 24–72h,看有无新 errcode / 手机异地登录告警 |
| asyncRewake 跨会话并发行为未在文档明确 | 灰度验证;不稳则回退 session_crons 作双向主路径 |
| asyncRewake 默认 timeout 600s 可能不够等用户回复 | 设大 timeout;进程内轮询 pending,超时优雅退出 |
| `weclaw deploy` 跨发行版兼容 | 先支持 Debian/Ubuntu + macOS;其余给手动步骤 |
| Caddy 自动 HTTPS 需域名 | 无域名时回退 self-signed + 明确警告,或引导用 Tailscale |
| 真正"瞬时打断"做不到 | 文档/文案明确"回合制为主,异步有轮询延迟" |
| 凭证迁移期间消息丢失 | 原子切换:本地停 → 迁 → 服务器起,窗口 < 数秒 |

---

## 推荐落地顺序

```
阶段 0 (稳链路)        → 不依赖部署,先做,所有后续受益
阶段 1 (服务器加固)    → /events 是本地 relay 的前提,优先
阶段 3 (本地 relay)    → claude 在本地的核心,接通双向
阶段 2 (一键 deploy)   → 把"服务器加固 + 凭证迁移"自动化,降低门槛
阶段 4 (hooks 双触发)  → 接通后,装 hooks 即得双向
阶段 5 (多会话)        → 多 claude 并发时做
阶段 6 (体验)          → 按需
```

阶段 1 + 3 是技术关键路径(打通服务器↔本地双向);阶段 2 是体验关键路径(让普通用户能用起来)。两者可并行。
