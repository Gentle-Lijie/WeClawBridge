# WeClawBridge 功能扩展与集成设计

> **版本** v0.2 · 2026-08-12
> 本版基于对 Claude Code hooks 能力的两轮官方文档核实，修正了 v0.1 中对"双向 hooks"的若干假设。
> 所有 hooks 事实引用自 `https://code.claude.com/docs/en/hooks`。

---

## 设计原则

1. **核心是微信。** 所有功能体现在微信对话的体验与能力上，不引入脱离微信的客户端、不做局域网发现。
2. **双触发面，一个后端。** Skill（模型主动）和 Hooks（生命周期事件）都只调桥接的 `/send` 与 inbound 通道；桥接是唯一中央路由。
3. **多会话按 `session_id` 隔离。** 每个 hook 调用都在 stdin payload 里带稳定的 `session_id`，用它做路由主键（不用会 lag 的 `transcript_path`）。
4. **诚实面对限制。** 当前 hooks 模型只能做到**回合制双向**，做不到"随时瞬时打断"。文档不掩盖这一点。

---

## 一、触发架构：Skill + Hooks

桥接的出口（`/send`）有两个调用方，覆盖两种触发模式：

| | Skill（已有） | Hooks（新增，`weclaw hooks install`） |
|---|---|---|
| **谁触发** | 模型主动决策 | claude 生命周期事件自动触发 |
| **模式** | pull：用户说"发微信"→ claude 调 skill | push：事件发生 → 自动打 `/send` |
| **适合** | 交互式、按需发送 | 自动化、无需用户发话 |
| **实现** | `skill/weclaw-bridge/SKILL.md` | 写入用户 `.claude/settings.json` |

两者互补不冲突：Skill 管"模型想发的时候"，Hooks 管"claude 状态变化的时候"。

### Hooks 出站：用 `http` 类型直连 `/send`

Claude Code hooks 支持 `type: "http"`（不止 `command`），可以直接 POST 到桥接，**零脚本**：

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:4789/send",
            "method": "POST",
            "headers": { "Content-Type": "application/json" },
            "body": { "text": "{{$last_assistant_message}}", "session": "{{$session_id}}" }
          }
        ]
      }
    ]
  }
}
```

> 字段模板语法（`{{$session_id}}` 等）需在实现时按实际 hooks 模板能力核对；`command` 类型 + `jq` 构造 body 是稳妥兜底。

### 推荐注册的事件（出站通知）

只在有意义的边界推微信，不滥注册全部 31 个事件：

| 事件 | 用途 | payload 关键字段 |
|---|---|---|
| `Stop` | 任务完成，推摘要 | `last_assistant_message` |
| `Notification`（matcher: `permission_prompt` / `idle_prompt` / `agent_needs_input`） | 需要用户确认/输入 | 通知文本 |
| `PostToolUse`（`if: "Bash(git push *)"` 等） | 高危动作留痕 | `tool_name`, `tool_input` |
| `PermissionRequest` | 权限请求镜像 | 请求内容 |
| `TaskCompleted` | 关键节点 | 任务信息 |
| `SessionStart` / `SessionEnd` | 会话注册/注销（见第三节） | `session_id` |

---

## 二、双向通讯：从单向 push 到回合制对话

这是最关键、也最容易拍错的部分。下面是核实后的**事实**，设计必须建立在它们之上。

### 2.1 关键事实（docs ground truth）

1. **没有 `AskQuestion` 事件。** 等价的是 `Notification` 的 matcher（`permission_prompt` / `idle_prompt` / `agent_needs_input`）。
2. **`Notification` 只能推、不能注入。** 它是 side-effect-only：不能 block、不能把内容塞回会话。所以"在等输入处推微信"成立，"推完等回复再注入 claude"在 Notification 这条路上**走不通**。
3. **`Stop` blocking（`stop_hook_active`）是"立即继续"，不是"等待"。** Stop hook `exit 2` 让 claude 立刻继续而非暂停；连续 block 8 次后被强制结束。它不是一个"等外部输入"的状态。
4. **`asyncRewake` 是 `command` hook 上的一个布尔字段**（不是类型/事件）：

   ```json
   { "type": "command", "command": "./wait-for-reply.sh", "asyncRewake": true, "timeout": 600 }
   ```

   - 父事件触发时启动后台进程，父事件立即返回；
   - 进程 **`exit 2`** 时把 **stderr（stdout 兜底）作为 system reminder** 注入；
   - 唤醒的是 **idle 会话**（轮次结束等用户），**不是** Stop-blocked 会话；
   - **一次性**：唤醒绑定在进程退出，一个进程只能唤醒一次；
   - 默认 `timeout` 600s；`-p` 模式 teardown 时被 kill。
5. **没有官方"等外部事件再唤醒"的示例。** 整个 `asyncRewake` 文档只有三句话。把它当"等外部输入"用是 off-label。
6. **`session_crons` + `ScheduleWakeup` / `CronCreate` / `/loop`** 是另一个原语：明确支持 recurring / one-shot 调度唤醒，带 `prompt` 字段。更适合"周期性拉取外部信号"。

### 2.2 两个档位

"微信回复注入 claude"分两个档位，**没有档位能做到真正的瞬时打断**——这是 hooks 模型的硬限制。

#### 档位 A — 回合制（Stop + asyncRewake）

利用"Stop 每轮都触发"，**每轮挂一个新 asyncRewake 进程**等下一轮回复，规避 one-shot 限制：

```
claude 会话 (session_id = abc)
  │
  ├─ Stop 触发 ──http──► /send "abc 完成: <摘要>"
  │           └─ 同时挂一个 asyncRewake 进程（绑定 abc），阻塞读 pending/abc
  │                              │
  │        用户微信回 "改用 B"     │
  │                ▼              │
  │        桥接 inbound monitor    │
  │          路由到 pending/abc    │
  │                ▼              │
  │        asyncRewake 检测到 → exit 2
  │                │  stderr="用户回复: 改用 B"
  │                ▼              │
  └─ idle 会话被唤醒，收到 reminder，继续
      （下一轮 Stop 再挂一个新 asyncRewake ……）
