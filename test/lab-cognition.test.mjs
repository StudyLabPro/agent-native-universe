import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CohortPolicy,
  LlmCognition,
  NeutralCognition,
  RecordedCognition,
  parseCognitiveActions,
} from "../dist/lab/cognition.js";
import { NeutralPolicy } from "../dist/lab/neutral-policy.js";
import {
  DEFAULT_OBJECTIVES,
  analysePopulation,
  crowdingDistances,
  dominates,
  paretoFrontier,
  selectSurvivors,
  toParetoPoints,
} from "../dist/lab/pareto.js";
import { DEFAULT_GENESIS_CONFIG } from "../dist/lab/config.js";
import { runGenesis } from "../dist/lab/genesis.js";
import {
  LAB_COGNITIVE_ENGINE_VERSION,
  LAB_ENGINE_VERSION,
  createRunManifest,
} from "../dist/lab/manifest.js";

/* ------------------------------------------------------------------ */
/* Validation of model output                                          */
/* ------------------------------------------------------------------ */

const request = {
  tick: 3,
  agentId: "N0001",
  agent: { id: "N0001", resources: {}, memory: {} },
  observation: { tick: 3, agentId: "N0001", visibleAgents: ["N0002", "N0003"] },
};

test("a model answer is validated into world actions and never repaired", () => {
  const good = parseCognitiveActions(
    JSON.stringify({ actions: [{ type: "claimTask", taskId: "task:1" }, { type: "observe" }] }),
    request,
  );
  assert.deepEqual(good.actions, [{ type: "claimTask", taskId: "task:1" }, { type: "observe" }]);
  assert.equal(good.rejected, undefined);

  for (const [content, reason] of [
    ["not json", /valid JSON/],
    [JSON.stringify([1, 2]), /JSON object/],
    [JSON.stringify({ actions: "nope" }), /actions array/],
    [JSON.stringify({ actions: [{ type: "becomeValidator" }] }), /unknown action type/],
    [JSON.stringify({ actions: [{ type: "claimTask" }] }), /taskId/],
  ]) {
    const parsed = parseCognitiveActions(content, request);
    assert.deepEqual(parsed.actions, [], `expected no actions for ${content}`);
    assert.match(parsed.rejected, reason);
  }
});

test("an action may not target an agent the actor cannot see", () => {
  const unseen = parseCognitiveActions(
    JSON.stringify({ actions: [{ type: "connect", targetId: "N9999" }] }),
    request,
  );
  assert.deepEqual(unseen.actions, []);
  assert.match(unseen.rejected, /known targetId/);

  const seen = parseCognitiveActions(
    JSON.stringify({ actions: [{ type: "connect", targetId: "N0002" }] }),
    request,
  );
  assert.deepEqual(seen.actions, [{ type: "connect", targetId: "N0002" }]);
});

test("a capability program may not be published through free-form cognition", () => {
  const parsed = parseCognitiveActions(
    JSON.stringify({ actions: [{ type: "publishCapability", capability: { id: "cap://x" } }] }),
    request,
  );
  assert.deepEqual(parsed.actions, []);
  assert.match(parsed.rejected, /publishCapability/);
});

test("resource names must match the world exactly", () => {
  const wrong = parseCognitiveActions(
    JSON.stringify({ actions: [{ type: "reserve", resource: "llm_tokens", amount: 5 }] }),
    request,
  );
  assert.deepEqual(wrong.actions, []);
  const right = parseCognitiveActions(
    JSON.stringify({ actions: [{ type: "reserve", resource: "llmTokens", amount: 5 }] }),
    request,
  );
  assert.deepEqual(right.actions, [{ type: "reserve", resource: "llmTokens", amount: 5 }]);
});

test("at most four actions survive one consultation", () => {
  const many = parseCognitiveActions(
    JSON.stringify({ actions: Array.from({ length: 9 }, () => ({ type: "observe" })) }),
    request,
  );
  assert.equal(many.actions.length, 4);
});

/* ------------------------------------------------------------------ */
/* The synchronous half                                                */
/* ------------------------------------------------------------------ */

test("an agent the model did not steer falls back to the neutral policy", () => {
  const neutral = new NeutralPolicy();
  const policy = new CohortPolicy("C", neutral);
  const observation = { tick: 1, agentId: "N0002", tasks: [], submissions: [], inbox: [], visibleAgents: [], neighbors: [], capabilities: [] };
  const agent = { id: "N0002", active: true, memory: {}, learning: { attempts: {}, successes: {}, utilityPpm: {} } };
  const rng = { nextInt: () => 0, fork() { return this; } };

  policy.load([{
    tick: 1,
    agentId: "N0001",
    cohort: "C",
    provider: "p",
    model: "m",
    content: "{}",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    latencyMs: 0,
    actions: [{ type: "observe" }],
  }]);

  // The steered agent gets exactly what the model asked for.
  assert.deepEqual(policy.decide({ ...observation, agentId: "N0001" }, { ...agent, id: "N0001" }, rng), [
    { type: "observe" },
  ]);
  // The unsteered one is decided by the control policy, not stalled.
  assert.deepEqual(
    policy.decide(observation, agent, rng),
    neutral.decide(observation, agent, rng),
  );
});

