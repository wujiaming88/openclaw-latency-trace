import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const OUTPUT = process.env.LATENCY_TRACE_OUTPUT
  || join(process.env.OPENCLAW_LOG_DIR || "/tmp/openclaw", "latency-trace.jsonl");
try { mkdirSync(dirname(OUTPUT), { recursive: true }); } catch (_) {}

const runs = new Map();
const sessionToRun = new Map();
const orphanReceived = new Map();
const SESSION_INDEX_TTL_MS = 60_000;
const ORPHAN_TTL_MS = 60_000;

function utf8(s) { return Buffer.byteLength(s ?? "", "utf8"); }

function getRun(runId, sessionKey) {
  if (!runId) return null;
  if (!runs.has(runId)) {
    const orphan = sessionKey ? orphanReceived.get(sessionKey) : null;
    runs.set(runId, {
      runId, sessionKey, createdAt: Date.now(),
      messageReceivedAt: orphan?.at ?? null,
      agentStartAt: null, agentEndAt: null, messageSentAt: null,
      lastModelCallEndedAt: null,
      provider: null, model: null,
      systemPromptBytes: 0,
      modelCalls: [], toolCalls: [],
      _pendingContext: null, _toolT0: null, _toolName: null,
    });
    if (sessionKey) orphanReceived.delete(sessionKey);
  }
  const r = runs.get(runId);
  if (sessionKey && !r.sessionKey) r.sessionKey = sessionKey;
  if (sessionKey) sessionToRun.set(sessionKey, runId);
  return r;
}

function findRun(evt, ctx) {
  const runId = evt?.runId || ctx?.runId;
  const sessionKey = evt?.sessionKey || ctx?.sessionKey;
  if (runId) return getRun(runId, sessionKey);
  if (sessionKey && sessionToRun.has(sessionKey)) {
    return runs.get(sessionToRun.get(sessionKey)) || null;
  }
  return null;
}

// Lookup-only — never creates a run. Reserved for a future terminal hook that
// fires *after* channel-API delivery and carries runId/sessionKey. OpenClaw
// 2026.5.12 has no such hook (message_sent omits runId in deliver paths;
// reply_dispatch is an entry-claim hook), so this helper is currently unused.
// Kept so reviving the post-delivery endpoint is a one-line handler, not a
// refactor.
function lookupRun(evt, ctx) {
  const runId = evt?.runId || ctx?.runId;
  const sessionKey = evt?.sessionKey || ctx?.sessionKey;
  if (runId && runs.has(runId)) return runs.get(runId);
  if (sessionKey && sessionToRun.has(sessionKey)) {
    return runs.get(sessionToRun.get(sessionKey)) || null;
  }
  return null;
}

function flush(run) {
  const modelMs = run.modelCalls.reduce((s, c) => s + (c.durationMs || 0), 0);
  const modelTtft = run.modelCalls.reduce((s, c) => s + (c.ttftMs || 0), 0);
  const toolMs = run.toolCalls.reduce((s, c) => s + (c.durationMs || 0), 0);

  const agentEndAt = run.agentEndAt ?? run.lastModelCallEndedAt;
  const gatewayMs = (run.messageReceivedAt && run.agentStartAt)
    ? run.agentStartAt - run.messageReceivedAt : null;
  const agentRunMs = (run.agentStartAt && agentEndAt)
    ? agentEndAt - run.agentStartAt : null;
  const e2eMs = (gatewayMs != null && agentRunMs != null)
    ? gatewayMs + agentRunMs : null;

  const record = {
    ts: new Date().toISOString(),
    runId: run.runId,
    sessionKey: run.sessionKey,
    provider: run.provider,
    e2eMs,
    stages: { gatewayMs, agentRunMs },
    model: {
      calls: run.modelCalls.length,
      totalMs: modelMs,
      totalTtftMs: modelTtft,
      totalGenerationMs: modelMs - modelTtft,
      avgTtftMs: run.modelCalls.length ? Math.round(modelTtft / run.modelCalls.length) : null,
      firstCallTtftMs: run.modelCalls[0]?.ttftMs ?? null,
      detail: run.modelCalls,
    },
    tools: { calls: run.toolCalls.length, totalMs: toolMs, detail: run.toolCalls },
  };
  try { appendFileSync(OUTPUT, JSON.stringify(record) + "\n"); } catch (_) {}
  runs.delete(run.runId);
  if (run.sessionKey && sessionToRun.get(run.sessionKey) === run.runId) {
    const sk = run.sessionKey, rid = run.runId;
    setTimeout(() => {
      if (sessionToRun.get(sk) === rid) sessionToRun.delete(sk);
    }, SESSION_INDEX_TTL_MS).unref();
  }
}

