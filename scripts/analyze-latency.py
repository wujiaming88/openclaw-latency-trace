#!/usr/bin/env python3
"""分析 OpenClaw OTel traces，提取 context size → TTFT 对应关系。

用法：
    python3 analyze-latency.py [traces.jsonl路径]

默认读取 /tmp/openclaw/otel/traces.jsonl
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional

DEFAULT_PATH = "/tmp/openclaw/otel/traces.jsonl"


def get_attr(span: Dict, key: str) -> Optional[Any]:
    """从 span attributes 里取值。"""
    for a in span.get("attributes", []):
        if a["key"] == key:
            v = a.get("value", {})
            return v.get("intValue") or v.get("stringValue") or v.get("doubleValue")
    return None


def parse_traces(path: str) -> Dict[str, Dict]:
    """按 traceId 聚合所有 spans。"""
    traces: Dict[str, List[Dict]] = defaultdict(list)
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            for rs in d.get("resourceSpans", []):
                for ss in rs.get("scopeSpans", []):
                    for span in ss.get("spans", []):
                        tid = span.get("traceId", "")
                        traces[tid].append(span)
    return traces


def extract_runs(traces: Dict[str, List[Dict]]) -> List[Dict]:
    """从每个 trace 提取一条分析记录。"""
    runs = []
    for trace_id, spans in traces.items():
        run: Dict[str, Any] = {
            "traceId": trace_id[:16],
            "context": None,
            "model_calls": [],
            "tool_calls": [],
        }

        for span in spans:
            name = span.get("name", "")

            if name == "openclaw.context.assembled":
                run["context"] = {
                    "systemPromptChars": get_attr(span, "openclaw.context.system_prompt_chars"),
                    "historyTextChars": get_attr(span, "openclaw.context.history_text_chars"),
                    "messageCount": get_attr(span, "openclaw.context.message_count"),
                    "promptChars": get_attr(span, "openclaw.context.prompt_chars"),
                    "tokenBudget": get_attr(span, "openclaw.context.token_budget"),
                    "provider": get_attr(span, "openclaw.provider"),
                    "model": get_attr(span, "openclaw.model"),
                }

            elif name == "openclaw.model.call":
                ttft = get_attr(span, "openclaw.model_call.time_to_first_byte_ms")
                req_bytes = get_attr(span, "openclaw.model_call.request_bytes")
                resp_bytes = get_attr(span, "openclaw.model_call.response_bytes")
                # duration from span timestamps
                start_ns = int(span.get("startTimeUnixNano", 0))
                end_ns = int(span.get("endTimeUnixNano", 0))
                duration_ms = (end_ns - start_ns) / 1e6 if start_ns and end_ns else None
                run["model_calls"].append({
                    "ttftMs": int(ttft) if ttft else None,
                    "durationMs": round(duration_ms) if duration_ms else None,
                    "requestBytes": int(req_bytes) if req_bytes else None,
                    "responseBytes": int(resp_bytes) if resp_bytes else None,
                    "provider": get_attr(span, "openclaw.provider"),
                    "model": get_attr(span, "openclaw.model"),
                })

            elif name == "openclaw.tool.execution":
                start_ns = int(span.get("startTimeUnixNano", 0))
                end_ns = int(span.get("endTimeUnixNano", 0))
                duration_ms = (end_ns - start_ns) / 1e6 if start_ns and end_ns else None
                run["tool_calls"].append({
                    "tool": get_attr(span, "openclaw.tool"),
                    "durationMs": round(duration_ms) if duration_ms else None,
                })

        if run["model_calls"]:
            runs.append(run)

    return runs


def print_report(runs: List[Dict]):
    """打印分析报告。"""
    print("━" * 76)
    print("  🦞  OPENCLAW LATENCY ANALYSIS")
    print(f"  Runs: {len(runs)}")
    print("━" * 76)
    print()

    # ── Summary table ──
    print(f"{'trace':<12} {'ctx_chars':>10} {'msgs':>6} {'calls':>6} {'1st_TTFT':>10} {'avg_TTFT':>10} {'total_ms':>10}")
    print("─" * 76)

    all_pairs = []  # (context_chars, ttft_ms)

    for run in runs:
        ctx = run["context"]
        calls = run["model_calls"]
        ttfts = [c["ttftMs"] for c in calls if c["ttftMs"] is not None]
        durations = [c["durationMs"] for c in calls if c["durationMs"] is not None]

        ctx_chars = int(ctx["systemPromptChars"] or 0) + int(ctx["historyTextChars"] or 0) if ctx else None
        msg_count = ctx["messageCount"] if ctx else None
        first_ttft = ttfts[0] if ttfts else None
        avg_ttft = round(sum(ttfts) / len(ttfts)) if ttfts else None
        total_ms = sum(durations) if durations else None

        print(
            f"{run['traceId']:<12} "
            f"{ctx_chars or '?':>10} "
            f"{msg_count or '?':>6} "
            f"{len(calls):>6} "
            f"{f'{first_ttft}ms' if first_ttft else '?':>10} "
            f"{f'{avg_ttft}ms' if avg_ttft else '?':>10} "
            f"{f'{total_ms}ms' if total_ms else '?':>10}"
        )

        # Collect pairs for correlation
        if ctx_chars and first_ttft:
            all_pairs.append((int(ctx_chars), int(first_ttft)))
        for c in calls:
            if c["requestBytes"] and c["ttftMs"]:
                all_pairs.append((int(c["requestBytes"]), int(c["ttftMs"])))

    print()
    print("━" * 76)
    print("  CONTEXT SIZE vs TTFT (scatter data)")
    print("━" * 76)
    print()
    print(f"{'context_size':>14} {'ttft_ms':>10}")
    print("─" * 30)
    for ctx_size, ttft in sorted(all_pairs):
        print(f"{ctx_size:>14,} {ttft:>8,}ms")

    if len(all_pairs) >= 3:
        # Simple correlation
        xs = [p[0] for p in all_pairs]
        ys = [p[1] for p in all_pairs]
        n = len(xs)
        mean_x = sum(xs) / n
        mean_y = sum(ys) / n
        cov = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys)) / n
        std_x = (sum((x - mean_x) ** 2 for x in xs) / n) ** 0.5
        std_y = (sum((y - mean_y) ** 2 for y in ys) / n) ** 0.5
        corr = cov / (std_x * std_y) if std_x > 0 and std_y > 0 else 0
        print()
        print(f"  Pearson correlation (context_size vs TTFT): r = {corr:.3f}")
        print(f"  Samples: {n}")
        if abs(corr) > 0.7:
            print("  → 强正相关：context 越大，TTFT 越长")
        elif abs(corr) > 0.4:
            print("  → 中等相关：context 大小对 TTFT 有一定影响")
        else:
            print("  → 弱相关：TTFT 主要受其他因素影响（服务端调度、模型负载等）")

    print()
    print("━" * 76)


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PATH
    if not Path(path).exists():
        print(f"Error: {path} not found. 等数据积累后再跑。")
        sys.exit(1)

    traces = parse_traces(path)
    runs = extract_runs(traces)

    if not runs:
        print("No model call data found yet. 发几条消息等数据积累。")
        sys.exit(0)

    print_report(runs)


if __name__ == "__main__":
    main()
