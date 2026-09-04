import test from "node:test";
import assert from "node:assert/strict";

import {
  LiveCognition,
  LIVE_COGNITION_SYSTEM_PROMPT,
  LIVE_OBSERVATION_BUDGET,
  computeLiveCognitionId,
  computePromptId,
  expectedTier,
} from "../dist/lab/live/live-cognition.js";
import {
  LiveIdlePolicy,
  createLiveIdlePolicy,
  isLiveIdlePolicyId,
} from "../dist/lab/live/live-idle-policy.js";
import { CohortPolicy } from "../dist/lab/cognition.js";
import { LAB_LIVE_POLICY_ID, LAB_LIVE_POLICY_PATTERN, createRunManifest } from "../dist/lab/manifest.js";
import { DEFAULT_GENESIS_CONFIG } from "../dist/lab/config.js";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeTiers(overrides = {}) {
  const base = {
    fast: { model: "gpt-oss-120b", maxTokens: 512, timeoutMs: 5_000, concurrency: 8, pricePpm: 1_000_000 },
    standard: { model: "qwen3-6-35b-a3b", maxTokens: 2_048, timeoutMs: 15_000, concurrency: 4, pricePpm: 3_000_000 },
    deliberate: { model: "kimi-k2-6", maxTokens: 4_096, timeoutMs: 60_000, concurrency: 4, pricePpm: 8_000_000 },
  };
  return {
    fast: { ...base.fast, ...(overrides.fast ?? {}) },
    standard: { ...base.standard, ...(overrides.standard ?? {}) },
    deliberate: { ...base.deliberate, ...(overrides.deliberate ?? {}) },
  };
}

function baseObservation(tick, agentId, extra = {}) {
  return {
    tick,
    agentId,
    resources: { credits: 0, llmTokens: 1_000_000, computeMs: 0, storageBytes: 0, bandwidthBytes: 0 },
    tasks: [],
    submissions: [],
    inbox: [],
    visibleAgents: [],
    neighbors: [],
    capabilities: [],
    physics: { resourcePricePpm: { credits: 0, llmTokens: 0, computeMs: 0, storageBytes: 0, bandwidthBytes: 0 }, bandwidthCapacityPpm: 1_000_000, taskLoadPpm: 0 },
    ...extra,
  };
}

function makeRequest(tick, agentId, observationExtra = {}, resources) {
  const observation = baseObservation(tick, agentId, observationExtra);
  return {
    tick,
    agentId,
    observation,
    agent: {
      id: agentId,
      resources: resources ?? observation.resources,
      memory: {},
    },
  };
}

function scriptedResponse(content, extra = {}) {
  return {
    provider: "scripted",
    model: "scripted-model",
    content,
    usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    latencyMs: 1,
    reasoningTokens: 5,
    ...extra,
  };
}

function gatewayHttpError(status, reason) {
  return new Error(`live-gateway returned HTTP ${status}: {"error":"${reason}"}`);
}

/* ------------------------------------------------------------------ */
/* Port identity                                                       */
/* ------------------------------------------------------------------ */

test("the port id is stable for an identical spec and changes with tiers, gateway identity or content budget", () => {
  const completion = { async complete() { return scriptedResponse('{"actions":[]}'); } };
  const options = { completion, tiers: makeTiers(), gatewayIdentity: "gateway-v1-test" };

  const a = new LiveCognition(options);
  const b = new LiveCognition({ ...options, tiers: makeTiers() });
  assert.equal(a.id, b.id, "identical tier/prompt/budget specs must share an id");
  assert.match(a.id, /^cognition-live-v1:[0-9a-f]{24}:cb65536$/);

  const differentModel = new LiveCognition({
    ...options,
    tiers: makeTiers({ fast: { model: "a-different-model" } }),
  });
  assert.notEqual(differentModel.id, a.id, "a different tier model must change the id");

  const differentPrice = new LiveCognition({
    ...options,
    tiers: makeTiers({ standard: { pricePpm: 5_000_000 } }),
  });
  assert.notEqual(differentPrice.id, a.id, "a different tier price must change the id");

  const differentGateway = new LiveCognition({ ...options, gatewayIdentity: "gateway-v1-other" });
  assert.notEqual(differentGateway.id, a.id, "a different gateway identity must change the id");

  const differentBudget = new LiveCognition({ ...options, contentByteBudget: 4_096 });
  assert.notEqual(differentBudget.id, a.id, "a different content byte budget must change the id");
  assert.match(differentBudget.id, /:cb4096$/);

  const differentOverrides = new LiveCognition({
    ...options,
    tiers: makeTiers({ fast: { requestOverrides: { reasoning_effort: "low" } } }),
  });
  assert.notEqual(differentOverrides.id, a.id, "request overrides must be hashed into the id");
});

