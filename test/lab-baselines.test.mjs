import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CentralDispatchPolicy,
  FixedRolesPolicy,
  NoLinkAdaptationPolicy,
  createLogicalPolicyById,
  zeroCostConfig,
} from "../dist/lab/baselines.js";
import { DEFAULT_GENESIS_CONFIG, validateGenesisConfig } from "../dist/lab/config.js";
import { runGenesis } from "../dist/lab/genesis.js";
import {
  BASELINE_CENTRAL_DISPATCH_ID,
  BASELINE_FIXED_ROLES_ID,
  BASELINE_NO_LINKS_ID,
  LAB_POLICY_ID,
  assertLabManifestImplementation,
  createRunManifest,
} from "../dist/lab/manifest.js";
import { NeutralPolicy } from "../dist/lab/neutral-policy.js";
import { hashValue } from "../dist/lab/canonical.js";
import { runLabCli } from "../dist/lab/runner.js";

const SMALL = { ...DEFAULT_GENESIS_CONFIG, ticks: 30, agents: 8, metricEvery: 10, checkpointEvery: 30 };

function capture() {
  const out = [];
  const err = [];
  const last = (lines) => JSON.parse(lines.join("").trim().split("\n").pop());
  return {
    io: {
      stdout: { write: (line) => (out.push(String(line)), true) },
      stderr: { write: (line) => (err.push(String(line)), true) },
    },
    // Usage failures go to stderr, results to stdout.
    json: () => (out.length > 0 ? last(out) : last(err)),
  };
}

async function readEvents(root, universeId, runId) {
  return readFile(join(root, "genesis-1", universeId, runId, "events.jsonl"), "utf8");
}

/* ------------------------------------------------------------------ */
/* Identity registry                                                   */
/* ------------------------------------------------------------------ */

test("the registry instantiates exactly the manifest-bound policies", () => {
  assert.ok(createLogicalPolicyById(LAB_POLICY_ID) instanceof NeutralPolicy);
  assert.ok(createLogicalPolicyById(BASELINE_CENTRAL_DISPATCH_ID) instanceof CentralDispatchPolicy);
  assert.ok(createLogicalPolicyById(BASELINE_FIXED_ROLES_ID) instanceof FixedRolesPolicy);
  assert.ok(createLogicalPolicyById(BASELINE_NO_LINKS_ID) instanceof NoLinkAdaptationPolicy);
  assert.throws(() => createLogicalPolicyById("baseline-invented-v1"), /Unknown logical policy/);
});

test("a baseline manifest validates and an unknown logical policy is refused", () => {
  const manifest = createRunManifest(SMALL, "U0001", { policyId: BASELINE_FIXED_ROLES_ID });
  assertLabManifestImplementation(manifest);
  assert.equal(manifest.mode, "logical");
  assert.throws(
    () => assertLabManifestImplementation({ ...manifest, policyId: "baseline-invented-v1" }),
    /Unsupported lab policyId/,
  );
});

test("baseline run ids never collide with the neutral run on the same seed", () => {
  const neutral = createRunManifest(SMALL, "U0001");
  const ids = new Set([neutral.runId]);
  for (const policyId of [BASELINE_CENTRAL_DISPATCH_ID, BASELINE_FIXED_ROLES_ID, BASELINE_NO_LINKS_ID]) {
    ids.add(createRunManifest(SMALL, "U0001", { policyId }).runId);
  }
  assert.equal(ids.size, 4);
});

/* ------------------------------------------------------------------ */
/* Arm C — the economy ablation                                        */
/* ------------------------------------------------------------------ */

test("zeroCostConfig frees every action, stays valid and changes the config identity", () => {
  const free = zeroCostConfig(SMALL);
  validateGenesisConfig(free);
  for (const cost of Object.values(free.costs)) {
    assert.deepEqual(cost, { credits: 0, llmTokens: 0, computeMs: 0, storageBytes: 0, bandwidthBytes: 0 });
  }
  assert.notEqual(hashValue(free), hashValue(SMALL));
  // The ablation removes prices, not the rest of the physics.
  assert.deepEqual(free.acceptedTaskReward, SMALL.acceptedTaskReward);
  assert.deepEqual(free.initialResources, SMALL.initialResources);
});

