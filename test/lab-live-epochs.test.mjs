/**
 * Genesis-Live epoch spine (design §4.B, phase L3a).
 *
 * What is proven here: a live universe is a chain of bounded epochs numbered
 * on one absolute tick axis, each epoch replays and attests like any run of
 * this laboratory, the chain index links parents to children, a replay of the
 * chain from epoch 0 reproduces the final state of the last epoch, an
 * unsteered live agent idles instead of receiving a computed answer, and the
 * live-only world fields never appear in a logical state.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson, hashValue } from "../dist/lab/canonical.js";
import { DEFAULT_GENESIS_CONFIG, validateGenesisConfig } from "../dist/lab/config.js";
import { CohortPolicy } from "../dist/lab/cognition.js";
import { EvidenceStore } from "../dist/lab/artifacts.js";
import { calibrationTaskCount, compactWorldState, epochBoundaryExpiries } from "../dist/lab/epoch-rules.js";
import { runGenesis } from "../dist/lab/genesis.js";
import {
  LAB_LIVE_POLICY_ID,
  assertLabManifestImplementation,
  createRunManifest,
} from "../dist/lab/manifest.js";
import { applyWorldEventMutable, initialWorldState } from "../dist/lab/reducer.js";
import { ReplayEngine } from "../dist/lab/replay.js";
import { LiveIdlePolicy } from "../dist/lab/live/live-idle-policy.js";
import {
  liveEpochConfig,
  openLiveEpochEvidence,
  planLiveEpoch,
  runLiveEpoch,
  runLiveUniverse,
  verifyLiveChain,
} from "../dist/lab/live/epoch.js";
import { LIVE_UNIVERSE_ID } from "../dist/lab/live/identity.js";
import { LIVE_ORACLE_EVALUATOR_ID } from "../dist/lab/live/evaluator-port.js";
import { liveTestConfig, scriptedLiveCognition } from "./live-fixture.mjs";

async function tempDir(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function readEvents(dataRoot, runId, universeId = LIVE_UNIVERSE_ID) {
  const store = openLiveEpochEvidence(dataRoot, universeId, runId);
  const text = await readFile(store.eventsPath, "utf8");
  return text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

async function readChainLink(dataRoot, epoch, universeId = LIVE_UNIVERSE_ID) {
  const path = join(dataRoot, "genesis-live", universeId, "chain", `${epoch}.json`);
  return JSON.parse(await readFile(path, "utf8"));
}

/* ------------------------------------------------------------------ */
/* The chain                                                           */
/* ------------------------------------------------------------------ */