test("computePromptId changes with the prompt text or the observation budget", () => {
  const baseline = computePromptId(LIVE_COGNITION_SYSTEM_PROMPT, LIVE_OBSERVATION_BUDGET);
  assert.equal(computePromptId(LIVE_COGNITION_SYSTEM_PROMPT, LIVE_OBSERVATION_BUDGET), baseline);
  assert.notEqual(computePromptId(`${LIVE_COGNITION_SYSTEM_PROMPT}\nextra`, LIVE_OBSERVATION_BUDGET), baseline);
  assert.notEqual(
    computePromptId(LIVE_COGNITION_SYSTEM_PROMPT, { ...LIVE_OBSERVATION_BUDGET, maxTasks: 32 }),
    baseline,
  );
});

test("computeLiveCognitionId is a pure function of its input", () => {
  const input = {
    tiers: makeTiers(),
    promptId: computePromptId(LIVE_COGNITION_SYSTEM_PROMPT, LIVE_OBSERVATION_BUDGET),
    gatewayIdentity: "gateway-v1-test",
    contentByteBudget: 65_536,
  };
  assert.equal(computeLiveCognitionId(input), computeLiveCognitionId(structuredClone(input)));
  assert.notEqual(
    computeLiveCognitionId(input),
    computeLiveCognitionId({ ...input, gatewayIdentity: "gateway-v1-other" }),
  );
});

/* ------------------------------------------------------------------ */
/* expectedTier — pure truth table                                     */
/* ------------------------------------------------------------------ */

test("expectedTier: affordable, downgraded, and starved", () => {
  const prices = { fast: 10, standard: 30, deliberate: 80 };

  assert.equal(expectedTier("deliberate", 100, prices), "deliberate", "affordable at the requested tier");
  assert.equal(expectedTier("deliberate", 80, prices), "deliberate", "affordable at exactly the price");
  assert.equal(expectedTier("deliberate", 50, prices), "standard", "downgraded past deliberate");
  assert.equal(expectedTier("standard", 20, prices), "fast", "downgraded past standard");
  assert.equal(expectedTier("fast", 100, prices), "fast", "already the cheapest, still affordable");
  assert.equal(expectedTier("deliberate", 9, prices), "starved", "unaffordable at every tier");
  assert.equal(expectedTier("fast", 9, prices), "starved", "unaffordable even at the cheapest tier");
  assert.equal(expectedTier("standard", 30, prices), "standard", "affordable at exactly the requested tier's price");
});

/* ------------------------------------------------------------------ */
/* propose(): concurrency, volume, tier/reasoningTokens on every record */
/* ------------------------------------------------------------------ */

test("32 agents over 5 ticks yield 160 records, every one carrying tier and reasoningTokens", async () => {
  const completion = {
    async complete() {
      return scriptedResponse(JSON.stringify({ actions: [{ type: "observe" }], nextTier: "fast" }));
    },
  };
  const cognition = new LiveCognition({ completion, tiers: makeTiers(), gatewayIdentity: "gateway-v1-test" });

  const agentIds = Array.from({ length: 32 }, (_, index) => `N${String(index + 1).padStart(4, "0")}`);
  const allRecords = [];
  for (let tick = 1; tick <= 5; tick += 1) {
    const requests = agentIds.map((agentId) => makeRequest(tick, agentId));
    const records = await cognition.propose(requests);
    assert.equal(records.length, 32, `tick ${tick} must consult every agent`);
    allRecords.push(...records);
  }

  assert.equal(allRecords.length, 160);
  for (const record of allRecords) {
    assert.equal(record.cohort, "C");
    assert.ok(["fast", "standard", "deliberate"].includes(record.tier), "every record carries its tier");
    assert.equal(record.reasoningTokens, 5, "every record carries the provider's reasoning token count");
    assert.notEqual(record.provider, "unavailable");
  }
});