test("recorded cognition replays without contacting a provider", async () => {
  const record = {
    tick: 7,
    agentId: "N0001",
    cohort: "C",
    provider: "p",
    model: "m",
    content: "{}",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    latencyMs: 5,
    actions: [{ type: "observe" }],
  };
  const recorded = new RecordedCognition("C", [record]);
  assert.deepEqual(await recorded.propose([{ tick: 7, agentId: "N0001" }]), [record]);
  assert.deepEqual(await recorded.propose([{ tick: 8, agentId: "N0001" }]), []);
});

test("a provider failure is recorded as evidence instead of ending the tick", async () => {
  const cognition = new LlmCognition({
    cohort: "C",
    model: "scripted-1@test",
    agentsPerTick: 1,
    completion: { async complete() { throw new Error("provider exploded"); } },
  });
  const [record] = await cognition.propose([request]);
  assert.deepEqual(record.actions, []);
  assert.match(record.rejected, /provider failure/);
  assert.equal(record.provider, "unavailable");
});

test("cohort A consults nothing", async () => {
  assert.deepEqual(await new NeutralCognition().propose([request]), []);
});

/* ------------------------------------------------------------------ */
/* Pareto                                                              */
/* ------------------------------------------------------------------ */

function runOf(universeId, overrides) {
  return {
    universeId,
    runId: `run-${universeId}`,
    latestMetrics: {
      taskSuccessRatePpm: 0,
      meanQualityPpm: 0,
      creditsPerAcceptedTaskPpm: 0,
      p95LatencyTicks: 0,
      violations: 0,
      activeAgents: 0,
      ...overrides,
    },
  };
}

test("dominance requires being no worse everywhere and better somewhere", () => {
  assert.equal(dominates([2, 2], [1, 1]), true);
  assert.equal(dominates([2, 1], [1, 1]), true);
  assert.equal(dominates([1, 1], [1, 1]), false, "an equal point must not dominate");
  assert.equal(dominates([2, 0], [1, 1]), false, "a trade-off is not dominance");
});

test("a trade-off keeps every architecture on the frontier", () => {
  // Cheap and mediocre, expensive and excellent, and one in between: none of
  // these is worse than another, so all three must survive.
  const runs = [
    runOf("U0001", { meanQualityPpm: 910_000, creditsPerAcceptedTaskPpm: 440_000 }),
    runOf("U0002", { meanQualityPpm: 880_000, creditsPerAcceptedTaskPpm: 210_000 }),
    runOf("U0003", { meanQualityPpm: 950_000, creditsPerAcceptedTaskPpm: 810_000 }),
  ];
  const frontier = paretoFrontier(toParetoPoints(runs));
  assert.deepEqual(frontier.map((point) => point.universeId), ["U0001", "U0002", "U0003"]);
});

test("a universe worse on every objective is ranked behind the frontier", () => {
  const runs = [
    runOf("U0001", { meanQualityPpm: 900_000, activeAgents: 16 }),
    runOf("U0002", { meanQualityPpm: 500_000, activeAgents: 8, violations: 40 }),
  ];
  const analysis = analysePopulation(runs);
  assert.deepEqual(analysis.frontier, ["U0001"]);
  const ranks = new Map(analysis.entries.map((entry) => [entry.universeId, entry.rank]));
  assert.equal(ranks.get("U0001"), 0);
  assert.equal(ranks.get("U0002"), 1);
});

test("selection prefers rank, then isolation, and is deterministic", () => {
  const runs = [
    runOf("U0001", { meanQualityPpm: 900_000, creditsPerAcceptedTaskPpm: 100_000 }),
    runOf("U0002", { meanQualityPpm: 500_000, creditsPerAcceptedTaskPpm: 50_000 }),
    runOf("U0003", { meanQualityPpm: 700_000, creditsPerAcceptedTaskPpm: 70_000 }),
    runOf("U0004", { meanQualityPpm: 100_000, creditsPerAcceptedTaskPpm: 900_000 }),
  ];
  const analysis = analysePopulation(runs);
  const survivors = selectSurvivors(analysis, 2);
  assert.equal(survivors.length, 2);
  assert.deepEqual(survivors, selectSurvivors(analysePopulation(runs), 2), "selection must be reproducible");
  assert.equal(survivors.includes("U0004"), false, "a dominated universe must not be selected first");
});

test("the objective list is explicit about direction", () => {
  const analysis = analysePopulation([runOf("U0001", {})]);
  assert.equal(analysis.objectives.length, DEFAULT_OBJECTIVES.length);
  assert.deepEqual(
    analysis.objectives.find((objective) => objective.key === "creditsPerAcceptedTaskPpm"),
    { key: "creditsPerAcceptedTaskPpm", direction: "minimize" },
  );
});

/* ------------------------------------------------------------------ */
/* End to end                                                          */
/* ------------------------------------------------------------------ */