```

- **能做**：claude 停下后等一个微信回复再继续，可多轮（每轮新进程）。
- **不能做**：claude 正在跑（非 idle）时注入。会话不 idle 时 asyncRewake 行为未定义。
- **适合**：审批流（F4）、任务完成后的追问、需要用户拍板的回合。

#### 档位 B — 异步轮询（session_crons / ScheduleWakeup）

- 每会话注册一个周期唤醒（如每 30s），拉自己的 pending 文件，有内容就当 prompt 注入。
- **能做**：claude 正在跑时也能注入（下一个调度点）。
- **代价**：轮询延迟 + 消耗 token；不是事件驱动。
- **适合**：需要"随时打断"语义的场景。仅在档位 A 不够时启用。

> **诚实结论**：默认做档位 A（回合制，覆盖审批/问答绝大多数场景）；档位 B 作为可选增强，并明确告知用户"异步注入有轮询延迟"。不要承诺"瞬时双向"。

### 2.3 反向数据流

微信 → claude 的注入统一走 **per-session pending 文件**，由桥接的 inbound monitor 写入：

```
微信用户回复
   │  iLink inbound
   ▼
桥接 inbound monitor
   │  解析目标 session（标签 / 活跃会话 / 显式指定）
   ▼
写 pending/<session_id>.json
   │
   ├─ 档位 A: 该 session 的 asyncRewake 进程 read 到 → exit 2 注入
   └─ 档位 B: 该 session 的 cron 触发 → 读 pending 注入