function flushPreviousRuns(currentRunId) {
  for (const [id, run] of runs) {
    if (id !== currentRunId && run.modelCalls.length > 0) flush(run);
  }
}

setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, run] of runs) { if (run.createdAt < cutoff) flush(run); }
  const orphanCutoff = Date.now() - ORPHAN_TTL_MS;
  for (const [key, o] of orphanReceived) { if (o.at < orphanCutoff) orphanReceived.delete(key); }
}, 60_000).unref();

export default {
  id: "latency-trace",
  register(api) {
    api.on("message_received", (evt, ctx) => {
      const at = evt?.timestamp ?? Date.now();
      const runId = evt?.runId || ctx?.runId;
      const sessionKey = evt?.sessionKey || ctx?.sessionKey;
      if (runId) {
        const r = getRun(runId, sessionKey);
        if (r && !r.messageReceivedAt) r.messageReceivedAt = at;
      } else if (sessionKey) {
        orphanReceived.set(sessionKey, { at });
      }
    });

    api.on("before_agent_run", (evt, ctx) => {
      const r = findRun(evt, ctx);
      if (!r) return;
      if (!r.agentStartAt) r.agentStartAt = Date.now();
      r.systemPromptBytes = utf8(evt?.systemPrompt);
    });

    api.on("before_prompt_build", (evt, ctx) => {
      const r = findRun(evt, ctx);
      if (!r) return;
      const promptBytes = utf8(evt?.prompt);
      const historyBytes = utf8(JSON.stringify(evt?.messages || []));
      const sysBytes = r.systemPromptBytes ?? 0;
      r._pendingContext = {
        systemPromptBytes: sysBytes,
        promptBytes,
        historyBytes,
        totalContextBytes: sysBytes + promptBytes + historyBytes,
        imagesCount: 0,
      };
    });

    api.on("model_call_started", (evt, ctx) => {
      flushPreviousRuns(evt.runId);
      const r = getRun(evt.runId, evt.sessionKey || ctx?.sessionKey);
      if (!r) return;
      if (!r.agentStartAt) r.agentStartAt = Date.now();
      r.provider = evt.provider;
      r.model = evt.model;
    });

    api.on("model_call_ended", (evt, ctx) => {
      const r = findRun(evt, ctx);
      if (!r) return;
      r.lastModelCallEndedAt = Date.now();
      const detail = {
        provider: evt.provider,
        model: evt.model,
        outcome: evt.outcome,
        durationMs: evt.durationMs,
        ttftMs: evt.timeToFirstByteMs ?? null,
        responseBytes: evt.responseStreamBytes ?? null,
      };
      if (r._pendingContext) {
        detail.context = r._pendingContext;
        r._pendingContext = null;
      }
      r.modelCalls.push(detail);
    });

    // E2E endpoint. OpenClaw 2026.5.12 has no post-delivery hook that carries
    // runId, so agent completion is treated as the e2e terminator. Trade-off:
    // misses the channel-API send leg (typically 100ms–1s), which is outside
    // this plugin's view anyway.
    api.on("agent_end", (evt, ctx) => {
      const r = findRun(evt, ctx);
      if (!r) return;
      if (!r.agentEndAt) r.agentEndAt = Date.now();
      if (!r.messageSentAt) r.messageSentAt = r.agentEndAt;
      flush(r);
    });

    api.on("before_tool_call", (evt, ctx) => {
      const r = findRun(evt, ctx);
      if (r) { r._toolT0 = Date.now(); r._toolName = evt.toolName; }
    });

    api.on("after_tool_call", (evt, ctx) => {
      const r = findRun(evt, ctx);
      if (!r) return;
      r.toolCalls.push({
        name: evt.toolName || r._toolName,
        durationMs: evt.durationMs ?? (r._toolT0 ? Date.now() - r._toolT0 : null),
        error: evt.error ?? null,
      });
      r._toolT0 = null;
    });
  },
};
