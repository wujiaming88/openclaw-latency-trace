#!/usr/bin/env bash
set -euo pipefail

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# OpenClaw 全链路延迟追踪 — 本地环境搭建脚本
# 
# 在目标机器上执行：bash setup-otel-local.sh
# 
# 做什么：
#   1. 安装 diagnostics-otel 插件
#   2. 下载 otel-collector-contrib binary
#   3. 写 config.yaml（file exporter → /tmp/openclaw/otel/）
#   4. 配置 openclaw.json（diagnostics + plugins）
#   5. 启动 otel-collector（systemd user service）
#   6. 重启 gateway
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

OTEL_VERSION="0.104.0"
OTEL_DIR="/opt/otelcol"
OTEL_OUTPUT="/tmp/openclaw/otel"
OTEL_PORT="4318"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"

echo "🦞 OpenClaw Latency Trace — 环境搭建"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo

# ─── 1. 安装 diagnostics-otel 插件 ───────────────────────────────────────────
echo "[1/6] 安装 diagnostics-otel 插件..."
if openclaw plugins list 2>/dev/null | grep -q "diagnostics-otel.*enabled"; then
    echo "  ✓ 已安装且 enabled"
else
    openclaw plugins install @openclaw/diagnostics-otel 2>&1 | tail -3
    echo "  ✓ 安装完成"
fi
echo

# ─── 2. 下载 otel-collector ──────────────────────────────────────────────────
echo "[2/6] 下载 otel-collector-contrib v${OTEL_VERSION}..."
ARCH=$(uname -m)
[ "$ARCH" = "x86_64" ] && ARCH="amd64"
[ "$ARCH" = "aarch64" ] && ARCH="arm64"

if [ -x "$OTEL_DIR/otelcol-contrib" ]; then
    echo "  ✓ 已存在: $OTEL_DIR/otelcol-contrib"
else
    sudo mkdir -p "$OTEL_DIR"
    URL="https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${OTEL_VERSION}/otelcol-contrib_${OTEL_VERSION}_linux_${ARCH}.tar.gz"
    echo "  下载: $URL"
    curl -fsSL "$URL" | sudo tar -xz -C "$OTEL_DIR"
    echo "  ✓ 下载完成"
fi
echo

# ─── 3. 写 config.yaml ──────────────────────────────────────────────────────
echo "[3/6] 写 otel-collector config..."
sudo mkdir -p "$OTEL_OUTPUT"
sudo tee "$OTEL_DIR/config.yaml" > /dev/null << 'YAML'
receivers:
  otlp:
    protocols:
      http:
        endpoint: "127.0.0.1:4318"

exporters:
  file/traces:
    path: /tmp/openclaw/otel/traces.jsonl
    format: json
  file/metrics:
    path: /tmp/openclaw/otel/metrics.jsonl
    format: json

service:
  telemetry:
    logs:
      level: warn
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [file/traces]
    metrics:
      receivers: [otlp]
      exporters: [file/metrics]
YAML
echo "  ✓ 写入 $OTEL_DIR/config.yaml"
echo

# ─── 4. 配置 openclaw.json ──────────────────────────────────────────────────
echo "[4/6] 配置 openclaw.json..."
python3 << PY
import json, sys, shutil

cfg_path = "$OPENCLAW_CONFIG"
backup = cfg_path + ".bak.otel"
shutil.copy2(cfg_path, backup)
print(f"  备份: {backup}")

cfg = json.load(open(cfg_path))

# plugins.allow
allow = cfg.setdefault("plugins", {}).setdefault("allow", [])
if "diagnostics-otel" not in allow:
    allow.append("diagnostics-otel")

# plugins.entries
entries = cfg["plugins"].setdefault("entries", {})
entries["diagnostics-otel"] = {"enabled": True}

# diagnostics 配置
cfg["diagnostics"] = {
    "enabled": True,
    "otel": {
        "enabled": True,
        "endpoint": "http://127.0.0.1:$OTEL_PORT",
        "protocol": "http/protobuf",
        "serviceName": "openclaw-gateway",
        "traces": True,
        "metrics": True,
        "logs": False,
        "sampleRate": 1.0,
        "flushIntervalMs": 5000
    }
}

open(cfg_path, "w").write(json.dumps(cfg, indent=2) + "\n")
print("  ✓ 配置已更新")
PY
echo

# ─── 5. 创建 systemd user service（持久化 otel-collector）────────────────────
echo "[5/6] 创建 otel-collector systemd service..."
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/otel-collector.service << SVC
[Unit]
Description=OpenTelemetry Collector (local file exporter)
After=network.target

[Service]
ExecStart=$OTEL_DIR/otelcol-contrib --config $OTEL_DIR/config.yaml
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
SVC

systemctl --user daemon-reload
systemctl --user enable otel-collector
systemctl --user start otel-collector
sleep 2

if systemctl --user is-active otel-collector > /dev/null 2>&1; then
    echo "  ✓ otel-collector 已启动 (systemd user service)"
else
    echo "  ⚠ systemd 启动失败，尝试直接后台运行..."
    nohup "$OTEL_DIR/otelcol-contrib" --config "$OTEL_DIR/config.yaml" > "$OTEL_OUTPUT/collector.log" 2>&1 &
    disown
    sleep 2
    if ss -tlnp | grep -q ":$OTEL_PORT"; then
        echo "  ✓ otel-collector 后台运行中"
    else
        echo "  ✗ 启动失败！查看: $OTEL_OUTPUT/collector.log"
        exit 1
    fi
fi
echo

# ─── 6. 重启 gateway ────────────────────────────────────────────────────────
echo "[6/6] 重启 OpenClaw Gateway..."
openclaw gateway restart 2>&1 | tail -3
sleep 5
echo

# ─── 验证 ────────────────────────────────────────────────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✓ 搭建完成！"
echo
echo "验证："
echo "  1. 发一条消息给任意 agent"
echo "  2. 等 10 秒"
echo "  3. 跑: python3 scripts/analyze-latency.py"
echo
echo "数据文件："
echo "  traces: $OTEL_OUTPUT/traces.jsonl"
echo "  metrics: $OTEL_OUTPUT/metrics.jsonl"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
