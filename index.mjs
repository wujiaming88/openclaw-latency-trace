import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const OUTPUT = process.env.LATENCY_TRACE_OUTPUT
  || join(process.env.OPENCLAW_LOG_DIR || "/tmp/openclaw", "latency-trace.jsonl");
try { mkdirSync(dirname(OUTPUT), { recursive: true }); } catch (_) {}

const runs = new Map();

function getRun(runId, sessionKey) {
  if (!runs.has(runId)) {
    runs.set(runId, {
      runId, sessionKey,
      msgInAt: null, agentStartAt: null, agentEndAt: null, msgOutAt: null,
      provider: null, model: null,
      modelCalls: [], toolCalls: [], _ctx: null, _toolT0: null,
    });
  }
  const r = runs.get(runId);
  if (sessionKey && !r.sessionKey) r.sessionKey = sessionKey;
  return r;
}

function flush(run) {
  const now = Date.now();
  const modelMs = run.modelCalls.reduce((s, c) => s + (c.durationMs || 0), 0);
  const modelTtft = run.modelCalls.reduce((s, c) => s + (c.ttftMs || 0), 0);
  const toolMs = run.toolCalls.reduce((s, c) => s + (c.durationMs || 0), 0);

  const contexts = run.modelCalls.map(c => c.context).filter(Boolean);
  const firstCtx = contexts[0] || null;
  const lastCtx = contexts[contexts.length - 1] || null;

  const record = {
    ts: new Date().toISOString(),
    runId: run.runId,
    sessionKey: run.sessionKey,
    provider: run.provider,
    model: run.model,
    e2eMs: run.msgInAt ? (run.msgOutAt || now) - run.msgInAt : null,
    phases: {
      gatewayOverheadMs: (run.msgInAt && run.agentStartAt) ? run.agentStartAt - run.msgInAt : null,
      agentRunMs: run.agentStartAt ? (run.agentEndAt || now) - run.agentStartAt : null,
      deliveryMs: (run.agentEndAt && run.msgOutAt) ? run.msgOutAt - run.agentEndAt : null,
    },
    context: {
      firstCall: firstCtx,
      lastCall: lastCtx,
      growth: (firstCtx && lastCtx && contexts.length > 1) ? {
        historyMessagesDelta: (lastCtx.historyMessages || 0) - (firstCtx.historyMessages || 0),
        totalContextCharsDelta: (lastCtx.totalContextChars || 0) - (firstCtx.totalContextChars || 0),
      } : null,
    },
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

// Cleanup stale runs
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, run] of runs) { if (run.msgInAt && run.msgInAt < cutoff) flush(run); }
}, 60_000).unref();

export default {
  id: "latency-trace",
  register(api) {
    api.on("message_received", (evt) => {
      if (!evt.runId) return;
      getRun(evt.runId, evt.sessionKey).msgInAt = Date.now();
    });

    api.on("model_call_started", (evt) => {
      const r = getRun(evt.runId, evt.sessionKey);
      if (!r.agentStartAt) r.agentStartAt = Date.now();
      r.provider = evt.provider;
      r.model = evt.model;
    });

    api.on("llm_input", (evt) => {
      if (!evt.runId) return;
      const r = runs.get(evt.runId);
      if (!r) return;
      const sc = evt.systemPrompt?.length ?? 0;
      const pc = evt.prompt?.length ?? 0;
      const hm = Array.isArray(evt.historyMessages) ? evt.historyMessages.length : 0;
      // Estimate history chars without full serialization for performance
      let hc = 0;
      if (Array.isArray(evt.historyMessages) && evt.historyMessages.length < 200) {
        try { hc = JSON.stringify(evt.historyMessages).length; } catch (_) { hc = hm * 500; }
      } else {
        hc = hm * 500; // estimate for very long histories
      }
      r._ctx = { systemPromptChars: sc, promptChars: pc, historyMessages: hm, historyChars: hc, imagesCount: evt.imagesCount ?? 0, totalContextChars: sc + pc + hc };
    });

    api.on("model_call_ended", (evt) => {
      if (!evt.runId) return;
      const r = runs.get(evt.runId);
      if (!r) return;
      r.modelCalls.push({
        provider: evt.provider, model: evt.model, outcome: evt.outcome,
        durationMs: evt.durationMs, ttftMs: evt.timeToFirstByteMs ?? null,
        requestBytes: evt.requestPayloadBytes ?? null,
        responseBytes: evt.responseStreamBytes ?? null,
        context: r._ctx,
      });
      r._ctx = null;
    });

    api.on("before_tool_call", (evt) => {
      if (!evt.runId) return;
      const r = runs.get(evt.runId);
      if (r) { r._toolT0 = Date.now(); r._toolName = evt.toolName; }
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

    api.on("agent_end", (evt) => {
      if (!evt.runId) return;
      const r = runs.get(evt.runId);
      if (r) {
        r.agentEndAt = Date.now();
        setTimeout(() => { if (runs.has(evt.runId)) flush(r); }, 5000);
      }
    });

    api.on("message_sent", (evt) => {
      if (!evt.runId) return;
      const r = runs.get(evt.runId);
      if (r) { r.msgOutAt = Date.now(); flush(r); }
    });
  },
};