/* ------------------------------------------------------------------ */
/* Baseline runs produce first-grade evidence                          */
/* ------------------------------------------------------------------ */

test("a central-dispatch run completes, replays, forms no links and repeats exactly", async (t) => {
  const left = await mkdtemp(join(tmpdir(), "anu-bl-e1-"));
  const right = await mkdtemp(join(tmpdir(), "anu-bl-e2-"));
  t.after(() => Promise.all([rm(left, { recursive: true, force: true }), rm(right, { recursive: true, force: true })]));

  // runGenesis replays the stream and protocol-verifies it before returning,
  // so completion is itself the verification assertion.
  const first = await runGenesis({
    config: SMALL, runsRoot: left, universeId: "U0001", policy: new CentralDispatchPolicy(),
  });
  const second = await runGenesis({
    config: SMALL, runsRoot: right, universeId: "U0001", policy: new CentralDispatchPolicy(),
  });
  assert.equal(first.finalEventHash, second.finalEventHash, "a designed architecture must be exactly reproducible");
  assert.equal(first.latestMetrics.activeLinks, 0, "a central dispatcher needs no relationships");
  assert.equal(first.latestMetrics.violations, 0, "race-free dispatch must produce no violations");
  assert.ok(first.latestMetrics.tasksCompleted > 0);

  const events = await readEvents(left, "U0001", first.runId);
  assert.equal(events.includes('"type":"link.created"'), false);
});

test("fixed roles separate strictly: verifiers verify, solvers solve, nobody crosses", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-bl-f-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const summary = await runGenesis({
    config: SMALL, runsRoot: directory, universeId: "U0001", policy: new FixedRolesPolicy(),
  });
  const events = await readEvents(directory, "U0001", summary.runId);
  const lines = events.trim().split("\n").map((line) => JSON.parse(line));

  // Roster N0001..N0008 sorted: verifiers sit at indices 3 and 7.
  const verifiers = new Set(["N0004", "N0008"]);
  const verified = lines.filter((event) => event.type === "submission.verified");
  const claimed = lines.filter((event) => event.type === "task.claimed");
  assert.ok(verified.length > 0, "the verifier role must actually verify");
  for (const event of verified) assert.ok(verifiers.has(event.actorId), `${event.actorId} verified without the role`);
  for (const event of claimed) assert.ok(!verifiers.has(event.data.agentId), `${event.data.agentId} claimed despite the role`);
  assert.equal(summary.latestMetrics.violations, 0);
});

test("the no-links ablation suppresses every topology action and still completes work", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-bl-d-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const summary = await runGenesis({
    config: SMALL, runsRoot: directory, universeId: "U0001", policy: new NoLinkAdaptationPolicy(),
  });
  assert.equal(summary.latestMetrics.activeLinks, 0);
  assert.ok(summary.latestMetrics.tasksCompleted > 0);
  const events = await readEvents(directory, "U0001", summary.runId);
  for (const type of ["link.created", "link.removed", "message.sent"]) {
    assert.equal(events.includes(`"type":"${type}"`), false, `${type} must never appear without links`);
  }
});

test("a run takes either a baseline policy or a cognition port, never both", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-bl-guard-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    runGenesis({
      config: SMALL,
      runsRoot: directory,
      universeId: "U0001",
      policy: new CentralDispatchPolicy(),
      cognition: { id: "x", cohort: "C", propose: async () => [] },
    }),
    /either a cognition port or a baseline policy/,
  );
});

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

