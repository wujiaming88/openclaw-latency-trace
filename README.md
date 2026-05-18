# openclaw-latency-trace

全链路延迟追踪插件，记录 OpenClaw agent run 的完整时间瀑布到本地 JSONL 文件。

## 采集指标

- **E2E 延迟**：从 Gateway 收到消息到回复发出（`e2eMs`）
- **阶段拆分**：Gateway / Agent run / Delivery（`stages.{gatewayMs,agentRunMs,deliveryMs}`）
- **模型 TTFT**：每次 model call 的 Time To First Byte（精确值，来自 streaming 层）
- **模型生成时间**：duration − TTFT = 纯 token 生成耗时
- **工具执行耗时**：每次 tool call 的 duration
- **上下文大小**：每次 model call 的 system / history / prompt UTF-8 字节数

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

# Context size vs TTFT
jq -r '.model.detail[] | select(.ttftMs != null and .context != null) | [.context.totalContextBytes, .ttftMs] | @csv' /tmp/openclaw/latency-trace.jsonl

# 阶段拆分占比（gateway / agent / delivery）
jq 'select(.e2eMs != null) | {e2e: .e2eMs, gw: .stages.gatewayMs, ag: .stages.agentRunMs, dl: .stages.deliveryMs}' /tmp/openclaw/latency-trace.jsonl
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LATENCY_TRACE_OUTPUT` | `/tmp/openclaw/latency-trace.jsonl` | 输出文件路径 |
| `OPENCLAW_LOG_DIR` | `/tmp/openclaw` | fallback 目录 |

## 要求

- OpenClaw ≥ 2026.5.12
- 零依赖（只用 Node.js 内置模块）

## License

MIT
