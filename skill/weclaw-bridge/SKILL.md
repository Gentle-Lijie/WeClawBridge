---
name: weclaw-bridge
description: Forward an instruction or message to the user's bound WeChat (微信) ClawBot through the local WeClawBridge webhook. Self-healing — detects and starts the service when down, guides the user through binding / capturing a session when needed. Use when the user wants to send, push, or forward something to their WeChat.
---

# WeClawBridge Skill

Forward text to a bound WeChat ClawBot by driving the local WeClawBridge service.
This skill is **self-healing**: if the service is down it starts it; if no account is
bound it guides binding; if the send fails on a missing session it tells the user
exactly what to do.

## Resolve the `weclaw` binary

Run this once per task and reuse `WECLAW` everywhere after:

```bash
if command -v weclaw >/dev/null 2>&1; then
  WECLAW="weclaw"
elif [ -x ./bin/weclaw.mjs ]; then
  WECLAW="node ./bin/weclaw.mjs"
elif [ -f ./bin/weclaw.mjs ]; then
  WECLAW="node ./bin/weclaw.mjs"
else
  WECLAW="npx -y weclaw"
fi
echo "$WECLAW"
```

Resolve the server URL and (optional) bearer token:

```bash
WECLAW_URL="${WECLAW_URL:-http://127.0.0.1:4789}"
AUTH="${WECLAW_API_TOKEN:+-H Authorization:Bearer $WECLAW_API_TOKEN}"
```

## Send procedure (follow in order)

### 1. Health check — is the service up?

```bash
curl -sS -m 3 -o /dev/null -w "%{http_code}" "$WECLAW_URL/health"
```

- `200` → service is up. Go to step 2.
- anything else / connection error → service is **down**. **Start it now** (background, detached):

```bash
# Start detached so it keeps running after this turn.
nohup $WECLAW start > "$( $WECLAW status >/dev/null 2>&1; echo "${WECLAW_STATE_DIR:-$HOME/.weclaw-bridge}/weclaw.log" )" 2>&1 &
disown || true
sleep 2
# Verify it came up.
curl -sS -m 3 -o /dev/null -w "health=%{http_code}\n" "$WECLAW_URL/health"
```

If the health check still fails after starting:
- Look at the log: `tail -40 "${WECLAW_STATE_DIR:-$HOME/.weclaw-bridge}/weclaw.log"`.
- Common cause: no account bound yet (the server starts but no monitor runs). That's fine — continue to step 2.
- If the port is taken, start on another port: `nohup $WECLAW start --port 4790 ...` and set `WECLAW_URL` accordingly.

Once healthy, **optionally make it persistent** by suggesting (do not run silently — it enables a boot service):
> You can make it survive reboots with: `$WECLAW service install`

### 2. Is an account bound?

```bash
curl -sS -m 5 $AUTH "$WECLAW_URL/accounts"
```

- Returns `{"accounts":["...-im-bot"]}` → bound. Go to step 3.
- Returns `{"accounts":[]}` → **not bound**. STOP and tell the user verbatim:

> 还没有绑定微信 ClawBot。请在终端运行：
> ```
> $WECLAW login
> ```
> 终端会出现二维码，用手机微信扫描并按提示输入配对数字。绑定完成后告诉我，我再继续发送。

Wait for the user to confirm binding, then re-run this check before continuing.

### 3. Send the message

Send exactly the content the user asked to forward as `text` (do not paraphrase, do not add commentary):

```bash
python3 -c 'import json,sys; print(json.dumps({"text": sys.stdin.read()}))' <<'EOF' | \
  curl -sS -m 20 -X POST "$WECLAW_URL/send" \
    -H "Content-Type: application/json" $AUTH -d @-
<the content to forward>
EOF
```

For single-line content you may inline:
```bash
curl -sS -m 20 -X POST "$WECLAW_URL/send" -H "Content-Type: application/json" $AUTH \
  -d "{\"text\":\"<escaped content>\"}"
```

### 4. Handle the response

A success looks like: `{"ok":true,"account":"...","to":"...@im.wechat","messageId":"..."}`.
Tell the user it was delivered.

On failure, map the HTTP status and recover:

| HTTP | Body hint | Cause & action |
|------|-----------|----------------|
| `400` | `body.text is required` / `no 'to'` | Your fault — fix the payload. `to` is optional unless multi-account. |
| `401` | `unauthorized` | `WECLAW_API_TOKEN` mismatch. Ask the user for the token the server was started with, or restart without `--api-token`. |
| `404` | `no bound accounts` | Step 2 failed silently — go back and run the bind guidance. |
| `409` | `not configured` | Account record exists but no token. Re-run `$WECLAW login`. |
| `502` | `send failed: ... ret=-2 ... prepare failed` | **Missing session/context_token.** See the warm-up fix below. |
| `502` | `... errcode=-14 ...` | Stale token. Ask the user to re-run `$WECLAW login`, then retry. |
| `000` / curl error | connection refused | Service died — restart (step 1). |

#### The "prepare failed" / missing-context warm-up

WeChat requires every bot reply to carry a `context_token`, which is only captured when
the **user sends a message to the bot first**. If you hit `502 / prepare failed`:

1. Check whether a token is captured:
   ```bash
   curl -sS $AUTH "$WECLAW_URL/status"
   ```
   - If `lastInboundAt` is present/recent AND a context token file exists, retry once — it may have just arrived.
   - Otherwise STOP and tell the user verbatim:

> 微信要求 bot 的回复必须基于一次"会话"。请在手机微信里打开 ClawBot 的对话，**给 bot 随便发一条消息**（例如 `hello`），这样桥接才能捕获到发送所需的凭证。发完告诉我，我会立即重试。

2. After the user confirms, re-check `/status` — `lastInboundAt` should advance. Then retry the send.

## Endpoints (only these)

| Method | Path | Body | Purpose |
|--------|------|------|---------|
| GET | `/health` | — | liveness (public) |
| GET | `/status` | — | accounts + monitor liveness |
| GET | `/accounts` | — | list accountIds |
| POST | `/send` | `{"text","to"?,"account"?}` | forward text to WeChat |
| POST | `/login/start` | — | fetch QR (returns `qrcodeUrl`, `sessionKey`) |
| POST | `/login/wait` | `{"sessionKey","verifyCode"?}` | poll login |

Do not invent other endpoints.

## Rules

- Send the user's content verbatim as `text`. Never paraphrase or append your own commentary.
- Always recover automatically where you can (start service, re-check). Only involve the user for things only they can do: scanning the QR (`weclaw login`) and sending the first WeChat message (`hello`).
- Never run `weclaw login` or `weclaw service install` without telling the user first — both are interactive / change system state.
- Keep `WECLAW`, `WECLAW_URL`, `AUTH` resolved once and reuse them across all commands in the task.