/* ------------------------------------------------------------------ */
/* Never throws: a provider exception for every agent                  */
/* ------------------------------------------------------------------ */

test("a provider exception for every agent in a tick yields unavailable records, never a throw", async () => {
  const completion = { async complete() { throw new Error("provider exploded"); } };
  const cognition = new LiveCognition({
    completion,
    tiers: makeTiers(),
    gatewayIdentity: "gateway-v1-test",
    retryBackoffMs: 1,
  });

  const agentIds = Array.from({ length: 32 }, (_, index) => `N${String(index + 1).padStart(4, "0")}`);
  const requests = agentIds.map((agentId) => makeRequest(1, agentId));

  const records = await cognition.propose(requests);
  assert.equal(records.length, 32);
  for (const record of records) {
    assert.equal(record.provider, "unavailable");
    assert.equal(record.model, "unavailable");
    assert.deepEqual(record.actions, []);
    assert.match(record.rejected, /provider failure/);
    assert.ok(["fast", "standard", "deliberate"].includes(record.tier));
  }
});

/* ------------------------------------------------------------------ */
/* 429 too_many_in_flight retried twice, then a success                */
/* ------------------------------------------------------------------ */

test("a 429 too_many_in_flight error is retried twice before giving up, and succeeds on the third attempt", async () => {
  let calls = 0;
  const completion = {
    async complete() {
      calls += 1;
      if (calls <= 2) throw gatewayHttpError(429, "too_many_in_flight");
      return scriptedResponse(JSON.stringify({ actions: [{ type: "observe" }], nextTier: "fast" }));
    },
  };
  const cognition = new LiveCognition({
    completion,
    tiers: makeTiers(),
    gatewayIdentity: "gateway-v1-test",
    retryBackoffMs: 1,
  });

  const records = await cognition.propose([makeRequest(1, "N0001")]);
  assert.equal(calls, 3, "two retries plus the succeeding attempt");
  assert.equal(records.length, 1);
  assert.notEqual(records[0].provider, "unavailable");
  assert.equal(records[0].nextTier, "fast");
});

test("a non-retryable error is not retried", async () => {
  let calls = 0;
  const completion = {
    async complete() {
      calls += 1;
      throw new Error("live-gateway returned HTTP 500: internal error");
    },
  };
  const cognition = new LiveCognition({
    completion,
    tiers: makeTiers(),
    gatewayIdentity: "gateway-v1-test",
    retryBackoffMs: 1,
  });
  const [record] = await cognition.propose([makeRequest(1, "N0001")]);
  assert.equal(calls, 1, "a non-429 failure must not be retried");
  assert.equal(record.provider, "unavailable");
});

/* ------------------------------------------------------------------ */
/* Starvation: no LLM call at all                                      */
/* ------------------------------------------------------------------ */

test("a starved agent gets no consultation and no record", async () => {
  let calls = 0;
  const completion = {
    async complete() {
      calls += 1;
      return scriptedResponse(JSON.stringify({ actions: [], nextTier: "fast" }));
    },
  };
  const cognition = new LiveCognition({ completion, tiers: makeTiers(), gatewayIdentity: "gateway-v1-test" });
  const poor = makeRequest(1, "N0001", {}, { credits: 0, llmTokens: 0, computeMs: 0, storageBytes: 0, bandwidthBytes: 0 });
  const records = await cognition.propose([poor]);
  assert.equal(records.length, 0, "a starved agent produces no record at all");
  assert.equal(calls, 0, "a starved agent is never sent to the provider");
});

/* ------------------------------------------------------------------ */
/* Observation budget: bounded prompt bytes regardless of population   */
/* ------------------------------------------------------------------ */

