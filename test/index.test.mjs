import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let testCounter = 0;

async function setup() {
  const tag = `${process.pid}-${Date.now()}-${++testCounter}`;
  const tmp = join(tmpdir(), `latency-trace-test-${tag}.jsonl`);
  process.env.LATENCY_TRACE_OUTPUT = tmp;
  // Cache-bust so each test gets a fresh module instance: fresh `runs` Map,
  // fresh global histogram, fresh OUTPUT constant.
  const mod = await import(`../index.mjs?t=${tag}`);
  const handlers = {};
  mod.default.register({ on: (event, h) => { handlers[event] = h; } });
  return { tmp, handlers };
}

function readLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

function cleanup(file) {
  try { unlinkSync(file); } catch (_) {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("happy path: all sub-stages populated", async () => {
  const { tmp, handlers } = await setup();
  const runId = "happy-1";
  const sessionKey = "agent:foo:bar";
  const t0 = Date.now() - 50;

  handlers.message_received({ runId, sessionKey, timestamp: t0 });
  await sleep(10);
  handlers.before_prompt_build({ runId, sessionKey, prompt: "hi", messages: [{ role: "user", content: "hi" }] });
  await sleep(10);
  handlers.before_agent_run({ runId, sessionKey });
  await sleep(10);
  handlers.model_call_started({ runId, sessionKey, provider: "p", model: "m" });
  handlers.model_call_ended({ runId, sessionKey, durationMs: 100, timeToFirstByteMs: 50 });
  handlers.agent_end({ runId, sessionKey });

  const lines = readLines(tmp);
  assert.equal(lines.length, 1);
  const r = lines[0];

  assert.equal(r.runId, runId);
  assert.equal(typeof r.stages.gatewayMs, "number");
  assert.equal(typeof r.stages.agentRunMs, "number");
  assert.equal(typeof r.stages.gateway.preludeMs, "number");
  assert.equal(typeof r.stages.gateway.promptBuildMs, "number");
  assert.equal(typeof r.stages.gateway.beforeAgentRunMs, "number");
  // Backward-compat invariant: gatewayMs == preludeMs + promptBuildMs (both
  // end at before_agent_run, which sets agentStartAt). beforeAgentRunMs
  // measures the post-agent-start window before model_call_started — it is
  // PART of agentRunMs, not gatewayMs.
  assert.equal(r.stages.gateway.preludeMs + r.stages.gateway.promptBuildMs, r.stages.gatewayMs);
  assert.ok(r.stages.gateway.beforeAgentRunMs >= 0);
  assert.ok(r.stages.gateway.beforeAgentRunMs <= r.stages.agentRunMs);
  assert.equal(typeof r.e2eMs, "number");

  cleanup(tmp);
});

test("before_prompt_build absent: prelude/promptBuild null, beforeAgentRunMs OK", async () => {
  const { tmp, handlers } = await setup();
  const runId = "no-pb";
  const sessionKey = "agent:foo:b";
  const t0 = Date.now() - 50;

  handlers.message_received({ runId, sessionKey, timestamp: t0 });
  await sleep(10);
  // Skip before_prompt_build
  handlers.before_agent_run({ runId, sessionKey });
  await sleep(10);
  handlers.model_call_started({ runId, sessionKey, provider: "p", model: "m" });
  handlers.model_call_ended({ runId, sessionKey, durationMs: 50, timeToFirstByteMs: 25 });
  handlers.agent_end({ runId, sessionKey });

  const lines = readLines(tmp);
  assert.equal(lines.length, 1);
  const r = lines[0];

  assert.equal(r.stages.gateway.preludeMs, null);
  assert.equal(r.stages.gateway.promptBuildMs, null);
  assert.equal(typeof r.stages.gateway.beforeAgentRunMs, "number");
  assert.ok(r.stages.gateway.beforeAgentRunMs >= 0);
  assert.equal(typeof r.stages.gatewayMs, "number");

  cleanup(tmp);
});

test("before_agent_run unsubscribed (v1.1.1): promptBuildMs falls back to model_call_started, beforeAgentRunMs stays null", async () => {
  // Scenario: OpenClaw paths where no plugin subscribes to before_agent_run.
  // The hook runner short-circuits and never fires it
  // (`if (hookRunner?.hasHooks("before_agent_run"))` in selection.js), so
  // _beforeAgentRunAt stays null. v1.1.1 falls back to _modelCallStartedAt
  // for the right edge of promptBuildMs while leaving beforeAgentRunMs null.
  const { tmp, handlers } = await setup();
  const runId = "no-bar";
  const sessionKey = "agent:foo:c";
  const t0 = Date.now() - 50;

  handlers.message_received({ runId, sessionKey, timestamp: t0 });
  await sleep(10);
  handlers.before_prompt_build({ runId, sessionKey, prompt: "hi", messages: [] });
  await sleep(15);
  // Skip before_agent_run entirely — simulating an unsubscribed hook path.
  handlers.model_call_started({ runId, sessionKey, provider: "p", model: "m" });
  handlers.model_call_ended({ runId, sessionKey, durationMs: 50, timeToFirstByteMs: 25 });
  handlers.agent_end({ runId, sessionKey });

  const lines = readLines(tmp);
  assert.equal(lines.length, 1);
  const r = lines[0];

  // beforeAgentRunMs has no anchor — must remain null (no fabrication).
  assert.equal(r.stages.gateway.beforeAgentRunMs, null);

  // promptBuildMs must now fall back to _modelCallStartedAt (v1.1.1 fix).
  // Before v1.1.1 this was null; the merged figure spans prompt build + the
  // (untriggered) before-agent hook chain, which is the most honest number
  // we can report without the missing anchor.
  assert.equal(typeof r.stages.gateway.promptBuildMs, "number");
  assert.ok(r.stages.gateway.promptBuildMs >= 15,
    `promptBuildMs ${r.stages.gateway.promptBuildMs} should reflect the ~15ms gap between before_prompt_build and model_call_started`);

  // preludeMs is observable (msgReceived -> beforePromptBuild).
  assert.equal(typeof r.stages.gateway.preludeMs, "number");
  assert.ok(r.stages.gateway.preludeMs >= 0);

  // gatewayMs still computed via existing fallback (agentStartAt set by
  // model_call_started when before_agent_run never fired).
  assert.equal(typeof r.stages.gatewayMs, "number");
  assert.ok(r.stages.gatewayMs >= 0);

  // Invariant: when before_agent_run is unsubscribed, agentStartAt ==
  // _modelCallStartedAt, so preludeMs + promptBuildMs ≈ gatewayMs (both end
  // at model_call_started in this fallback path).
  assert.equal(r.stages.gateway.preludeMs + r.stages.gateway.promptBuildMs, r.stages.gatewayMs);

  cleanup(tmp);
});

test("inverted order: model_call_started before before_agent_run -> no negatives", async () => {
  const { tmp, handlers } = await setup();
  const runId = "inv";
  const sessionKey = "agent:foo:d";
  const t0 = Date.now() - 50;

  handlers.message_received({ runId, sessionKey, timestamp: t0 });
  await sleep(5);
  handlers.before_prompt_build({ runId, sessionKey, prompt: "hi", messages: [] });
  await sleep(5);
  // Inverted: model_call_started first
  handlers.model_call_started({ runId, sessionKey, provider: "p", model: "m" });
  await sleep(15);
  handlers.before_agent_run({ runId, sessionKey });
  handlers.model_call_ended({ runId, sessionKey, durationMs: 50, timeToFirstByteMs: 25 });
  handlers.agent_end({ runId, sessionKey });

  const lines = readLines(tmp);
  assert.equal(lines.length, 1);
  const r = lines[0];

  // _modelCallStartedAt < _beforeAgentRunAt -> diff is negative -> clamped to 0
  assert.equal(r.stages.gateway.beforeAgentRunMs, 0);
  // promptBuildMs uses _beforeAgentRunAt - _beforePromptBuildAt; both real, must be >= 0
  assert.ok(r.stages.gateway.promptBuildMs >= 0);
  assert.ok(r.stages.gateway.preludeMs >= 0);

  cleanup(tmp);
});

test("backward compat: gatewayMs == agentStartAt - messageReceivedAt", async () => {
  const { tmp, handlers } = await setup();
  const runId = "compat";
  const sessionKey = "agent:foo:e";
  const t0 = Date.now() - 80;

  handlers.message_received({ runId, sessionKey, timestamp: t0 });
  await sleep(15);
  handlers.before_prompt_build({ runId, sessionKey, prompt: "x", messages: [] });
  await sleep(15);
  handlers.before_agent_run({ runId, sessionKey });
  await sleep(15);
  handlers.model_call_started({ runId, sessionKey, provider: "p", model: "m" });
  handlers.model_call_ended({ runId, sessionKey, durationMs: 50, timeToFirstByteMs: 25 });
  handlers.agent_end({ runId, sessionKey });

  const lines = readLines(tmp);
  const r = lines[0];

  assert.equal(typeof r.stages.gatewayMs, "number");
  assert.equal(typeof r.stages.agentRunMs, "number");
  assert.equal(r.e2eMs, r.stages.gatewayMs + r.stages.agentRunMs);
  // gatewayMs should be ~30ms (pre-msg→prelude 15ms + prompt build 15ms)
  assert.ok(r.stages.gatewayMs >= 30, `gatewayMs ${r.stages.gatewayMs} too low`);
  // Ensure new sub-stage block presence does not corrupt gatewayMs/agentRunMs.
  assert.equal(typeof r.stages.gateway, "object");
  assert.notEqual(r.stages.gateway, null);

  cleanup(tmp);
});

test("eventLoop: structure present; non-null after injected delay", async () => {
  const { tmp, handlers } = await setup();
  const runId = "el-1";
  const sessionKey = "agent:foo:el";

  // Let the global histogram timer start ticking before we block it.
  await sleep(60);

  handlers.message_received({ runId, sessionKey, timestamp: Date.now() });
  // Inject ~120ms of event loop block. Resolution is 20ms, so the histogram
  // timer that was scheduled mid-block will fire late and record a ~120ms
  // delay sample once the loop is unblocked.
  const blockUntil = Date.now() + 120;
  while (Date.now() < blockUntil) { /* busy-block */ }
  // Yield so the histogram registers the block.
  await sleep(60);

  handlers.before_prompt_build({ runId, sessionKey, prompt: "x", messages: [] });
  handlers.before_agent_run({ runId, sessionKey });
  handlers.model_call_started({ runId, sessionKey, provider: "p", model: "m" });
  handlers.model_call_ended({ runId, sessionKey, durationMs: 10, timeToFirstByteMs: 5 });
  handlers.agent_end({ runId, sessionKey });

  const lines = readLines(tmp);
  const r = lines[0];

  assert.ok(r.eventLoop, "eventLoop block missing");
  assert.equal(typeof r.eventLoop.delayP50Ms, "number");
  assert.equal(typeof r.eventLoop.delayP95Ms, "number");
  assert.equal(typeof r.eventLoop.delayP99Ms, "number");
  assert.equal(typeof r.eventLoop.delayMaxMs, "number");
  assert.equal(typeof r.eventLoop.windowMs, "number");
  // Max should reflect the ~120ms block (allow slack for timer resolution).
  assert.ok(r.eventLoop.delayMaxMs >= 80, `delayMaxMs ${r.eventLoop.delayMaxMs} did not capture injected block`);
  assert.ok(r.eventLoop.windowMs > 0);

  cleanup(tmp);
});

test("eventLoop: empty window -> null fields", async () => {
  const { tmp, handlers } = await setup();

  // Run 1 (with awaits) — flush at end resets the histogram.
  const r1 = "el-empty-1";
  const sk = "agent:foo:el2";
  handlers.message_received({ runId: r1, sessionKey: sk, timestamp: Date.now() });
  await sleep(15);
  handlers.before_prompt_build({ runId: r1, sessionKey: sk, prompt: "x", messages: [] });
  handlers.before_agent_run({ runId: r1, sessionKey: sk });
  handlers.model_call_started({ runId: r1, sessionKey: sk, provider: "p", model: "m" });
  handlers.model_call_ended({ runId: r1, sessionKey: sk, durationMs: 5, timeToFirstByteMs: 2 });
  handlers.agent_end({ runId: r1, sessionKey: sk });

  // Run 2 — all synchronous. No event loop iteration between flush 1 and
  // flush 2, so the histogram has count=0 and all eventLoop fields are null.
  const r2 = "el-empty-2";
  const sk2 = "agent:foo:el3";
  const now = Date.now();
  handlers.message_received({ runId: r2, sessionKey: sk2, timestamp: now });
  handlers.before_prompt_build({ runId: r2, sessionKey: sk2, prompt: "x", messages: [] });
  handlers.before_agent_run({ runId: r2, sessionKey: sk2 });
  handlers.model_call_started({ runId: r2, sessionKey: sk2, provider: "p", model: "m" });
  handlers.model_call_ended({ runId: r2, sessionKey: sk2, durationMs: 5, timeToFirstByteMs: 2 });
  handlers.agent_end({ runId: r2, sessionKey: sk2 });

  const lines = readLines(tmp);
  assert.equal(lines.length, 2);
  const second = lines[1];

  assert.equal(second.eventLoop.delayP50Ms, null);
  assert.equal(second.eventLoop.delayP95Ms, null);
  assert.equal(second.eventLoop.delayP99Ms, null);
  assert.equal(second.eventLoop.delayMaxMs, null);
  assert.equal(second.eventLoop.windowMs, null);

  cleanup(tmp);
});
