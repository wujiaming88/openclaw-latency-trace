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
   `node:os`, `node:util`, `node:perf_hooks`, `node:test`, `node:assert`). Do
   not add `dependencies` or `devDependencies` to package.json.
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
| `message_received` | Stamps `messageReceivedAt` (E2E start). If runId is unknown yet, parks an orphan keyed by sessionKey for later attach |
| `before_agent_run` | Stamps `agentStartAt` (Gateway → Agent boundary) **and** `_beforeAgentRunAt` (gateway sub-stage anchor) |
| `before_prompt_build` | Stamps `_beforePromptBuildAt` (gateway sub-stage anchor; first call wins). Captures `prompt` + `messages` UTF-8 bytes for the upcoming model call; cached on the run, drained onto the next `model_call_ended` detail |
| `model_call_started` | Stamps `_modelCallStartedAt` (gateway sub-stage anchor; first call wins). Flushes stale runs; creates/updates the run record; backfills `agentStartAt`; stamps `provider`, `model` |
| `model_call_ended` | Reads `systemPromptReport` chars from the trajectory file, merges with cached prompt/history bytes, pushes a model-call detail entry; updates `lastModelCallEndedAt` |
| `agent_end` | Stamps `agentEndAt` **and** `messageSentAt` (treated as the E2E endpoint — see *Why no delivery latency*); flushes immediately |
| `before_tool_call` | Starts the tool stopwatch |
| `after_tool_call` | Pushes a tool-call detail entry |

Hook choice rationale: the legacy `llm_input` hook is gated by
`!skipPromptSubmission && !isRawModelRun && hasHooks("llm_input")` in OpenClaw
≥ 2026.5.12 and silently no-ops on the Feishu / Bedrock embedded path.
`before_prompt_build` (per-call prompt + messages) is gated only by
`hasHooks(...)` and reliably fires on every production path we've observed.
This is why context lives on `model.detail[i]` (per-call) rather than at the
run level — `before_prompt_build` fires once per model call and may carry
different `messages` each time.

State lives in a process-local `Map<runId, run>` plus a `Map<sessionKey, runId>`
index for events whose `runId` arrives later than the wall-clock anchor. A run
is flushed when:
- `agent_end` fires (immediate flush — the e2e endpoint), or
- A new run starts (previous runs with model calls are flushed eagerly), or
- The 60s sweeper finds a run older than 10 minutes (covers the case where
  `agent_end` never fires, e.g. abort).

The `sessionKey → runId` index is retained for 60s after flush so a
late-arriving event can still resolve to the (already-written) run id without
spawning a phantom record.

If `agent_end` never fires, the run is flushed by the 10-minute sweeper, with
`agentRunMs` falling back to `lastModelCallEndedAt − agentStartAt`. Any missing
time anchor produces `null` for the affected stage; the run still flushes.

Flush appends one JSON line via `appendFileSync` and removes the run from the
Map. Failures are swallowed silently (best-effort tracing must never break the
gateway).

## Why no delivery latency