test("the serialized observation stays under 24 KiB with maxBacklog=2048 and 10,000 visible agents", async () => {
  let capturedContent;
  const completion = {
    async complete(request) {
      capturedContent = request.messages[1].content;
      return scriptedResponse(JSON.stringify({ actions: [], nextTier: "fast" }));
    },
  };
  const cognition = new LiveCognition({ completion, tiers: makeTiers(), gatewayIdentity: "gateway-v1-test" });

  const maxBacklog = 2_048;
  const visibleAgents = Array.from({ length: 10_000 }, (_, index) => `N${String(index + 1).padStart(6, "0")}`);
  const tasks = Array.from({ length: Math.min(maxBacklog, 500) }, (_, index) => ({
    id: `task:${index}`,
    family: "arithmetic",
    input: { operation: "add", left: index, right: 1 },
    createdTick: 0,
    deadlineTick: 1_000 + index,
    status: index % 7 === 0 ? "claimed" : "available",
    ...(index % 7 === 0 ? { claimedBy: "N0001" } : {}),
  }));
  const submissions = Array.from({ length: 64 }, (_, index) => ({
    id: `submission:${index}`,
    taskId: `task:${index}`,
    agentId: `N${String(index + 2).padStart(6, "0")}`,
    result: index,
    submittedTick: 1,
    task: tasks[index % tasks.length],
  }));
  const inbox = Array.from({ length: 64 }, (_, index) => ({
    id: `message:${index}`,
    senderId: `N${String(index + 2).padStart(6, "0")}`,
    recipientId: "N0001",
    payload: { tick: 1, signal: "available" },
    sentTick: 1,
    deliveredTick: 1,
    redactedPaths: [],
  }));
  const neighbors = visibleAgents.slice(0, 10);
  const capabilities = Array.from({ length: 20 }, (_, index) => ({
    id: `capability:${index}`,
    ownerId: "N0002",
    inputs: ["a"],
    outputs: ["b"],
    tests: [{ a: 1 }],
    cost: { credits: 1, llmTokens: 0, computeMs: 0, storageBytes: 0, bandwidthBytes: 0 },
  }));

  const request = makeRequest(1, "N0001", { visibleAgents, tasks, submissions, inbox, neighbors, capabilities });
  await cognition.propose([request]);

  assert.ok(capturedContent !== undefined, "the fake provider must have been consulted");
  const bytes = Buffer.byteLength(capturedContent, "utf8");
  assert.ok(bytes <= 24 * 1024, `serialized observation must stay within 24 KiB, was ${bytes} bytes`);

  const parsed = JSON.parse(capturedContent);
  assert.ok(parsed.tasks.length <= LIVE_OBSERVATION_BUDGET.maxTasks);
  assert.ok(parsed.submissions.length <= LIVE_OBSERVATION_BUDGET.maxSubmissions);
  assert.ok(parsed.inbox.length <= LIVE_OBSERVATION_BUDGET.maxInbox);
  assert.ok(parsed.visibleAgentsSample.length <= LIVE_OBSERVATION_BUDGET.maxVisibleAgentsSample);
  assert.ok(parsed.capabilities.length <= LIVE_OBSERVATION_BUDGET.maxCapabilities);
  assert.equal(parsed.visibleAgentsCount, 10_000);
});

/* ------------------------------------------------------------------ */
/* LiveIdlePolicy: gated construction, never a code-solved fallback    */
/* ------------------------------------------------------------------ */

test("LiveIdlePolicy is refused outside mode live and never falls through to a computed answer", () => {
  assert.throws(() => createLiveIdlePolicy("logical"), /reserved for mode live/);
  assert.throws(() => createLiveIdlePolicy("cognitive"), /reserved for mode live/);
  const live = createLiveIdlePolicy("live");
  assert.ok(live instanceof LiveIdlePolicy);
  assert.equal(live.id, LAB_LIVE_POLICY_ID);
  assert.ok(isLiveIdlePolicyId(live.id));
  assert.ok(!isLiveIdlePolicyId("cohort-c-neutral-backpressure-v1"));

  const observation = { tick: 1, agentId: "N0002", tasks: [], submissions: [], inbox: [], visibleAgents: [], neighbors: [], capabilities: [] };
  const agent = { id: "N0002", active: true, memory: {}, learning: { attempts: {}, successes: {}, utilityPpm: {} } };
  const rng = { nextInt: () => 0, fork() { return this; } };
  assert.deepEqual(live.decide(observation, agent, rng), [], "idle policy never returns a computed action");
});