test("three chained epochs run on one absolute tick axis, link their parents and replay from epoch 0", async (t) => {
  const root = await tempDir(t, "anu-live-chain-");
  const config = liveTestConfig();
  const results = await runLiveUniverse({
    dataRoot: root,
    config,
    cognition: scriptedLiveCognition(),
    epochs: 3,
  });

  assert.deepEqual(results.map((result) => result.epoch), [0, 1, 2]);
  assert.deepEqual(results.map((result) => result.startTick), [0, 50, 100]);
  assert.deepEqual(results.map((result) => result.ticks), [50, 100, 150]);
  // Absolute ticks: three epochs of 50 ticks cover 1..150 without a restart.
  assert.equal(new Set(results.map((result) => result.runId)).size, 3);

  for (const [index, result] of results.entries()) {
    const events = await readEvents(root, result.runId);
    const started = events[0];
    assert.equal(started.type, "run.started");
    assert.equal(started.tick, result.startTick);
    assert.equal(started.seq, 1);
    const created = events.filter((event) => event.type === "agent.created");
    const ticks = events.filter((event) => event.type === "tick.completed").map((event) => event.tick);
    assert.deepEqual(
      ticks,
      Array.from({ length: 50 }, (_, offset) => result.startTick + offset + 1),
      "every epoch completes exactly its 50 absolute ticks",
    );
    const completed = events.at(-1);
    assert.equal(completed.type, "run.completed");
    assert.equal(completed.tick, result.ticks);

    if (index === 0) {
      assert.equal(created.length, config.agents, "epoch 0 creates the genesis population");
      assert.equal(started.data.inherited, undefined);
      assert.deepEqual(started.data.treasury, config.treasuryResources);
    } else {
      const parent = results[index - 1];
      assert.equal(created.length, 0, "an inherited epoch creates no agents: it continues the parent's");
      assert.equal(started.data.inherited.parentRunId, parent.runId);
      assert.equal(started.data.inherited.parentStateHash, parent.summary.finalStateHash);
      assert.equal(started.data.inherited.parentEventHash, parent.summary.finalEventHash);
      assert.equal(started.data.inherited.startTick, parent.ticks);
    }
  }

  // chain/ links every epoch to its parent, by run id and by commitment.
  for (const [index, result] of results.entries()) {
    const link = await readChainLink(root, index);
    assert.deepEqual(link, result.link);
    assert.equal(link.epoch, index);
    assert.equal(link.runId, result.runId);
    assert.equal(link.stateHash, result.summary.finalStateHash);
    assert.equal(link.eventHash, result.summary.finalEventHash);
    if (index === 0) {
      assert.equal(link.parentRunId, undefined);
      assert.equal(link.parentCommitment, undefined);
    } else {
      assert.equal(link.parentRunId, results[index - 1].runId);
      assert.equal(link.parentCommitment, results[index - 1].link.commitment);
    }
    // Every epoch is attested exactly like any bounded run of the lab.
    const attestation = await openLiveEpochEvidence(root, LIVE_UNIVERSE_ID, result.runId).readFinalAttestation();
    assert.equal(attestation.commitment, link.commitment);
    assert.equal(attestation.subject.experimentId, "genesis-live");
    assert.equal(attestation.scope.tick, result.ticks);
  }

  // The full audit: replay the chain from epoch 0 and reproduce epoch 2.
  const audit = await verifyLiveChain({ dataRoot: root });
  assert.deepEqual(audit.epochs.map((epoch) => epoch.epoch), [0, 1, 2]);
  assert.deepEqual(audit.epochs.map((epoch) => epoch.stateHash), results.map((r) => r.summary.finalStateHash));
  assert.equal(audit.finalStateHash, results.at(-1).summary.finalStateHash);
  assert.equal(audit.finalTick, 150);
});

test("an epoch's identity is a pure function of what its parent left on disk", async (t) => {
  const root = await tempDir(t, "anu-live-identity-");
  const config = liveTestConfig();
  const cognition = scriptedLiveCognition();
  const first = await runLiveEpoch({ dataRoot: root, config, cognition });

  // Planned twice from the same disk state: the same epoch, the same run id.
  const planned = await planLiveEpoch({ dataRoot: root, config, cognition });
  const replanned = await planLiveEpoch({ dataRoot: root, config, cognition });
  assert.equal(planned.epoch, 1);
  assert.equal(planned.manifest.runId, replanned.manifest.runId);
  assert.equal(planned.config.live.genesisFrom.runId, first.runId);
  assert.equal(planned.config.live.genesisFrom.stateHash, first.summary.finalStateHash);
  assert.equal(planned.config.live.genesisFrom.tick, 50);
  assert.equal(planned.config.ticks, 100);
  assert.equal(hashValue(planned.genesisState), planned.config.live.genesisFrom.genesisStateHash);

  // genesisFrom lives inside the config, so a different parent state is a
  // different child identity — the chain cannot be forged by relabelling.
  const forged = structuredClone(planned.config);
  forged.live.genesisFrom.stateHash = "f".repeat(64);
  validateGenesisConfig(forged);
  assert.notEqual(hashValue(forged), hashValue(planned.config));
  const forgedManifest = createRunManifest(forged, LIVE_UNIVERSE_ID, {
    mode: "live",
    policyId: LAB_LIVE_POLICY_ID,
    cognitionId: cognition.id,
    // Phase L3b: the port that grades recorded work is part of the live
    // identity, exactly as the consulted model is.
    evaluatorId: LIVE_ORACLE_EVALUATOR_ID,
  });
  assert.notEqual(forgedManifest.runId, planned.manifest.runId);

  // A live universe config describes epoch 0; per-epoch identities are derived.
  assert.throws(
    () => liveEpochConfig({ ...config, live: { ...config.live, genesisFrom: planned.config.live.genesisFrom } }),
    /genesisFrom is derived per epoch/,
  );
});

