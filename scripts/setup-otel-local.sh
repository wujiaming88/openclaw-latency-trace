#!/usr/bin/env bash
set -euo pipefail

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# OpenClaw 全链路延迟追踪 — 本地环境搭建脚本（幂等，支持重复运行）
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
echo "[1/6] diagnostics-otel 插件..."
if [ -d "$HOME/.openclaw/npm/node_modules/@openclaw/diagnostics-otel" ]; then
    echo "  ✓ 已安装，跳过"
elif openclaw plugins list 2>/dev/null | grep -q "diagnost"; then
    echo "  ✓ 已注册，跳过"
else
    openclaw plugins install @openclaw/diagnostics-otel 2>&1 | tail -3 || true
    echo "  ✓ 完成"
fi
echo

# ─── 2. 下载 otel-collector ──────────────────────────────────────────────────
echo "[2/6] otel-collector-contrib..."
ARCH=$(uname -m)
[ "$ARCH" = "x86_64" ] && ARCH="amd64"
[ "$ARCH" = "aarch64" ] && ARCH="arm64"

if [ -x "$OTEL_DIR/otelcol-contrib" ]; then
    echo "  ✓ 已存在，跳过"
else
    sudo mkdir -p "$OTEL_DIR"
    URL="https://mirror.ghproxy.com/https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${OTEL_VERSION}/otelcol-contrib_${OTEL_VERSION}_linux_${ARCH}.tar.gz"
    echo "  下载: $URL"
    curl -fsSL "$URL" | sudo tar -xz -C "$OTEL_DIR"
    echo "  ✓ 下载完成"
fi
echo

# ─── 3. 写 config.yaml ──────────────────────────────────────────────────────
echo "[3/6] otel-collector config..."
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
echo "  ✓ $OTEL_DIR/config.yaml"
echo

# ─── 4. 配置 openclaw.json ──────────────────────────────────────────────────
echo "[4/6] openclaw.json..."
python3 << PY
import json, shutil, os

cfg_path = os.path.expandvars("$OPENCLAW_CONFIG")

# 备份（只在首次备份不存在时）
backup = cfg_path + ".bak.otel"
if not os.path.exists(backup):
    shutil.copy2(cfg_path, backup)
    print(f"  备份: {backup}")
else:
    print(f"  备份已存在，跳过")

cfg = json.load(open(cfg_path))

changed = False

# plugins.allow
allow = cfg.setdefault("plugins", {}).setdefault("allow", [])
if "diagnostics-otel" not in allow:
    allow.append("diagnostics-otel")
    changed = True

# plugins.entries
entries = cfg["plugins"].setdefault("entries", {})
if entries.get("diagnostics-otel") != {"enabled": True}:
    entries["diagnostics-otel"] = {"enabled": True}
    changed = True

# diagnostics 配置
expected_diag = {
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
if cfg.get("diagnostics") != expected_diag:
    cfg["diagnostics"] = expected_diag
    changed = True

if changed:
    open(cfg_path, "w").write(json.dumps(cfg, indent=2) + "\n")
    print("  ✓ 配置已更新")
else:
    print("  ✓ 配置已是最新，跳过")
PY
echo

# ─── 5. otel-collector service ───────────────────────────────────────────────
echo "[5/6] otel-collector service..."

# 先停旧进程（如有）
if pgrep -f otelcol-contrib > /dev/null 2>&1; then
    pkill -f otelcol-contrib 2>/dev/null || true
    sleep 1
    echo "  停掉旧进程"
fi

# 尝试 systemd user service
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

systemctl --user daemon-reload 2>/dev/null || true
systemctl --user restart otel-collector 2>/dev/null || true
sleep 2

if systemctl --user is-active otel-collector > /dev/null 2>&1; then
    echo "  ✓ systemd user service 运行中"
else
    echo "  ⚠ systemd 不可用，后台启动..."
    nohup "$OTEL_DIR/otelcol-contrib" --config "$OTEL_DIR/config.yaml" > "$OTEL_OUTPUT/collector.log" 2>&1 &
    disown
    sleep 2
    if ss -tlnp 2>/dev/null | grep -q ":$OTEL_PORT" || netstat -tlnp 2>/dev/null | grep -q ":$OTEL_PORT"; then
        echo "  ✓ 后台运行中 (port $OTEL_PORT)"
    else
        echo "  ✗ 启动失败！查看: $OTEL_OUTPUT/collector.log"
        exit 1
    fi
fi
echo

# ─── 6. 重启 gateway ────────────────────────────────────────────────────────
echo "[6/6] 重启 Gateway..."
openclaw gateway restart 2>&1 | tail -3 || true
sleep 5
echo

# ─── 验证 ────────────────────────────────────────────────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✓ 搭建完成！"
echo
echo "验证："
echo "  1. 确认端口: ss -tlnp | grep $OTEL_PORT"
echo "  2. 发一条消息给任意 agent"
echo "  3. 等 10 秒后: python3 analyze-latency.py"
echo
echo "数据文件："
echo "  $OTEL_OUTPUT/traces.jsonl"
echo "  $OTEL_OUTPUT/metrics.jsonl"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
