import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const OUTPUT = process.env.LATENCY_TRACE_OUTPUT
  || join(process.env.OPENCLAW_LOG_DIR || "/tmp/openclaw", "latency-trace.jsonl");
try { mkdirSync(dirname(OUTPUT), { recursive: true }); } catch (_) {}

const runs = new Map();
const FLUSH_DELAY_MS = 3000;

function getRun(runId, sessionKey) {
  if (!runs.has(runId)) {
    runs.set(runId, {
      runId, sessionKey, createdAt: Date.now(),
      agentStartAt: null, provider: null, model: null,
      modelCalls: [], toolCalls: [], _toolT0: null, _flushTimer: null,
    });
  }
  const r = runs.get(runId);
  if (sessionKey && !r.sessionKey) r.sessionKey = sessionKey;
  return r;
}

function scheduleFlush(run) {
  if (run._flushTimer) clearTimeout(run._flushTimer);
  run._flushTimer = setTimeout(() => flush(run), FLUSH_DELAY_MS);
}

function cancelFlush(run) {
  if (run._flushTimer) { clearTimeout(run._flushTimer); run._flushTimer = null; }
}

function flush(run) {
  if (run._flushTimer) { clearTimeout(run._flushTimer); run._flushTimer = null; }
  const now = Date.now();
  const modelMs = run.modelCalls.reduce((s, c) => s + (c.durationMs || 0), 0);
  const modelTtft = run.modelCalls.reduce((s, c) => s + (c.ttftMs || 0), 0);
  const toolMs = run.toolCalls.reduce((s, c) => s + (c.durationMs || 0), 0);
  const agentRunMs = run.agentStartAt ? now - run.agentStartAt : null;

  const record = {
    ts: new Date().toISOString(),
    runId: run.runId,
    sessionKey: run.sessionKey,
    provider: run.provider,
    model: run.model,
    agentRunMs,
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
}

function flushPreviousRuns(currentRunId) {
  for (const [id, run] of runs) {
    if (id !== currentRunId && run.modelCalls.length > 0) flush(run);
  }
}

setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, run] of runs) { if (run.createdAt < cutoff) flush(run); }
}, 60_000).unref();

export default {
  id: "latency-trace",
  register(api) {
    api.on("model_call_started", (evt) => {
      flushPreviousRuns(evt.runId);
      const r = getRun(evt.runId, evt.sessionKey);
      cancelFlush(r);
      if (!r.agentStartAt) r.agentStartAt = Date.now();
      r.provider = evt.provider;
      r.model = evt.model;
    });

    api.on("model_call_ended", (evt) => {
      if (!evt.runId) return;
      const r = runs.get(evt.runId);
      if (!r) return;
      r.modelCalls.push({
        provider: evt.provider,
        model: evt.model,
        outcome: evt.outcome,
        durationMs: evt.durationMs,
        ttftMs: evt.timeToFirstByteMs ?? null,
        requestBytes: evt.requestPayloadBytes ?? null,
        responseBytes: evt.responseStreamBytes ?? null,
      });
      scheduleFlush(r);
    });

    api.on("before_tool_call", (evt) => {
      if (!evt.runId) return;
      const r = runs.get(evt.runId);
      if (r) { cancelFlush(r); r._toolT0 = Date.now(); r._toolName = evt.toolName; }
    });

    api.on("after_tool_call", (evt) => {
      if (!evt.runId) return;
      const r = runs.get(evt.runId);
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
