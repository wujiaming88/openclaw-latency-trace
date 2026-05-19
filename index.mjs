import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";

const OUTPUT = process.env.LATENCY_TRACE_OUTPUT
  || join(process.env.OPENCLAW_LOG_DIR || "/tmp/openclaw", "latency-trace.jsonl");
try { mkdirSync(dirname(OUTPUT), { recursive: true }); } catch (_) {}

// Global event-loop delay histogram. Shared across all runs by design — the
// signal we want is "is the gateway process blocked", which is global. A
// per-run histogram would be both expensive (one ELDHistogram per concurrent
// run) and noisy (each sees only a fraction of the timeline). Trade-off:
// concurrent flushes will reset each other's window. Acceptable because the
// first concurrent flush still surfaces blockage and the retained window
// length is reported as `eventLoop.windowMs`.
const elHistogram = monitorEventLoopDelay({ resolution: 20 });
elHistogram.enable();
let elHistogramResetAt = Date.now();

function readEventLoopMetrics() {
  const now = Date.now();
  const count = elHistogram.count;
  const windowMs = now - elHistogramResetAt;
  const result = {
    delayP50Ms: null,
    delayP95Ms: null,
    delayP99Ms: null,
    delayMaxMs: null,
    windowMs: count > 0 ? windowMs : null,
  };
  if (count > 0) {
    try {
      result.delayP50Ms = Math.round((elHistogram.percentile(50) / 1e6) * 10) / 10;
      result.delayP95Ms = Math.round((elHistogram.percentile(95) / 1e6) * 10) / 10;
      result.delayP99Ms = Math.round((elHistogram.percentile(99) / 1e6) * 10) / 10;
      result.delayMaxMs = Math.round((elHistogram.max / 1e6) * 10) / 10;
    } catch (_) {}
  }
  elHistogram.reset();
  elHistogramResetAt = now;
  return result;
}

const runs = new Map();
const sessionToRun = new Map();
const orphanReceived = new Map();
const SESSION_INDEX_TTL_MS = 60_000;
const ORPHAN_TTL_MS = 60_000;

const TRAJECTORY_CACHE = new Map();
const TRAJECTORY_CACHE_TTL_MS = 10_000;

function utf8(s) { return Buffer.byteLength(s ?? "", "utf8"); }

function inferAgentIdFromSessionKey(sessionKey) {
  if (!sessionKey) return null;
  const m = String(sessionKey).match(/^agent:([^:]+):/);
  return m ? m[1] : null;
}

// systemPrompt char counts come from OpenClaw's own `systemPromptReport` (the
// same numbers it logs as `[context-diag] systemPromptChars=...`). No plugin
// hook in 2026.5.12 carries the report, so we read it from the trajectory
// file. trajectory.jsonl truncates the systemPrompt *string* when chars
// > 32768 (production runs are ~42K), so computing UTF-8 bytes from it is
// unreliable — chars from the report are the authoritative number.
function readSystemPromptInfo(agentId, sessionId) {
  const fallback = { systemPromptChars: 0, projectContextChars: 0, nonProjectContextChars: 0 };
  if (!agentId || !sessionId) return fallback;

  try {
    const file = join(homedir(), ".openclaw", "agents", agentId, "sessions", `${sessionId}.trajectory.jsonl`);
    if (!existsSync(file)) return fallback;

    const stat = statSync(file);
    const cacheKey = `${agentId}:${sessionId}`;
    const cached = TRAJECTORY_CACHE.get(cacheKey);
    if (cached && cached.mtime === stat.mtimeMs && cached.expiresAt > Date.now()) {
      return cached.info;
    }

    const raw = readFileSync(file, "utf8");
    const lines = raw.split("\n");
    let info = fallback;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || !line.trim()) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      if (!evt || evt.type !== "trace.metadata") continue;
      const r = evt?.data?.prompting?.systemPromptReport?.systemPrompt;
      if (r && typeof r.chars === "number") {
        info = {
          systemPromptChars: r.chars || 0,
          projectContextChars: r.projectContextChars || 0,
          nonProjectContextChars: r.nonProjectContextChars || 0,
        };
        break;
      }
    }

    TRAJECTORY_CACHE.set(cacheKey, { info, mtime: stat.mtimeMs, expiresAt: Date.now() + TRAJECTORY_CACHE_TTL_MS });
    return info;
  } catch (_) { return fallback; }
}