OpenClaw 2026.5.12 does not expose `runId` in any hook that fires after
channel-API delivery. `message_sent` payloads omit `runId` in
`deliverOutboundPayloads`; `reply_dispatch` is an entry-claim hook that fires
*before* the agent run starts (used for "first-claim wins" routing decisions),
not an exit signal. This plugin therefore treats `agent_end` as the e2e
endpoint, accepting a few-hundred-ms inaccuracy (the channel-API send leg is
outside the plugin's view).

If OpenClaw upstream later adds `runId` to a post-delivery hook, the
`lookupRun` helper is preserved in `index.mjs` for a one-line revival —
register the new hook, call `lookupRun`, stamp `messageSentAt`, flush.

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
| `e2eMs` | number\|null | `agentEndAt − messageReceivedAt` (== `stages.gatewayMs + stages.agentRunMs`). Does **not** include the channel-API send leg — see *Why no delivery latency* |
| `stages.gatewayMs` | number\|null | `agentStartAt − messageReceivedAt` — upstream-delivery → agent-start latency (network + queueing; `messageReceivedAt` comes from `evt.timestamp`) |
| `stages.agentRunMs` | number\|null | `(agentEndAt ?? lastModelCallEndedAt) − agentStartAt` |
| `stages.gateway.preludeMs` | number\|null | `_beforePromptBuildAt − messageReceivedAt`. Gateway-side hook chain before prompt build kicks in. Clamped to 0 |
| `stages.gateway.promptBuildMs` | number\|null | `_beforeAgentRunAt − _beforePromptBuildAt`. Prompt build + context injection. Clamped to 0 |
| `stages.gateway.beforeAgentRunMs` | number\|null | `_modelCallStartedAt − _beforeAgentRunAt`. Falls inside `agentRunMs`, not `gatewayMs` — listed under `gateway.*` because it's the last hook stage before model call. Clamped to 0 |
| `eventLoop.delayP{50,95,99}Ms` | number\|null | Process-level event loop delay percentiles since last flush, ms |
| `eventLoop.delayMaxMs` | number\|null | Window max ms |
| `eventLoop.windowMs` | number\|null | Time window covered (last reset → flush). `null` if histogram had no samples |
| `model.calls` | number | model call count |
| `model.totalMs` | number | sum of model call durations |
| `model.totalTtftMs` | number | sum of TTFTs |
| `model.totalGenerationMs` | number | totalMs − totalTtftMs |
| `model.avgTtftMs` | number\|null | mean TTFT |
| `model.firstCallTtftMs` | number\|null | TTFT of first model call |
| `model.detail[]` | array | per-call: `{provider, model, outcome, durationMs, ttftMs, responseBytes, context}` |
| `model.detail[].context` | object | `{systemPromptChars, projectContextChars, nonProjectContextChars, promptBytes, historyBytes, imagesCount}`. **Mixed units** — see *How systemPrompt chars are read* below |
| `tools.calls` | number | tool call count |
| `tools.totalMs` | number | sum of tool durations |
| `tools.detail[]` | array | per-call: `{name, durationMs, error}` |

## How systemPrompt chars are read

OpenClaw 2026.5.12 has no plugin hook that carries the `systemPromptReport`,
and the systemPrompt string itself is delivered to `before_agent_run` only on
some code paths (the Feishu / Bedrock embedded path leaves it unset).
trajectory.jsonl truncates the string when chars > 32768 — production runs
typically sit at ~42K chars, so even when the trajectory contains the
systemPrompt it's stored as `{truncated:true, originalChars, limitChars}`
rather than the literal string. Computing UTF-8 bytes from that is just
guessing.

OpenClaw itself emits a `trace.metadata` event into the trajectory file with
the authoritative chars breakdown — the same numbers it logs as
`[context-diag] systemPromptChars=...`. We read those directly:

- **File path:** `~/.openclaw/agents/<agentId>/sessions/<sessionId>.trajectory.jsonl`
- **When:** on every `model_call_ended` (mtime + 10s TTL cache so a long
  conversation doesn't re-parse the same file on every model call)
- **Lookup:** scan lines bottom-up for `type === "trace.metadata"`, read
  `data.prompting.systemPromptReport.systemPrompt.{chars, projectContextChars, nonProjectContextChars}`
- **agentId / sessionId:** from `ctx.agentId` / `ctx.sessionId` if the harness
  populates them; otherwise `agentId` is parsed from the sessionKey
  (`agent:<agentId>:...`) and `sessionId` falls back to `evt.sessionId`. If
  either is missing or the file doesn't exist yet, all three chars fields
  return `0` — the plugin never throws.

### Why mixed units (chars + bytes)

- `systemPromptChars` is **chars** because the trajectory only gives us chars
  (no bytes), and chars match what OpenClaw logs internally.
- `promptBytes` / `historyBytes` are **bytes** because `before_prompt_build`
  hands us raw strings and `Buffer.byteLength(..., "utf8")` is the most
  honest local measurement we can do.
- We don't fake a unified field. Users who want a total run `jq
  '.context.promptBytes + .context.historyBytes'` and look at chars
  separately.

## Gateway sub-stages and event loop histogram (v1.1+)

`stages.gateway.{preludeMs, promptBuildMs, beforeAgentRunMs}` decompose what
used to be an opaque `gatewayMs` number into the three hook intervals before
the first model call. The intervals can independently be `null` if their
endpoint hook never fired on a given path. They are computed with
`Math.max(0, end − start)` because OpenClaw's hook order is not strictly
guaranteed across paths (e.g. `model_call_started` can fire before
`before_agent_run` in fallback paths). The classic invariants still hold —
`stages.gatewayMs` and `stages.agentRunMs` are unchanged from v1.0, and
`preludeMs + promptBuildMs == gatewayMs` whenever both sub-stages are
non-null.

`eventLoop` reports a process-level event loop delay histogram from
`perf_hooks.monitorEventLoopDelay({ resolution: 20 })`. The histogram is
**global / shared across runs** — it is enabled once at module load, read at
each flush, and reset. Trade-off: concurrent flushes will reset each other's
window. This is acceptable because the signal we care about (is the gateway
process blocked?) is process-global, not per-run, and a per-run histogram
would be both expensive (one ELDHistogram per concurrent run) and noisier
(each sample partitioned across many windows). When the histogram has no
samples (e.g. two flushes happen synchronously within a single tick), all
five `eventLoop.*` fields are `null`. Histogram values from `perf_hooks` are
**nanoseconds**; the plugin converts to ms before writing.

## Tests

`npm test` runs `node --test test/*.test.mjs`. Tests are zero-dep
(`node:test` + `node:assert`) and import `index.mjs` with a cache-busting
query string per test so each test gets a fresh module instance (fresh
`runs` Map, fresh global histogram, fresh `OUTPUT` constant). Each test
sets `LATENCY_TRACE_OUTPUT` to a unique tmpfile *before* dynamic-importing
the module.

## Compatibility

- Requires OpenClaw ≥ 2026.5.12 (event names and payload shape).
- Node.js built-ins only — never add a package manager step to install.
