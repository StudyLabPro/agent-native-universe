import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hashValue } from "../dist/lab/canonical.js";
import { DEFAULT_GENESIS_CONFIG } from "../dist/lab/config.js";
import { LlmCognition } from "../dist/lab/cognition.js";
import { GenesisRunPausedError, runGenesis } from "../dist/lab/genesis.js";
import { EvidenceStore } from "../dist/lab/artifacts.js";
import { ReplayEngine } from "../dist/lab/replay.js";
import { createRunManifest } from "../dist/lab/manifest.js";
import { LogicalUniverse } from "../dist/lab/world.js";

async function waitFor(predicate) {
  while (!predicate()) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
}

async function tempDir(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function scriptedCompletion(model) {
  const content = JSON.stringify({ actions: [{ type: "observe" }] });
  return {
    async complete() {
      return {
        provider: "scripted",
        model,
        content,
        usage: { inputTokens: 4, outputTokens: 4, totalTokens: 8 },
        latencyMs: 1,
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Cohort resume                                                       */
/* ------------------------------------------------------------------ */

test("a cohort-B run interrupted at a tick boundary resumes and matches an uninterrupted run's final hash", async (t) => {
  const interruptedRoot = await tempDir(t, "anu-resume-cohort-");
  const controlRoot = await tempDir(t, "anu-resume-control-");

  const agentsPerTick = 3;
  const pauseAfterTick = 3;
  const config = {
    ...DEFAULT_GENESIS_CONFIG,
    ticks: 8,
    agents: agentsPerTick,
    metricEvery: 1,
    checkpointEvery: 1,
  };

  // Fires the run's own abort signal from inside the last consultation of
  // `pauseAfterTick` — a fake `CompletionLike` standing in for the completion
  // process a real SIGTERM interrupts. The call itself resolves normally (it
  // does not consult `signal` on its success path), so aborting here neither
  // corrupts this tick's cognition nor any tick before it: the abort is only
  // observed by `run()`'s between-tick check, well after this tick's
  // `tick.completed` has already been committed.
  const controller = new AbortController();
  let calls = 0;
  const interruptingCompletion = {
    async complete(...args) {
      calls += 1;
      const result = await scriptedCompletion("scripted-cohort-b").complete(...args);
      if (calls === agentsPerTick * pauseAfterTick) controller.abort();
      return result;
    },
  };

  await assert.rejects(
    runGenesis({
      config,
      runsRoot: interruptedRoot,
      universeId: "U0001",
      cognition: new LlmCognition({
        cohort: "B", model: "scripted-cohort-b", completion: interruptingCompletion, agentsPerTick,
      }),
      signal: controller.signal,
    }),
    (error) => {
      assert.ok(error instanceof GenesisRunPausedError, `expected GenesisRunPausedError, got ${error}`);
      assert.equal(error.tick, pauseAfterTick, "the pause must land exactly at the tick boundary, not mid-tick");
      return true;
    },
  );

  // Re-running the identical command with a fresh cognition instance resumes
  // from pauseAfterTick + 1 instead of redoing the run from genesis.
  const resumed = await runGenesis({
    config,
    runsRoot: interruptedRoot,
    universeId: "U0001",
    cognition: new LlmCognition({
      cohort: "B", model: "scripted-cohort-b", completion: scriptedCompletion("scripted-cohort-b"), agentsPerTick,
    }),
  });
  assert.equal(resumed.ticks, config.ticks);

  // An uninterrupted control run, same config and cognition identity, in a
  // separate evidence root so its runId (identical, since nothing about the
  // treatment differs) cannot collide with the interrupted run's directory.
  const control = await runGenesis({
    config,
    runsRoot: controlRoot,
    universeId: "U0001",
    cognition: new LlmCognition({
      cohort: "B", model: "scripted-cohort-b", completion: scriptedCompletion("scripted-cohort-b"), agentsPerTick,
    }),
  });

  assert.equal(resumed.runId, control.runId, "the same treatment must produce the same run identity");
  assert.equal(resumed.finalStateHash, control.finalStateHash);
  assert.equal(resumed.finalEventHash, control.finalEventHash);
});

/* ------------------------------------------------------------------ */
/* Neutral resume: oracle rebuild                                      */
/* ------------------------------------------------------------------ */

test("a neutral run interrupted with open tasks resumes with zero 'No oracle registered' violations", async (t) => {
  const runsRoot = await tempDir(t, "anu-resume-neutral-");
  const universeId = "U0001";
  const config = {
    ...DEFAULT_GENESIS_CONFIG,
    ticks: 12,
    agents: 4,
    metricEvery: 1,
    checkpointEvery: 1,
    taskStream: {
      ...DEFAULT_GENESIS_CONFIG.taskStream,
      tasksPerTick: 2,
      deadlineTicks: 40,
      maxBacklog: 64,
    },
  };
  const interruptAtTick = 2;

  // Simulate a SIGTERM-clean pause without going through an AbortSignal at
  // all: a plain neutral run has no async consultation step for a signal to
  // interrupt mid-flight, so the most faithful (and fully deterministic)
  // stand-in is to drive exactly the ticks a real process would have
  // completed before the pause, then stop — checkpointEvery: 1 means every
  // one of those ticks already left a durable checkpoint behind, exactly as
  // `#pauseAtBoundary` would.
  const manifest = createRunManifest(config, universeId);
  const evidence = await EvidenceStore.initialize(runsRoot, manifest, config);
  const universe = new LogicalUniverse(manifest, config, evidence.events, {
    onMetrics: (metrics) => evidence.appendMetrics(metrics),
    onCheckpoint: (checkpoint) => evidence.writeCheckpoint(checkpoint),
  });
  for (let tick = 0; tick < interruptAtTick; tick += 1) await universe.tick();
  await evidence.flush();

  // By tick 2, tasks generated at ticks 1 and 2 cannot possibly have reached
  // evaluation yet (create -> claim -> execute -> submit -> evaluate spans at
  // least four ticks under the neutral policy), so at least one oracle is
  // open across the checkpoint boundary by construction, not by RNG luck.
  const openTasks = Object.values(universe.state().tasks)
    .filter((task) => task.status !== "completed" && task.status !== "expired");
  assert.ok(openTasks.length > 0, "the interruption point must leave at least one task open");

  const summary = await runGenesis({ config, runsRoot, universeId });
  assert.equal(summary.ticks, config.ticks);

  const events = await readEvents(evidence.eventsPath);
  const oracleViolations = events.filter((event) => (
    event.type === "violation.recorded" && /No oracle registered/.test(String(event.data?.reason ?? ""))
  ));
  assert.deepEqual(oracleViolations, [], "resume must never fail an evaluation for lack of a rebuilt oracle");
});

async function readEvents(path) {
  const text = await readFile(path, "utf8");
  return text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

/* ------------------------------------------------------------------ */
/* checkpoint-runtime hash parity: world.ts vs protocol-verifier.ts     */
/* ------------------------------------------------------------------ */

test("checkpoint runtime hashes identically from world.ts and protocol-verifier.ts for a cohort policy", async (t) => {
  const runsRoot = await tempDir(t, "anu-resume-parity-");
  const agentsPerTick = 3;
  const pauseAfterTick = 2;
  const config = {
    ...DEFAULT_GENESIS_CONFIG,
    ticks: 6,
    agents: agentsPerTick,
    metricEvery: 1,
    checkpointEvery: 1,
  };

  const controller = new AbortController();
  let calls = 0;
  const completion = {
    async complete(...args) {
      calls += 1;
      const result = await scriptedCompletion("scripted-parity").complete(...args);
      if (calls === agentsPerTick * pauseAfterTick) controller.abort();
      return result;
    },
  };

  await assert.rejects(
    runGenesis({
      config,
      runsRoot,
      universeId: "U0001",
      cognition: new LlmCognition({ cohort: "C", model: "scripted-parity", completion, agentsPerTick }),
      signal: controller.signal,
    }),
    (error) => {
      assert.ok(error instanceof GenesisRunPausedError);
      assert.equal(error.tick, pauseAfterTick);
      return true;
    },
  );

  const store = await EvidenceStore.openExisting(runsRoot, config.experimentId, "U0001");
  const manifest = await store.readManifest();
  assert.match(manifest.policyId, /^cohort-c-/);
  const storedConfig = await store.readConfig();
  const checkpoint = await store.readCheckpoint(pauseAfterTick);
  assert.ok(checkpoint, "the paused tick must have left a durable checkpoint");
  assert.notEqual(checkpoint.runtime?.policy, null, "a cohort policy's checkpoint must carry resumable RNG state");

  // world.ts wrote `checkpoint.runtime` live, during the run; this replays
  // the same event stream independently through protocol-verifier.ts's own
  // `checkpointRuntime()` and the two must agree byte-for-byte.
  const replay = await ReplayEngine.replayRecoverableFile(store.eventsPath, manifest, storedConfig);
  assert.equal(replay.lastTick, pauseAfterTick);
  assert.ok(replay.runtime);
  assert.equal(hashValue(replay.runtime), hashValue(checkpoint.runtime));
  assert.deepEqual(replay.runtime, checkpoint.runtime);
});

/* ------------------------------------------------------------------ */
/* fsyncEveryTick                                                       */
/* ------------------------------------------------------------------ */

test("fsyncEveryTick fsyncs the event log at every tick.completed and nothing else changes", async (t) => {
  const rootWithFsync = await tempDir(t, "anu-fsync-on-");
  const rootWithoutFsync = await tempDir(t, "anu-fsync-off-");

  // FileHandle instances all share one prototype; mocking `sync` there
  // observes every fsync in the process for the duration of this test,
  // regardless of which code path opened the handle.
  const probe = await open(join(rootWithFsync, ".probe"), "w");
  const proto = Object.getPrototypeOf(probe);
  await probe.close();
  const originalSync = proto.sync;
  let syncCalls = 0;
  t.mock.method(proto, "sync", function mockedSync(...args) {
    syncCalls += 1;
    return originalSync.apply(this, args);
  });

  const config = {
    ...DEFAULT_GENESIS_CONFIG,
    ticks: 4,
    agents: 2,
    metricEvery: 1,
    // No mid-run checkpoint: isolates the count to exactly the fsyncEveryTick calls.
    checkpointEvery: 100,
  };

  syncCalls = 0;
  const withFsync = await runGenesis({
    config, runsRoot: rootWithFsync, universeId: "U0001", fsyncEveryTick: true,
  });
  const syncCallsWithFsync = syncCalls;

  syncCalls = 0;
  const withoutFsync = await runGenesis({
    config, runsRoot: rootWithoutFsync, universeId: "U0001",
  });
  const syncCallsWithoutFsync = syncCalls;

  assert.equal(
    syncCallsWithFsync - syncCallsWithoutFsync,
    config.ticks,
    "fsyncEveryTick must add exactly one extra fsync per tick.completed",
  );

  // Durability only: the option must not move a single byte of evidence.
  assert.equal(withFsync.finalStateHash, withoutFsync.finalStateHash);
  assert.equal(withFsync.finalEventHash, withoutFsync.finalEventHash);
  const withFsyncEvents = await readFile(
    join(rootWithFsync, config.experimentId, "U0001", withFsync.runId, "events.jsonl"),
    "utf8",
  );
  const withoutFsyncEvents = await readFile(
    join(rootWithoutFsync, config.experimentId, "U0001", withoutFsync.runId, "events.jsonl"),
    "utf8",
  );
  assert.equal(withFsyncEvents, withoutFsyncEvents);
});
