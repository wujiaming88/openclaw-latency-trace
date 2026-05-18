# openclaw-latency-trace

全链路延迟追踪插件，记录 OpenClaw agent run 的完整时间瀑布到本地 JSONL 文件。

## 采集指标

- **E2E 延迟**：从 Gateway 收到消息到 agent 完成回复（`e2eMs`）。不含 channel API 投递的最后几百毫秒（OpenClaw 上游未在投递路径暴露 runId 关联，无法测量）
- **阶段拆分**：Gateway 开销 → Agent 处理（`stages.{gatewayMs,agentRunMs}`）。`gatewayMs` 指上游送达 → Agent 开始处理的延迟（含网络/排队，由 `evt.timestamp` 决定）
- **模型 TTFT**：每次 model call 的 Time To First Byte（精确值，来自 streaming 层）
- **模型生成时间**：duration − TTFT = 纯 token 生成耗时
- **工具执行耗时**：每次 tool call 的 duration
- **上下文大小**：systemPrompt 用 chars（OpenClaw 权威切分: total / project / nonProject，来自 trajectory `trace.metadata`）；prompt + history 用 UTF-8 bytes（plugin 在 `before_prompt_build` 自己算）

> `e2eMs` 终点是 `agent_end` hook（agent 完成回复时刻），跟用户实际收到消息差几百毫秒到 1 秒（channel API 实际投递时间，OpenClaw 上游限制 plugin 无法获取）。

## 输出

每次 agent run 完成后，写一条 JSON 到 `/tmp/openclaw/latency-trace.jsonl`。

## 安装

```bash
# 克隆到 extensions 目录
git clone https://github.com/wujiaming88/openclaw-latency-trace.git ~/.openclaw/extensions/latency-trace

# 在 openclaw.json 中启用
# 1. plugins.allow 数组加入 "latency-trace"
# 2. plugins.entries 加入 "latency-trace": { "enabled": true }

# 重启
openclaw gateway restart
```

## 验证

```bash
# 发一条消息后
tail -1 /tmp/openclaw/latency-trace.jsonl | jq .
```

## 分析

```bash
# TTFT 分布
jq '.model.firstCallTtftMs' /tmp/openclaw/latency-trace.jsonl | sort -n | awk '{a[NR]=$1}END{print "P50="a[int(NR*0.5)]" P95="a[int(NR*0.95)]}'

# Context size vs TTFT (systemPrompt chars + prompt/history bytes)
jq -r '.model.detail[] | select(.ttftMs != null and .context != null) | [.context.systemPromptChars, (.context.promptBytes + .context.historyBytes), .ttftMs] | @csv' /tmp/openclaw/latency-trace.jsonl

# 阶段拆分占比（gateway / agent）
jq 'select(.e2eMs != null) | {e2e: .e2eMs, gw: .stages.gatewayMs, ag: .stages.agentRunMs}' /tmp/openclaw/latency-trace.jsonl
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LATENCY_TRACE_OUTPUT` | `/tmp/openclaw/latency-trace.jsonl` | 输出文件路径 |
| `OPENCLAW_LOG_DIR` | `/tmp/openclaw` | fallback 目录 |

## 要求

- OpenClaw ≥ 2026.5.12
- 零依赖（只用 Node.js 内置模块）

## 单位说明

- `systemPromptChars` / `projectContextChars` / `nonProjectContextChars` 单位是 **chars**，来自 OpenClaw `trace.metadata.data.prompting.systemPromptReport.systemPrompt`。OpenClaw 内部权威，跟 `[context-diag] systemPromptChars=...` log 完全一致。
- `promptBytes` / `historyBytes` 单位是 **UTF-8 bytes**，由 plugin 自己 `Buffer.byteLength` 算，源是 `before_prompt_build.evt.prompt` 与 `evt.messages`。
- 单位混合是有意为之：systemPrompt 在 trajectory 里被截断（>32K chars 时存 `{truncated:true}` dict 而非完整字符串），算 bytes 不靠谱；prompt/history 没有可信 chars 来源，bytes 反而是最准的本地度量。需要总量分析时 `jq` 单独看 chars / bytes 字段即可。

## License

MIT