test("a cognitive run takes its own engine identity and replays exactly", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-cohort-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  // A scripted provider: no network, but the same path a real one travels.
  const completion = {
    async complete() {
      return {
        provider: "scripted",
        model: "scripted-1",
        content: JSON.stringify({ actions: [{ type: "observe" }] }),
        usage: { inputTokens: 4, outputTokens: 4, totalTokens: 8 },
        latencyMs: 1,
      };
    },
  };
  const config = { ...DEFAULT_GENESIS_CONFIG, ticks: 3, agents: 4, metricEvery: 1, checkpointEvery: 3 };
  const summary = await runGenesis({
    config,
    runsRoot: directory,
    universeId: "U0001",
    cognition: new LlmCognition({ cohort: "C", model: "scripted-1@test", completion, agentsPerTick: 2 }),
  });

  // runGenesis replays the whole stream and protocol-verifies it before
  // returning, so reaching this line is the reproducibility assertion.
  assert.equal(summary.ticks, 3);
  assert.ok(summary.finalEventHash.length === 64);

  const manifestPath = join(directory, "genesis-1", "U0001", summary.runId, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.mode, "cognitive");
  assert.equal(manifest.engineVersion, LAB_COGNITIVE_ENGINE_VERSION);
  assert.notEqual(manifest.engineVersion, LAB_ENGINE_VERSION);
  assert.match(manifest.policyId, /^cohort-c-/);
  assert.match(manifest.cognitionId, /^cognition-llm-c-v1:scripted-1@test:apt2:mt2048$/);

  // The consulted model is part of the run identity: the same cohort against
  // a different model must get its own runId instead of silently recovering
  // this run's completed evidence.
  const other = await runGenesis({
    config,
    runsRoot: directory,
    universeId: "U0001",
    cognition: new LlmCognition({ cohort: "C", model: "scripted-2@test", completion, agentsPerTick: 2 }),
  });
  assert.notEqual(other.runId, summary.runId);
});

test("a logical run refuses a cognition port and a cognitive run requires one", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-cohort-guard-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { ...DEFAULT_GENESIS_CONFIG, ticks: 1, agents: 2, metricEvery: 1, checkpointEvery: 1 };
  // Cohort A supplies no port, so the run must stay logical.
  const summary = await runGenesis({ config, runsRoot: directory, universeId: "U0002" });
  const manifestPath = join(directory, "genesis-1", "U0002", summary.runId, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.mode, "logical");
  assert.equal(manifest.engineVersion, LAB_ENGINE_VERSION);
});

test("a cognitive manifest binds the consulted model, a logical one refuses it", () => {
  const config = { ...DEFAULT_GENESIS_CONFIG, ticks: 1, agents: 2, metricEvery: 1, checkpointEvery: 1 };
  assert.throws(
    () => createRunManifest(config, "U0001", { policyId: "cohort-c-neutral-backpressure-v1", mode: "cognitive" }),
    /Cognition id/,
    "a cognitive run without a cognition identity must be refused",
  );
  assert.throws(
    () => createRunManifest(config, "U0001", { cognitionId: "cognition-llm-c-v1:m@h:apt2:mt64" }),
    /logical run manifest must not carry/,
    "a logical run claiming a cognition identity must be refused",
  );
  const manifest = createRunManifest(config, "U0001", {
    policyId: "cohort-c-neutral-backpressure-v1",
    mode: "cognitive",
    cognitionId: "cognition-llm-c-v1:m@h:apt2:mt64",
  });
  const otherModel = createRunManifest(config, "U0001", {
    policyId: "cohort-c-neutral-backpressure-v1",
    mode: "cognitive",
    cognitionId: "cognition-llm-c-v1:other@h:apt2:mt64",
  });
  assert.notEqual(manifest.runId, otherModel.runId, "different models must never share a run identity");
});

test("a flat objective axis grants nobody infinite crowding", () => {
  // Three points: axis 0 is constant, axis 1 varies. Only axis 1 may crown
  // boundary points; axis 0 must stay silent instead of electing the lowest
  // and highest universe ids by name.
  const layer = [
    { universeId: "U0001", runId: "r1", values: [5, 10] },
    { universeId: "U0002", runId: "r2", values: [5, 20] },
    { universeId: "U0003", runId: "r3", values: [5, 30] },
  ];
  const distances = crowdingDistances(layer);
  assert.equal(distances.get("U0001"), Number.MAX_SAFE_INTEGER);
  assert.equal(distances.get("U0003"), Number.MAX_SAFE_INTEGER);
  assert.notEqual(distances.get("U0002"), Number.MAX_SAFE_INTEGER);

  // With every axis flat there is no diversity information at all: everyone
  // keeps zero, and survival falls through to rank and stable ordering.
  const flat = [
    { universeId: "U0001", runId: "r1", values: [5, 10] },
    { universeId: "U0002", runId: "r2", values: [5, 10] },
    { universeId: "U0003", runId: "r3", values: [5, 10] },
  ];
  for (const distance of crowdingDistances(flat).values()) assert.equal(distance, 0);
});