test("a chain never crosses an engine change without --accept-parent-engine", async (t) => {
  const root = await tempDir(t, "anu-live-engine-");
  const config = liveTestConfig();
  const cognition = scriptedLiveCognition();
  const [first] = await runLiveUniverse({ dataRoot: root, config, cognition, epochs: 1 });

  // Re-label the index entry as the work of an older live engine. The index is
  // not a source of truth, but it is what the planner reads before it opens
  // the parent's evidence at all.
  const linkPath = join(root, "genesis-live", LIVE_UNIVERSE_ID, "chain", "0.json");
  const link = JSON.parse(await readFile(linkPath, "utf8"));
  await rm(linkPath);
  await writeFile(linkPath, canonicalJson({ ...link, engineVersion: "genesis-live-v0.9.0" }));

  await assert.rejects(
    () => planLiveEpoch({ dataRoot: root, config, cognition }),
    /pass --accept-parent-engine to continue the chain across an engine change/,
  );
  // With the flag the gate passes, and what the child records as its parent's
  // engine comes from the parent's own manifest, not from the index it was
  // planned through — the index can lie, the evidence cannot.
  const accepted = await planLiveEpoch({
    dataRoot: root,
    config,
    cognition,
    acceptParentEngine: "genesis-live-v0.9.0",
  });
  assert.equal(accepted.config.live.genesisFrom.engineVersion, "genesis-live-v1.0.0");
  assert.equal(first.link.engineVersion, "genesis-live-v1.0.0");

  // A genuinely foreign parent stays unreadable to this build: accepting the
  // engine change is a recorded decision, not a licence to project evidence
  // of another engine. That projection is the seam phase L7 fills.
  assert.throws(
    () => assertLabManifestImplementation(
      { ...accepted.manifest, engineVersion: "genesis-live-v0.9.0" },
      { live: true },
    ),
    /Unsupported lab engineVersion genesis-live-v0.9.0/,
  );
});

/* ------------------------------------------------------------------ */
/* Oracles never cross a boundary                                      */
/* ------------------------------------------------------------------ */

test("calibration generation stops before the epoch ends and no oracle crosses the boundary", async (t) => {
  const root = await tempDir(t, "anu-live-oracles-");
  const config = liveTestConfig();
  const results = await runLiveUniverse({
    dataRoot: root,
    config,
    cognition: scriptedLiveCognition(),
    epochs: 2,
  });

  for (const result of results) {
    const events = await readEvents(root, result.runId);
    const createdTicks = events.filter((event) => event.type === "task.created").map((event) => event.tick);
    assert.ok(createdTicks.length > 0, "the epoch generates calibration work");
    const lastAllowed = result.ticks - config.taskStream.deadlineTicks - 1;
    assert.ok(
      Math.max(...createdTicks) <= lastAllowed,
      `calibration generation stops at ${lastAllowed}, not ${Math.max(...createdTicks)}`,
    );

    // Nothing with a hidden oracle is open when the epoch ends: an oracle
    // lives only in the running evaluator's memory and cannot be inherited.
    const store = openLiveEpochEvidence(root, LIVE_UNIVERSE_ID, result.runId);
    const final = await store.readCheckpoint(result.ticks);
    const open = Object.values(final.state.tasks).filter(
      (task) => task.status === "available" || task.status === "claimed" || task.status === "submitted",
    );
    assert.deepEqual(open, [], "no task crosses the epoch boundary unresolved");
  }

  // The rules the world applies are the rules the verifier regenerates: both
  // call these two pure functions, so a divergence is impossible by
  // construction, and both refuse to do anything outside live mode.
  const epochConfig = liveEpochConfig(config);
  const live = { mode: "live" };
  assert.equal(calibrationTaskCount(live, epochConfig, 44, 2), 2);
  assert.equal(calibrationTaskCount(live, epochConfig, 45, 2), 0, "generation stops deadlineTicks+1 before the end");
  assert.equal(calibrationTaskCount({ mode: "logical" }, epochConfig, 45, 2), 2);

  const openState = {
    tasks: {
      "task:b": { id: "task:b", family: "arithmetic", status: "claimed" },
      "task:a": { id: "task:a", family: "arithmetic", status: "available" },
      "task:c": { id: "task:c", family: "arithmetic", status: "completed" },
      "task:d": { id: "task:d", family: "external", status: "available" },
    },
  };
  assert.deepEqual(
    epochBoundaryExpiries(live, epochConfig, epochConfig.ticks, openState),
    ["task:a", "task:b"],
    "the final upkeep closes open calibration work, in id order",
  );
  assert.deepEqual(
    epochBoundaryExpiries(live, epochConfig, epochConfig.ticks - 1, openState),
    [],
    "only the final tick sweeps",
  );
  assert.deepEqual(epochBoundaryExpiries({ mode: "logical" }, epochConfig, epochConfig.ticks, openState), []);
});

