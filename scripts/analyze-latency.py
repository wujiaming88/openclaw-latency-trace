#!/usr/bin/env python3
"""分析 OpenClaw OTel traces，提取 context size → TTFT / latency 对应关系。

兼容 diagnostics-otel 2026.5.7 和 2026.5.12 两种 span 格式。

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
    for a in span.get("attributes", []):
        if a["key"] == key:
            v = a.get("value", {})
            return v.get("intValue") or v.get("stringValue") or v.get("doubleValue") or v.get("boolValue")
    return None


def span_duration_ms(span: Dict) -> Optional[int]:
    start = int(span.get("startTimeUnixNano", 0))
    end = int(span.get("endTimeUnixNano", 0))
    if start and end:
        return round((end - start) / 1e6)
    return None


def parse_traces(path: str) -> Dict[str, List[Dict]]:
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
    runs = []
    for trace_id, spans in traces.items():
        run: Dict[str, Any] = {
            "traceId": trace_id[:16],
            "e2eMs": None,
            "context": None,
            "model_calls": [],
            "tool_calls": [],
            "provider": None,
            "model": None,
        }

        for span in spans:
            name = span.get("name", "")
            dur = span_duration_ms(span)

            # E2E: openclaw_request (2026.5.7) or message.processed
            if name == "openclaw_request":
                e2e = get_attr(span, "request.duration_ms")
                run["e2eMs"] = int(e2e) if e2e else dur

            # Model call: "llm_call" (2026.5.7) or "openclaw.model.call" (2026.5.12)
            elif name == "llm_call" or name == "openclaw.model.call":
                call = {
                    "durationMs": dur,
                    "provider": get_attr(span, "gen_ai.provider.name") or get_attr(span, "openclaw.provider"),
                    "model": get_attr(span, "gen_ai.request.model") or get_attr(span, "openclaw.model"),
                    "inputTokens": None,
                    "outputTokens": None,
                    "cacheReadTokens": None,
                    "totalTokens": None,
                    "stopReason": get_attr(span, "llm.stop.reason"),
                    "ttftMs": None,
                    "requestBytes": None,
                    "responseBytes": None,
                }
                # Token usage (2026.5.7 format)
                inp = get_attr(span, "gen_ai.usage.input_tokens")
                out = get_attr(span, "gen_ai.usage.output_tokens")
                total = get_attr(span, "gen_ai.usage.total_tokens")
                cache_read = get_attr(span, "gen_ai.usage.cache_read_input_tokens")
                cache_write = get_attr(span, "gen_ai.usage.cache_creation_input_tokens")
                if inp: call["inputTokens"] = int(inp)
                if out: call["outputTokens"] = int(out)
                if total: call["totalTokens"] = int(total)
                if cache_read: call["cacheReadTokens"] = int(cache_read)

                # TTFT (2026.5.12 format)
                ttft = get_attr(span, "openclaw.model_call.time_to_first_byte_ms")
                if ttft: call["ttftMs"] = int(ttft)

                # Request/response bytes (2026.5.12 format)
                req = get_attr(span, "openclaw.model_call.request_bytes")
                resp = get_attr(span, "openclaw.model_call.response_bytes")
                if req: call["requestBytes"] = int(req)
                if resp: call["responseBytes"] = int(resp)

                run["model_calls"].append(call)
                if not run["provider"]:
                    run["provider"] = call["provider"]
                    run["model"] = call["model"]

            # Context assembled (2026.5.12 only)
            elif name == "openclaw.context.assembled":
                run["context"] = {
                    "systemPromptChars": get_attr(span, "openclaw.context.system_prompt_chars"),
                    "historyTextChars": get_attr(span, "openclaw.context.history_text_chars"),
                    "messageCount": get_attr(span, "openclaw.context.message_count"),
                    "promptChars": get_attr(span, "openclaw.context.prompt_chars"),
                    "tokenBudget": get_attr(span, "openclaw.context.token_budget"),
                }

            # Tool execution
            elif name in ("openclaw.tool.execution", "tool_call"):
                run["tool_calls"].append({
                    "tool": get_attr(span, "openclaw.tool") or get_attr(span, "tool.name"),
                    "durationMs": dur,
                })

            # LLM loop (2026.5.7) — contains aggregated usage for the whole run
            elif name.startswith("llm loop:"):
                # Extract total usage from the loop span
                inp = get_attr(span, "gen_ai.usage.input_tokens")
                out = get_attr(span, "gen_ai.usage.output_tokens")
                total = get_attr(span, "gen_ai.usage.total_tokens")
                cache_read = get_attr(span, "gen_ai.usage.cache_read_input_tokens")
                if total and not run.get("_loop_total_tokens"):
                    run["_loop_total_tokens"] = int(total)
                    run["_loop_input_tokens"] = int(inp) if inp else None
                    run["_loop_cache_read"] = int(cache_read) if cache_read else None

        if run["model_calls"] or run["e2eMs"]:
            runs.append(run)

    return runs


def print_report(runs: List[Dict]):
    print("━" * 80)
    print("  🦞  OPENCLAW LATENCY ANALYSIS")
    print(f"  Runs: {len(runs)}")
    print("━" * 80)
    print()

    print(f"{'trace':<12} {'e2e_ms':>8} {'model':>20} {'calls':>6} {'total_tok':>10} {'1st_dur':>8} {'ttft':>8}")
    print("─" * 80)

    for run in runs:
        calls = run["model_calls"]
        e2e = run["e2eMs"] or "?"
        model = (run["model"] or "?")[:20]
        total_tok = run.get("_loop_total_tokens") or (calls[0]["totalTokens"] if calls and calls[0].get("totalTokens") else "?")
        first_dur = f"{calls[0]['durationMs']}ms" if calls and calls[0].get("durationMs") else "?"
        ttft = f"{calls[0]['ttftMs']}ms" if calls and calls[0].get("ttftMs") else "N/A"

        print(
            f"{run['traceId']:<12} "
            f"{e2e:>8} "
            f"{model:>20} "
            f"{len(calls):>6} "
            f"{total_tok:>10} "
            f"{first_dur:>8} "
            f"{ttft:>8}"
        )

    # Context analysis (if available)
    ctx_runs = [r for r in runs if r.get("context")]
    if ctx_runs:
        print()
        print("━" * 80)
        print("  CONTEXT SIZE vs LATENCY")
        print("━" * 80)
        print()
        for run in ctx_runs:
            ctx = run["context"]
            sys_chars = int(ctx.get("systemPromptChars") or 0)
            hist_chars = int(ctx.get("historyTextChars") or 0)
            total_chars = sys_chars + hist_chars
            calls = run["model_calls"]
            first_ttft = calls[0].get("ttftMs") if calls else None
            first_dur = calls[0].get("durationMs") if calls else None
            print(f"  trace={run['traceId']} ctx_chars={total_chars:,} first_call={first_dur}ms ttft={first_ttft}ms")

    # Token-based analysis (for 2026.5.7 without context.assembled)
    tok_runs = [r for r in runs if r.get("_loop_total_tokens") or (r["model_calls"] and r["model_calls"][0].get("totalTokens"))]
    if tok_runs and not ctx_runs:
        print()
        print("━" * 80)
        print("  TOTAL TOKENS vs LATENCY (context.assembled unavailable, using token counts)")
        print("━" * 80)
        print()
        print(f"  {'total_tokens':>12} {'first_call_ms':>14} {'e2e_ms':>10}")
        print(f"  {'─'*12} {'─'*14} {'─'*10}")
        for run in tok_runs:
            total = run.get("_loop_total_tokens") or (run["model_calls"][0]["totalTokens"] if run["model_calls"] else 0)
            first = run["model_calls"][0]["durationMs"] if run["model_calls"] else None
            e2e = run["e2eMs"]
            print(f"  {total:>12,} {f'{first}ms':>14} {f'{e2e}ms' if e2e else '?':>10}")

    print()
    print("━" * 80)
    if not ctx_runs:
        print("  Note: context.assembled spans not available (requires OpenClaw >= 2026.5.12)")
        print("  Using total_tokens as context size proxy for correlation analysis.")
    print("━" * 80)


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PATH
    if not Path(path).exists():
        print(f"Error: {path} not found.")
        sys.exit(1)

    traces = parse_traces(path)
    runs = extract_runs(traces)

    if not runs:
        print("No data found. 确认 agent 已完成至少一次回复。")
        sys.exit(0)

    print_report(runs)


if __name__ == "__main__":
    main()