test("arm B is refused with an explanation, not silently mapped", async () => {
  const { io, json } = capture();
  const code = await runLabCli(["genesis-1", "--arm", "B", "--data-dir", "/nonexistent-is-fine"], io);
  assert.notEqual(code, 0);
  assert.match(json().error.message, /no metaagents to remove/);
});

test("the baselines command compares arms on one seed and writes the artifact", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-bl-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { io, json } = capture();
  const code = await runLabCli([
    "baselines", "--data-dir", directory, "--agents", "6", "--ticks", "12",
    "--metric-every", "6", "--checkpoint-every", "12", "--arms", "A,E",
  ], io);
  assert.equal(code, 0);
  const output = json();
  assert.equal(output.status, "completed");
  assert.deepEqual(output.comparison.arms.map((entry) => entry.arm), ["A", "E"]);
  assert.ok(output.comparison.pareto.frontier.length >= 1);
  assert.ok(output.comparison.caveats.length >= 2, "the artifact must carry its own methodology caveats");

  const persisted = JSON.parse(await readFile(output.path, "utf8"));
  assert.deepEqual(persisted.arms.map((entry) => entry.arm), ["A", "E"]);
  // The two arms ran the same config, so only the policy separates their identities.
  assert.equal(persisted.arms[0].configHash, persisted.arms[1].configHash);
  assert.notEqual(persisted.arms[0].runId, persisted.arms[1].runId);
});

test("the arms list refuses duplicates and unknown arms", async () => {
  for (const [arms, pattern] of [
    ["A,A", /must not repeat/],
    ["A,X", /Unknown baseline arm/],
    ["", /non-empty value/],
    [",", /at least one arm/],
  ]) {
    const { io, json } = capture();
    const code = await runLabCli(["baselines", "--arms", arms, "--data-dir", "/tmp"], io);
    assert.notEqual(code, 0);
    assert.match(json().error.message, pattern);
  }
});

/* ------------------------------------------------------------------ */
/* Regressions from the adversarial review                             */
/* ------------------------------------------------------------------ */

test("a reused baseline policy instance cannot poison a second run", async (t) => {
  const left = await mkdtemp(join(tmpdir(), "anu-bl-reuse1-"));
  const right = await mkdtemp(join(tmpdir(), "anu-bl-reuse2-"));
  t.after(() => Promise.all([rm(left, { recursive: true, force: true }), rm(right, { recursive: true, force: true })]));

  // The no-links policy is stateful through its inner NeutralPolicy. If
  // runGenesis ran with the caller's instance, the second run would draw from
  // the first run's RNG streams and fail its own final verification.
  const shared = new NoLinkAdaptationPolicy();
  const first = await runGenesis({ config: SMALL, runsRoot: left, universeId: "U0001", policy: shared });
  const second = await runGenesis({ config: SMALL, runsRoot: right, universeId: "U0001", policy: shared });
  assert.equal(first.finalEventHash, second.finalEventHash, "both runs must complete and verify identically");
});

test("frozen roles survive agent retirement and never re-deal", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-bl-frozen-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  // Retire 25% of the population mid-run: positional roles would shift every
  // surviving index and hand solver work to a genesis verifier.
  // The config demands one pressure of each type; only the retirement fires
  // inside this run's 24 ticks.
  const config = {
    ...SMALL,
    ticks: 24,
    pressures: [
      { tick: 8, type: "retire_agent_fraction", fractionPpm: 250_000 },
      { tick: 1_000, type: "resource_price_multiplier", resource: "credits", multiplierPpm: 1_000_000 },
      { tick: 1_000, type: "bandwidth_capacity_multiplier", multiplierPpm: 1_000_000 },
      { tick: 1_000, type: "task_load_multiplier", multiplierPpm: 1_000_000 },
    ],
  };
  const summary = await runGenesis({
    config, runsRoot: directory, universeId: "U0001", policy: new FixedRolesPolicy(),
  });
  const lines = (await readEvents(directory, "U0001", summary.runId)).trim().split("\n").map((line) => JSON.parse(line));

  const genesisVerifiers = new Set(["N0004", "N0008"]);
  for (const event of lines.filter((entry) => entry.type === "submission.verified")) {
    assert.ok(genesisVerifiers.has(event.actorId), `${event.actorId} verified without a frozen verifier role`);
  }
  for (const event of lines.filter((entry) => entry.type === "task.claimed")) {
    assert.ok(!genesisVerifiers.has(event.data.agentId), `${event.data.agentId} claimed despite a frozen verifier role`);
  }
});