test("the final upkeep's epoch_boundary expiry is a live-only rule of the one reducer", async (t) => {
  const root = await tempDir(t, "anu-live-sweep-");
  const [epoch] = await runLiveUniverse({
    dataRoot: root,
    config: liveTestConfig(),
    cognition: scriptedLiveCognition(),
    epochs: 1,
  });
  const store = openLiveEpochEvidence(root, LIVE_UNIVERSE_ID, epoch.runId);
  const final = await store.readCheckpoint(epoch.ticks);

  // A live world with one task still open in the final tick. Under a single
  // deadline-bounded calibration stream this cannot happen — generation stops
  // `deadlineTicks + 1` before the end — so the sweep is exercised here
  // directly; it is the guard for sources whose deadlines are not bounded by
  // the epoch (phase L3b) and for a compaction or physics change (L3c).
  const open = () => {
    const state = structuredClone(final.state);
    state.completed = false;
    const task = Object.values(state.tasks)[0];
    task.status = "available";
    return { state, taskId: task.id };
  };
  const expiry = (state, data, phase = "upkeep") => ({
    schemaVersion: 1,
    runId: state.runId,
    universeId: state.universeId,
    seq: 1_000_000,
    eventId: "event:synthetic",
    previousHash: "0".repeat(64),
    hash: "1".repeat(64),
    tick: state.tick,
    phase,
    type: "task.expired",
    data,
  });

  const swept = open();
  applyWorldEventMutable(swept.state, expiry(swept.state, { taskId: swept.taskId, reason: "epoch_boundary" }));
  assert.equal(swept.state.tasks[swept.taskId].status, "expired");

  const wrongPhase = open();
  assert.throws(
    () => applyWorldEventMutable(
      wrongPhase.state,
      expiry(wrongPhase.state, { taskId: wrongPhase.taskId, reason: "epoch_boundary" }, "task_generation"),
    ),
    /phase/,
  );

  const unknownReason = open();
  assert.throws(
    () => applyWorldEventMutable(
      unknownReason.state,
      expiry(unknownReason.state, { taskId: unknownReason.taskId, reason: "because" }, "task_generation"),
    ),
    /Unknown task.expired reason because/,
  );

  // Outside live mode the rule does not exist, and a deadline that has not
  // passed still refuses an ordinary expiry.
  const logicalWorld = open();
  delete logicalWorld.state.mode;
  delete logicalWorld.state.counters;
  assert.throws(
    () => applyWorldEventMutable(
      logicalWorld.state,
      expiry(logicalWorld.state, { taskId: logicalWorld.taskId, reason: "epoch_boundary" }),
    ),
    /epoch_boundary expiry is a live-only rule/,
  );
  const early = open();
  early.state.tasks[early.taskId].deadlineTick = early.state.tick + 5;
  assert.throws(
    () => applyWorldEventMutable(
      early.state,
      expiry(early.state, { taskId: early.taskId }, "task_generation"),
    ),
    /cannot expire before its deadline passes/,
  );
});

test("a tampered epoch is refused by the same verifier that verified it while it ran", async (t) => {
  const root = await tempDir(t, "anu-live-tamper-");
  const config = liveTestConfig();
  const cognition = scriptedLiveCognition();
  const [epoch] = await runLiveUniverse({ dataRoot: root, config, cognition, epochs: 1 });
  const store = openLiveEpochEvidence(root, LIVE_UNIVERSE_ID, epoch.runId);
  const manifest = await store.readManifest();
  const stored = await store.readConfig();
  const events = await readEvents(root, epoch.runId);

  // Removing one deterministic expiry breaks the regenerated schedule.
  const withoutExpiry = events.filter((event, index) => (
    index !== events.findIndex((candidate) => candidate.type === "task.expired")
  ));
  assert.throws(
    () => ReplayEngine.replay(withoutExpiry, manifest, stored, undefined, {
      live: { createFallbackPolicy: () => new LiveIdlePolicy() },
    }),
    /chain|expiry|protocol/i,
  );
});

/* ------------------------------------------------------------------ */
/* LiveIdlePolicy, and the unreachability of the neutral solver        */
/* ------------------------------------------------------------------ */