```

`pending/<session_id>.json` 是双向链路的唯一汇合点，解耦了"微信何时来"和"claude 何时取"。

---

## 三、多会话管理

`session_id` 是稳定、同步的（每个 hook payload 都带），做路由主键。

### 注册表

| 事件 | 动作 |
|---|---|
| `SessionStart` | 桥接登记 `session_id → {名称/标签, pending 队列, 创建时间}` |
| `SessionEnd` | 注销（配超时兜底 crash 残留） |

### 微信端区分

- 出站每条推送带会话标签，如 `[abc] 任务完成` 或可读会话名；
- 用户回复可带标签路由，或默认路由到"最近活跃会话"。

### 入站路由

桥接 inbound monitor 是**唯一中央路由**，按 `session_id` 分发到各自 pending：

```
session abc ── asyncRewake/cron 等 pending/abc  ◄──┐
session def ── asyncRewake/cron 等 pending/def  ◄──┤ 桥接按 session_id 分发
session ghi ── asyncRewake/cron 等 pending/ghi  ◄──┘
```

每个会话的等待者只读自己的 pending，**天然隔离**，不会串台。这把原 F8（多任务分流）从"task tag"升级成"真 session 路由"，更扎实。

---

## 四、桥接侧功能（P0 / P1 / P2）

> 相比 v0.1，主要调整：F3 指令路由、F4 审批流现在挂在 §2 的反向注入上；F8 多任务升级为 §3 的 session 路由。

### P0 · 核心体验

| ID | 功能 | 现状痛点 | 做法 |
|---|---|---|---|
| **F1** | context_token 自愈 | `errcode=-14` 时裸 502 | 记录 token 捕获时间，临近过期提示；命中 `STALE_TOKEN_ERRCODE` 自动降级攒队列，用户在微信发任意消息触发重捕获后恢复 |
| **F2** | 出站脱敏 | 密钥/私钥可能被 push 进微信 | `/send` 出口加 redactor，正则遮蔽密钥/凭证/私钥块 |
| **F3** | 微信指令路由 | inbound 只能被动镜像 | `monitor.ts` 的 `onInbound` 前加路由器，识别 `/status` `/stop` `/approve` `/switch` 等 |
| **F4** | 审批流（双向） | 高危操作直接执行 | hook 推待确认项 → 用户微信回 `/approve <id>` → 档位 A 注入 claude。**直接依赖 §2** |

### P1 · 体验增强

| ID | 功能 | 做法 |
|---|---|---|
| **F5** | 持久化发送队列 | `/send` 先落盘再投递，失败退避重试，重启重放 |
| **F6** | 长文本/代码渲染 | 超 N 行转高亮图片（`item_list` 图片类型），diff 配色截图，分段+引用 |
| **F7** | 入站白名单 | 指令路由只认白名单 `userId`（复用 `context_tokens`） |
| **F8** | 多会话路由 | 见 §3，`session_id` 主键 + 注册表 + per-session pending |

### P2 · 便捷与进阶

| ID | 功能 | 做法 |
|---|---|---|
| **F9** | 微信端自助命令 | 微信里 `/status` `/accounts` `/rebind` `/switch` |
| **F10** | 历史归档与检索 | 入站/出站落 SQLite，`weclaw search`、微信 `/history`、`weclaw replay` |
| **F11** | 富媒体入站 | 扩展 `extractText`：图片(OCR)/文件/链接卡片 |
| **F12** | 语音指令 + 限流 | `voice_item.text` 接路由；指令幂等 + 速率限制 |

---

## 五、发布形态与落地顺序

### 三个并列交付物（共用桥接后端）

1. **Skill**（已有）— 交互式主动发送。
2. **`weclaw hooks install`**（新命令）— 自动把 hooks 配置写进用户 `.claude/settings.json`，对称于已有 `weclaw service install`。装完即得出站事件推送 + 会话注册。
3. **反向注入**（F3/F4 + §2）— 桥接 session 路由 + pending 文件 + 档位 A asyncRewake。

### 落地顺序

```
阶段一  稳链路        F1 自愈 · F2 脱敏
阶段二  出站自动化     weclaw hooks install（http hook 直连 /send，零后端改动）
阶段三  会话路由       SessionStart/End 注册表 + per-session pending + F8
阶段四  回合制双向     Stop+asyncRewake（档位 A）+ F3 指令路由 + F4 审批流
阶段五  强体验         F5 队列 · F6 渲染 · F7 白名单
阶段六  异步增强(可选)  档位 B（session_crons 轮询）
阶段七  进阶           F9–F12 按需
```

每阶段独立可交付。阶段二投入最小、感知最早（"任务完成/要确认"自动进微信）。

---

## 六、风险与待核实

| 项 | 状态 | 应对 |
|---|---|---|
| `asyncRewake` 的 stdin 是否标记自身模式 | docs 未列 | 不依赖该字段，hook 用 `session_id` 自路由 |
| `asyncRewake` 跨会话并发是否干扰 | docs 未明确 | 按"独立进程 + 各自 session_id"假设，灰度验证 |
| `Stop` 与 `asyncRewake` 能否组合 | docs 未说 | 不组合：档位 A 纯用 asyncRewake 唤醒 idle 会话 |
| http hook 的 body 模板语法（`{{$session_id}}`） | 待核对 | 实现前验证；不行则 `command` + `jq` 兜底 |
| `asyncRewake` timeout 600s 是否够等用户回复 | 可能不够 | 设大 `timeout`，或进程内轮询 pending + 超时优雅退出 |
| 真正"瞬时打断"做不到 | 模型硬限制 | 文档/产品文案明确"回合制"，异步靠档位 B 且有延迟 |

> 建议在阶段四动手前，再精读一次 `hooks` 文档的 `asyncRewake` 与 `session_crons` 两节，确认上述假设。若 `asyncRewake` 在长等待场景不稳定，回退到档位 B（`session_crons`）作为双向主路径。
