# CLAUDE.md

Onboarding for AI assistants working on this repo. Read this first.

## What this repo is

A single-purpose OpenClaw plugin that records per-run latency traces to a local
JSONL file. Nothing else lives here.

## Iron rules (do not violate)

1. **Single responsibility.** This repo is the latency-trace plugin. Do not add
   unrelated scripts (OTel debugging, Hermes diagnostics, config patchers,
   gateway recovery tools, generic setup helpers). If a tool is useful but not
   *this plugin*, it belongs in a different repo.
2. **Zero npm dependencies.** Node.js built-ins only (`node:fs`, `node:path`,
   `node:util`). Do not add `dependencies` or `devDependencies` to package.json.
3. **No bloat in README.** README structure is fixed: capabilities → install →
   verify → jq recipes → env vars → requirements → license. Do not pad it.
4. **No project scaffolding.** No CI, no GitHub Actions, no issue templates, no
   CHANGELOG, no lint/format configs, no contributing guide — unless the owner
   explicitly asks. The owner has a strong preference against tooling sprawl.

## Architecture

Plugin is one file: `index.mjs`. It exports a default object with `id` and
`register(api)`, where `api.on(event, handler)` subscribes to gateway events.

Subscribed events:

| Event | What it does |
|---|---|
| `model_call_started` | Flushes stale runs; creates/updates the run record; stamps `agentStartAt`, `provider`, `model` |
| `model_call_ended` | Pushes a model-call detail entry; schedules a flush in `FLUSH_DELAY_MS` (3s) |
| `before_tool_call` | Cancels pending flush; starts the tool stopwatch |
| `after_tool_call` | Pushes a tool-call detail entry |

State lives in a process-local `Map<runId, run>`. A run is flushed when:
- 3s elapse after the last `model_call_ended` with no further activity, or
- A new run starts (previous runs with model calls are flushed eagerly), or
- The 60s sweeper finds a run older than 10 minutes.

Flush appends one JSON line via `appendFileSync` and removes the run from the
Map. Failures are swallowed silently (best-effort tracing must never break the
gateway).

## Files

| File | Purpose |
|---|---|
| `index.mjs` | Plugin entry, event handlers, aggregation, flush logic |
| `openclaw.plugin.json` | OpenClaw plugin manifest (id, name, description, configSchema) |
| `package.json` | npm metadata; `type: module`, `openclaw.extensions` points at index.mjs |
| `README.md` | User-facing docs (install, verify, jq analysis, env vars) |

## JSONL output schema

One line per agent run, written to `$LATENCY_TRACE_OUTPUT` (default
`/tmp/openclaw/latency-trace.jsonl`).

| Field | Type | Meaning |
|---|---|---|
| `ts` | string | ISO timestamp at flush |
| `runId` | string | OpenClaw run id |
| `sessionKey` | string | OpenClaw session key |
| `provider` | string | LLM provider id from first model call |
| `agentRunMs` | number\|null | now − `agentStartAt` (first `model_call_started`) |
| `model.calls` | number | model call count |
| `model.totalMs` | number | sum of model call durations |
| `model.totalTtftMs` | number | sum of TTFTs |
| `model.totalGenerationMs` | number | totalMs − totalTtftMs |
| `model.avgTtftMs` | number\|null | mean TTFT |
| `model.firstCallTtftMs` | number\|null | TTFT of first model call |
| `model.detail[]` | array | per-call: `{provider, model, outcome, durationMs, ttftMs, requestBytes, responseBytes}` |
| `tools.calls` | number | tool call count |
| `tools.totalMs` | number | sum of tool durations |
| `tools.detail[]` | array | per-call: `{name, durationMs, error}` |

Note: top-level `model` is overwritten with the aggregate object (the earlier
string assignment is shadowed by design — keep the object form).

## Compatibility

- Requires OpenClaw ≥ 2026.5.12 (event names and payload shape).
- Node.js built-ins only — never add a package manager step to install.