test("the live fallback is LiveIdlePolicy and an unsteered live agent does nothing", async (t) => {
  const root = await tempDir(t, "anu-live-idle-");
  const config = liveTestConfig();
  const [epoch] = await runLiveUniverse({
    dataRoot: root,
    config,
    cognition: scriptedLiveCognition({ silent: true }),
    epochs: 1,
  });

  const events = await readEvents(root, epoch.runId);
  const decided = events.filter((event) => [
    "task.claimed", "task.submitted", "resource.spent", "link.created", "message.sent",
    "memory.stored", "memory.retrieved", "violation.recorded",
  ].includes(event.type));
  assert.deepEqual(
    decided,
    [],
    "with no recorded answer every agent idles: a NeutralPolicy fallback would have acted here",
  );
  // The epoch is still a complete, replayable, attested epoch.
  const audit = await verifyLiveChain({ dataRoot: root });
  assert.equal(audit.epochs.length, 1);
  assert.equal(audit.finalStateHash, epoch.summary.finalStateHash);

  // The composed identity is exactly the literal a live manifest requires.
  assert.equal(new CohortPolicy("C", new LiveIdlePolicy()).id, LAB_LIVE_POLICY_ID);
});

test("the neutral solver is unreachable in live mode — by construction, in the source", async () => {
  const genesisSource = await readFile(new URL("../src/lab/genesis.ts", import.meta.url), "utf8");
  const verifierSource = await readFile(new URL("../src/lab/protocol-verifier.ts", import.meta.url), "utf8");
  const normalize = (text) => text.replace(/\s+/g, " ");

  // Both places that build a steered policy pick the live fallback whenever
  // the run is live; the neutral solver is on the non-live branch only.
  assert.match(
    normalize(genesisSource),
    /new CohortPolicy\( ?cognition\.cohort, live === undefined \? new NeutralPolicy\(\) : live\.createFallbackPolicy\(\) ?\)/,
  );
  assert.match(
    normalize(verifierSource),
    /this\.#policy = live \? new CohortPolicy\(cohortOf\(manifest\.policyId\), options\.live!\.createFallbackPolicy\(\)\)/,
  );
  // Neither file may reach the live policy by import: the science guard
  // forbids it, which is why the factory is injected.
  assert.ok(!genesisSource.includes("live/live-idle-policy"));
  assert.ok(!verifierSource.includes("live/live-idle-policy"));
  for (const [file, source] of [["genesis.ts", genesisSource], ["protocol-verifier.ts", verifierSource]]) {
    const constructions = [...source.matchAll(/new NeutralPolicy\(\)/g)];
    assert.ok(constructions.length <= 2, `${file} constructs the neutral solver only on its logical paths`);
  }
});

/* ------------------------------------------------------------------ */
/* stateHash discipline                                                */
/* ------------------------------------------------------------------ */

test("mode and counters are absent from the keys of a logical checkpoint and present in a live one", async (t) => {
  const logicalRoot = await tempDir(t, "anu-live-logical-");
  const liveRoot = await tempDir(t, "anu-live-live-");

  const logicalConfig = { ...structuredClone(DEFAULT_GENESIS_CONFIG), ticks: 4, agents: 3, metricEvery: 1, checkpointEvery: 1 };
  const summary = await runGenesis({ config: logicalConfig, runsRoot: logicalRoot, universeId: "U0001" });
  const logicalStore = new EvidenceStore(logicalRoot, "genesis-1", "U0001", { runId: summary.runId });
  const logicalCheckpoints = await logicalStore.readCheckpoints();
  assert.ok(logicalCheckpoints.length > 0);
  for (const checkpoint of logicalCheckpoints) {
    // Assert on the keys of the canonical JSON, not on behaviour: a live-only
    // field present here would silently move every scientific state hash.
    const keys = Object.keys(JSON.parse(canonicalJson(checkpoint.state)));
    assert.ok(!keys.includes("mode"), "a logical checkpoint state has no mode key");
    assert.ok(!keys.includes("counters"), "a logical checkpoint state has no counters key");
    assert.equal(canonicalJson(checkpoint.state).includes('"counters"'), false);
  }
  const logicalManifest = createRunManifest(logicalConfig, "U0001");
  const logicalKeys = Object.keys(JSON.parse(canonicalJson(initialWorldState(logicalManifest))));
  assert.ok(!logicalKeys.includes("mode") && !logicalKeys.includes("counters"));
  assert.throws(
    () => initialWorldState(logicalManifest, { mode: "live" }),
    /inherited genesis state belongs to a live epoch only/,
  );

  const results = await runLiveUniverse({
    dataRoot: liveRoot,
    config: liveTestConfig(),
    cognition: scriptedLiveCognition(),
    epochs: 2,
  });
  for (const result of results) {
    const store = openLiveEpochEvidence(liveRoot, LIVE_UNIVERSE_ID, result.runId);
    const checkpoint = await store.readCheckpoint(result.ticks);
    const keys = Object.keys(JSON.parse(canonicalJson(checkpoint.state)));
    assert.ok(keys.includes("mode") && keys.includes("counters"));
    assert.equal(checkpoint.state.mode, "live");
    // The counters are the lifetime totals of the universe, not of the epoch,
    // and they agree with what the (still unarchived) maps say.
    const tasks = Object.values(checkpoint.state.tasks);
    assert.equal(checkpoint.state.counters.tasksCreated, tasks.length);
    assert.equal(
      checkpoint.state.counters.tasksCompleted,
      tasks.filter((task) => task.status === "completed").length,
    );
    assert.equal(checkpoint.state.counters.submissions, Object.keys(checkpoint.state.submissions).length);
    assert.equal(checkpoint.state.counters.externalTasks, 0);
  }
  assert.ok(
    results[1].link.stateHash !== results[0].link.stateHash,
    "the universe's state moves on across the boundary",
  );
});