function getRun(runId, sessionKey) {
  if (!runId) return null;
  if (!runs.has(runId)) {
    const orphan = sessionKey ? orphanReceived.get(sessionKey) : null;
    runs.set(runId, {
      runId, sessionKey, createdAt: Date.now(),
      messageReceivedAt: orphan?.at ?? null,
      agentStartAt: null, agentEndAt: null, messageSentAt: null,
      lastModelCallEndedAt: null,
      _beforePromptBuildAt: null, _beforeAgentRunAt: null, _modelCallStartedAt: null,
      provider: null, model: null,
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

  // Gateway sub-stages. Use max(0, …) because OpenClaw hook order is not
  // strictly guaranteed across paths (model_call_started can fire before
  // before_agent_run on fallback paths), and we never want negatives.
  //
  // `before_agent_run` is a *subscriber-only* hook in OpenClaw — when no
  // plugin subscribes to it, the gateway short-circuits and never fires it
  // (`if (hookRunner?.hasHooks("before_agent_run"))` in selection.js). On
  // those paths `_beforeAgentRunAt` stays null. We fall back to
  // `_modelCallStartedAt` for the right edge of `promptBuildMs` so the user
  // still sees the prelude/build/run waterfall, accepting that this merged
  // figure now spans both prompt build *and* the (untriggered) before-agent
  // hook chain. `beforeAgentRunMs` itself remains null on those paths — it
  // genuinely cannot be measured without the anchor.
  const preludeMs = (run._beforePromptBuildAt && run.messageReceivedAt)
    ? Math.max(0, run._beforePromptBuildAt - run.messageReceivedAt) : null;
  const promptBuildEndAt = run._beforeAgentRunAt ?? run._modelCallStartedAt;
  const promptBuildMs = (promptBuildEndAt && run._beforePromptBuildAt)
    ? Math.max(0, promptBuildEndAt - run._beforePromptBuildAt) : null;
  const beforeAgentRunMs = (run._modelCallStartedAt && run._beforeAgentRunAt)
    ? Math.max(0, run._modelCallStartedAt - run._beforeAgentRunAt) : null;

  const record = {
    ts: new Date().toISOString(),
    runId: run.runId,
    sessionKey: run.sessionKey,
    provider: run.provider,
    e2eMs,
    stages: {
      gatewayMs,
      agentRunMs,
      gateway: { preludeMs, promptBuildMs, beforeAgentRunMs },
    },
    eventLoop: readEventLoopMetrics(),
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
      const now = Date.now();
      if (!r._beforeAgentRunAt) r._beforeAgentRunAt = now;
      if (!r.agentStartAt) r.agentStartAt = now;
    });

    api.on("before_prompt_build", (evt, ctx) => {
      const r = findRun(evt, ctx);
      if (!r) return;
      if (!r._beforePromptBuildAt) r._beforePromptBuildAt = Date.now();
      r._pendingContext = {
        promptBytes: utf8(evt?.prompt),
        historyBytes: utf8(JSON.stringify(evt?.messages || [])),
        imagesCount: 0,
      };
    });

    api.on("model_call_started", (evt, ctx) => {
      flushPreviousRuns(evt.runId);
      const r = getRun(evt.runId, evt.sessionKey || ctx?.sessionKey);
      if (!r) return;
      const now = Date.now();
      if (!r._modelCallStartedAt) r._modelCallStartedAt = now;
      if (!r.agentStartAt) r.agentStartAt = now;
      r.provider = evt.provider;
      r.model = evt.model;
    });

    api.on("model_call_ended", (evt, ctx) => {
      const r = findRun(evt, ctx);
      if (!r) return;
      r.lastModelCallEndedAt = Date.now();

      const agentId = ctx?.agentId || inferAgentIdFromSessionKey(ctx?.sessionKey || evt?.sessionKey || r.sessionKey);
      const sessionId = ctx?.sessionId || evt?.sessionId;
      const info = readSystemPromptInfo(agentId, sessionId);

      let context = r._pendingContext;
      if (context) {
        context.systemPromptChars = info.systemPromptChars;
        context.projectContextChars = info.projectContextChars;
        context.nonProjectContextChars = info.nonProjectContextChars;
      } else {
        context = {
          systemPromptChars: info.systemPromptChars,
          projectContextChars: info.projectContextChars,
          nonProjectContextChars: info.nonProjectContextChars,
          promptBytes: 0,
          historyBytes: 0,
          imagesCount: 0,
        };
      }

      r.modelCalls.push({
        provider: evt.provider,
        model: evt.model,
        outcome: evt.outcome,
        durationMs: evt.durationMs,
        ttftMs: evt.timeToFirstByteMs ?? null,
        responseBytes: evt.responseStreamBytes ?? null,
        context,
      });
      r._pendingContext = null;
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