test("LiveIdlePolicy checkpoint/restore round-trips and rejects a foreign or non-trivial checkpoint", () => {
  const policy = new LiveIdlePolicy();
  const checkpoint = policy.checkpoint();
  assert.deepEqual(checkpoint, { policyId: LAB_LIVE_POLICY_ID, explorationPpm: 0, streams: [] });

  const restored = new LiveIdlePolicy();
  assert.doesNotThrow(() => restored.restore(checkpoint, { nextInt: () => 0, fork() { return this; } }));

  assert.throws(
    () => restored.restore({ policyId: "cohort-c-neutral-backpressure-v1", explorationPpm: 0, streams: [] }, {}),
    /checkpoint belongs to/,
  );
  assert.throws(
    () => restored.restore({ policyId: LAB_LIVE_POLICY_ID, explorationPpm: 0, streams: [{ agentId: "N0001", rng: {} }] }, {}),
    /must not carry RNG streams/,
  );
});

test("an unsteered agent under CohortPolicy(C, LiveIdlePolicy) does nothing — the critical honesty property", () => {
  const policy = new CohortPolicy("C", new LiveIdlePolicy());
  const observation = { tick: 1, agentId: "N0002", tasks: [{ id: "task:1", family: "arithmetic", input: { operation: "add", left: 1, right: 1 }, createdTick: 0, deadlineTick: 10, status: "available" }], submissions: [], inbox: [], visibleAgents: [], neighbors: [], capabilities: [] };
  const agent = { id: "N0002", active: true, memory: {}, learning: { attempts: {}, successes: {}, utilityPpm: {} } };
  const rng = { nextInt: () => 0, fork() { return this; } };

  // No cognition.recorded for this agent this tick: a live agent must do
  // NOTHING, never fall through to a code-computed answer such as
  // NeutralPolicy would produce for the very same observation (it would
  // claim the available task).
  policy.load([]);
  assert.deepEqual(policy.decide(observation, agent, rng), []);

  // A steered agent still gets exactly what the model asked for.
  policy.load([{
    tick: 1, agentId: "N0001", cohort: "C", provider: "p", model: "m", content: "{}",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, latencyMs: 0,
    actions: [{ type: "observe" }], tier: "fast",
  }]);
  assert.deepEqual(
    policy.decide({ ...observation, agentId: "N0001" }, { ...agent, id: "N0001" }, rng),
    [{ type: "observe" }],
  );
});

test("a manifest requires the live idle policy id exactly under mode live, and refuses it elsewhere", () => {
  const liveConfig = {
    ...structuredClone(DEFAULT_GENESIS_CONFIG),
    experimentId: "genesis-live",
    live: {
      epochTicks: 500,
      tiers: { fast: { pricePpm: 1_000_000 }, standard: { pricePpm: 3_000_000 }, deliberate: { pricePpm: 8_000_000 } },
      exhaustion: { minThinkTokens: 1_000, graceTicks: 10 },
      archive: { taskTicks: 200, messageTicks: 200, submissionTicks: 200 },
      fsyncEveryTick: true,
    },
  };
  const manifest = createRunManifest(liveConfig, "U0001", {
    mode: "live",
    policyId: createLiveIdlePolicy("live").id,
    cognitionId: "cognition-live-v1:test:cb65536",
  });
  assert.equal(manifest.policyId, LAB_LIVE_POLICY_ID);
  assert.ok(LAB_LIVE_POLICY_PATTERN.test(manifest.policyId));

  assert.throws(
    () => createRunManifest(DEFAULT_GENESIS_CONFIG, "U0001", {
      mode: "cognitive",
      policyId: LAB_LIVE_POLICY_ID,
      cognitionId: "cognition-llm-c-v1:m@h:apt4:mt2048",
    }),
    /reserved for mode live/,
  );
});