/* ------------------------------------------------------------------ */
/* Seams left open for L3b and L3c, and the scientific refusals        */
/* ------------------------------------------------------------------ */

test("every port of an epoch is validated, never silently ignored", async (t) => {
  const root = await tempDir(t, "anu-live-seams-");
  const base = { dataRoot: root, config: liveTestConfig(), cognition: scriptedLiveCognition() };
  // The two seams phase L3a left open were filled in L3c. What survives is the
  // property they existed for: an argument this build does not understand is a
  // refusal, not a silently dropped option.
  const refusals = [
    [{ archive: { compaction: "some-day" } }, /Unknown archive compaction some-day/],
    [{ archive: { window: 10 } }, /archive contains unknown field window/],
    [{ archive: 7 }, /archive must be an object/],
    [{ supervisor: { outageTicks: -1 } }, /supervisor.outageTicks must be a non-negative safe integer/],
    [{ supervisor: { minFree: 10 } }, /supervisor contains unknown field minFree/],
    [{ supervisor: [] }, /supervisor must be an object/],
  ];
  for (const [ports, pattern] of refusals) {
    await assert.rejects(() => planLiveEpoch({ ...base, ...ports }), pattern);
    await assert.rejects(() => runLiveEpoch({ ...base, ...ports }), pattern);
  }

  // Recorded work nobody can grade is refused up front, not left to hang.
  await assert.rejects(
    () => planLiveEpoch({ ...base, taskSource: { id: "x", async next() { return []; } } }),
    /A recorded task source needs an evaluator port/,
  );

  // Compaction is a recorded rule, not a convention: a kind this build cannot
  // apply is refused by the derivation, never quietly degraded to `none`.
  const state = {
    schemaVersion: 1, mode: "live", tick: 1, completed: true,
    agents: {}, tasks: {}, submissions: {}, submissionOrder: [], verifications: {}, messages: {},
  };
  assert.deepEqual(compactWorldState(state, { kind: "none" }), state);
  assert.throws(() => compactWorldState(state, { kind: "everything" }), /Unsupported live compaction rule everything/);
});

test("live evidence stays unreadable to the scientific readers", async (t) => {
  const root = await tempDir(t, "anu-live-refusal-");
  const config = liveTestConfig();
  const [epoch] = await runLiveUniverse({
    dataRoot: root,
    config,
    cognition: scriptedLiveCognition(),
    epochs: 1,
  });

  await assert.rejects(
    () => EvidenceStore.openExisting(root, "genesis-live", LIVE_UNIVERSE_ID, epoch.runId),
    /unsupported implementation/,
  );
  await assert.rejects(
    () => EvidenceStore.openExisting(root, "genesis-live", LIVE_UNIVERSE_ID),
    /No supported evidence runs/,
  );
  const store = openLiveEpochEvidence(root, LIVE_UNIVERSE_ID, epoch.runId);
  const manifest = await store.readManifest();
  const stored = await store.readConfig();
  await assert.rejects(
    () => ReplayEngine.replayFile(store.eventsPath, manifest, stored),
    /Unsupported lab execution mode live/,
  );
});