test("every completed pre-final-tick submission gets verified, collisions included", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-bl-coverage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const summary = await runGenesis({
    config: SMALL, runsRoot: directory, universeId: "U0001", policy: new FixedRolesPolicy(),
  });
  const lines = (await readEvents(directory, "U0001", summary.runId)).trim().split("\n").map((line) => JSON.parse(line));

  const submitted = new Map(
    lines
      .filter((event) => event.type === "task.submitted" && event.tick < SMALL.ticks)
      .map((event) => [event.data.submission.id, event.data.submission.taskId]),
  );
  const completedTasks = new Set(
    lines.filter((event) => event.type === "task.evaluated").map((event) => event.data.evaluation?.taskId
      ?? event.targetId ?? event.data.taskId).filter(Boolean),
  );
  const verified = new Set(
    lines.filter((event) => event.type === "submission.verified").map((event) => event.data.verification.submissionId),
  );
  let expected = 0;
  for (const [submissionId, taskId] of submitted) {
    if (!completedTasks.has(taskId)) continue;
    expected += 1;
    assert.ok(verified.has(submissionId), `submission ${submissionId} was dispatched but never verified`);
  }
  assert.ok(expected > 0, "the coverage assertion must actually cover something");
});

test("an arm's identity does not depend on the --arms list it was requested in", async (t) => {
  const solo = await mkdtemp(join(tmpdir(), "anu-bl-solo-"));
  const paired = await mkdtemp(join(tmpdir(), "anu-bl-paired-"));
  t.after(() => Promise.all([rm(solo, { recursive: true, force: true }), rm(paired, { recursive: true, force: true })]));

  const flags = ["--agents", "6", "--ticks", "10", "--metric-every", "5", "--checkpoint-every", "10"];
  const one = capture();
  assert.equal(await runLabCli(["baselines", "--data-dir", solo, ...flags, "--arms", "E"], one.io), 0);
  const two = capture();
  assert.equal(await runLabCli(["baselines", "--data-dir", paired, ...flags, "--arms", "A,E"], two.io), 0);

  const soloArm = one.json().comparison.arms.find((entry) => entry.arm === "E");
  const pairedArm = two.json().comparison.arms.find((entry) => entry.arm === "E");
  assert.equal(soloArm.universeId, "U0004");
  assert.equal(soloArm.runId, pairedArm.runId, "the same arm must be the same run wherever it is requested");
});

test("every arm faces the identical task realization, not just the same distribution", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-bl-tasks-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { io, json } = capture();
  const code = await runLabCli([
    "baselines", "--data-dir", directory, "--agents", "6", "--ticks", "12",
    "--metric-every", "6", "--checkpoint-every", "12", "--arms", "A,C,E",
  ], io);
  assert.equal(code, 0);
  const output = json();

  // The comparison pins the realization: identical tasks, identical oracles,
  // in every arm — including arm C, whose config differs in costs.
  const streams = await Promise.all(output.comparison.arms.map(async (entry) => {
    const events = await readEvents(directory, entry.universeId, entry.runId);
    return events
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "task.created")
      .map((event) => hashValue(event.data.task));
  }));
  assert.ok(streams[0].length > 0, "arms must have generated tasks");
  for (const stream of streams.slice(1)) {
    assert.deepEqual(stream, streams[0], "arms must share one task realization");
  }
  assert.match(
    output.comparison.caveats[0],
    /pinned task realization/,
    "the artifact must state the realization is shared",
  );
});
