/**
 * The bounded world (design §4.G, phase L3c).
 *
 * A universe that runs for ever must not have a state that grows for ever.
 * What is proven here:
 *
 *  - settled records leave the live state on their configured window, as
 *    `submission.archived` / `task.archived` / `message.archived` events of the
 *    upkeep, and everything they said is still in the append-only evidence;
 *  - the protocol verifier **regenerates** the archive plan rather than
 *    trusting the events: an omitted archival, an extra one, one out of order
 *    and one in a bounded run are each refused, on re-signed chains so that the
 *    refusal is the rule's and not the hash chain's;
 *  - the boundary compaction is recorded in `genesisFrom.compaction`, is
 *    self-describing (the windows travel inside it), is part of the child's
 *    identity, and is re-derived by `verifyLiveChain` from the parent's
 *    replayed state;
 *  - and the measurement the whole phase exists for: **16 agents, 5 000
 *    absolute ticks, ten chained epochs — checkpoint bytes on a plateau and
 *    per-tick time bounded.**
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hashValue } from "../dist/lab/canonical.js";
import { DEFAULT_GENESIS_CONFIG } from "../dist/lab/config.js";
import {
  archivableRecords,
  compactWorldState,
  emptyLiveArchivePlan,
  isEmptyLiveArchivePlan,
  liveTaskSettledTick,
  planLiveArchive,
} from "../dist/lab/epoch-rules.js";
import { computeMetrics } from "../dist/lab/metrics.js";
import { applyWorldEventMutable, initialWorldState } from "../dist/lab/reducer.js";
import { createRunManifest } from "../dist/lab/manifest.js";
import { ReplayEngine } from "../dist/lab/replay.js";
import { LiveIdlePolicy } from "../dist/lab/live/live-idle-policy.js";
import { liveCompactionRule, liveArchiveConfigOf } from "../dist/lab/live/archive.js";
import {
  openLiveEpochEvidence,
  planLiveEpoch,
  runLiveEpoch,
  runLiveUniverse,
  verifyLiveChain,
} from "../dist/lab/live/epoch.js";
import { LIVE_UNIVERSE_ID } from "../dist/lab/live/identity.js";
import {
  liveTestConfig,
  messagingLiveCognition,
  resequenceEventChain,
  resignEventChain,
  rotatingLiveCognition,
  scriptedLiveCognition,
} from "./live-fixture.mjs";

async function tempDir(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function readEvents(dataRoot, runId) {
  const store = openLiveEpochEvidence(dataRoot, LIVE_UNIVERSE_ID, runId);
  const text = await readFile(store.eventsPath, "utf8");
  return text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

const LIVE_PROJECTION = { live: { createFallbackPolicy: () => new LiveIdlePolicy() } };

/**
 * A universe whose archive windows actually bite inside a short epoch: tasks
 * settle at their five-tick deadline and are archived ten ticks later.
 */
function archivingConfig(overrides = {}) {
  const base = liveTestConfig();
  return liveTestConfig({
    ticks: 60,
    live: {
      ...base.live,
      epochTicks: 60,
      archive: { taskTicks: 10, messageTicks: 10, submissionTicks: 10 },
      fsyncEveryTick: false,
    },
    ...overrides,
  });
}

test("settled records leave the live state on their window and stay in the evidence", async (t) => {
  const root = await tempDir(t, "anu-live-archive-");
  const config = archivingConfig();
  const [epoch] = await runLiveUniverse({
    dataRoot: root,
    config,
    cognition: scriptedLiveCognition(),
    epochs: 1,
  });

  const events = await readEvents(root, epoch.runId);
  const archived = events.filter((event) => event.type.endsWith(".archived"));
  assert.ok(archived.length > 0, "the upkeep archives settled records");
  for (const event of archived) {
    assert.equal(event.phase, "upkeep");
    assert.equal(event.actorId, undefined);
    assert.equal(event.targetId, undefined);
    assert.equal(event.causationId, undefined);
  }
  const archivedTasks = archived.filter((event) => event.type === "task.archived");
  assert.ok(archivedTasks.length > 0);

  // Every archived task is still in the evidence, and its state is gone.
  const store = openLiveEpochEvidence(root, LIVE_UNIVERSE_ID, epoch.runId);
  const created = new Set(events
    .filter((event) => event.type === "task.created")
    .map((event) => event.data.task.id));
  for (const event of archivedTasks) {
    assert.ok(created.has(event.data.taskId), "an archived task was created in this very log");
  }
  const checkpoint = (await store.readCheckpoints()).at(-1);
  for (const event of archivedTasks) {
    assert.equal(checkpoint.state.tasks[event.data.taskId], undefined);
  }

  // The bounded world is smaller than its own history, and the lifetime totals
  // survive in `counters` — which is what keeps a metric meaning the same
  // thing after archival started.
  const state = checkpoint.state;
  assert.ok(
    state.counters.tasksCreated > Object.keys(state.tasks).length,
    `counters keep the lifetime total (${state.counters.tasksCreated}) above the working set (${Object.keys(state.tasks).length})`,
  );
  const metrics = computeMetrics(state);
  assert.equal(metrics.tasksCreated, state.counters.tasksCreated);
  assert.equal(metrics.tasksCompleted, state.counters.tasksCompleted);

  // Nothing an archived record could still be read through survives it: a
  // submission takes its verifications with it, mail leaves its recipient's
  // inbox, and no task is archived while a submission still names it.
  for (const submission of Object.values(state.submissions)) {
    assert.ok(state.tasks[submission.taskId] !== undefined, "a live submission's task is still there");
  }
  for (const agent of Object.values(state.agents)) {
    for (const messageId of agent.inbox) {
      assert.ok(state.messages[messageId] !== undefined, "an inbox never points at archived mail");
    }
  }
  for (const verification of Object.values(state.verifications)) {
    assert.ok(state.submissions[verification.submissionId] !== undefined);
  }

  // The whole thing replays and attests from its own events, with no provider.
  const manifest = await store.readManifest();
  const stored = await store.readConfig();
  const replay = await ReplayEngine.replayFile(store.eventsPath, manifest, stored, undefined, LIVE_PROJECTION);
  assert.equal(replay.stateHash, epoch.summary.finalStateHash);
  await verifyLiveChain({ dataRoot: root });
});

test("delivered mail leaves the world and its inbox, and stays in the evidence", async (t) => {
  const root = await tempDir(t, "anu-live-archive-mail-");
  // Eight agents all posting into one inbox: it passes PUBLIC_INBOX_WINDOW
  // quickly, which is what makes the message window observable in one epoch.
  const config = archivingConfig({ agents: 8 });
  const [epoch] = await runLiveUniverse({
    dataRoot: root,
    config,
    cognition: messagingLiveCognition(),
    epochs: 1,
  });
  const events = await readEvents(root, epoch.runId);
  const archived = events.filter((event) => event.type === "message.archived");
  assert.ok(archived.length > 0, "delivered mail older than its window is archived");

  const store = openLiveEpochEvidence(root, LIVE_UNIVERSE_ID, epoch.runId);
  const state = (await store.readCheckpoints()).at(-1).state;
  const sent = new Set(events.filter((event) => event.type === "message.sent").map((event) => event.data.message.id));
  for (const event of archived) {
    assert.ok(sent.has(event.data.messageId), "an archived message was sent in this very log");
    assert.equal(state.messages[event.data.messageId], undefined, "it is gone from the world");
    for (const agent of Object.values(state.agents)) {
      assert.ok(!agent.inbox.includes(event.data.messageId), "and gone from every inbox");
    }
  }
  // The inbox that received everything is bounded, and every id in it resolves.
  const inboxes = Object.values(state.agents).map((agent) => agent.inbox.length);
  assert.ok(Math.max(...inboxes) > 0);
  for (const agent of Object.values(state.agents)) {
    for (const messageId of agent.inbox) assert.ok(state.messages[messageId] !== undefined);
  }
  await verifyLiveChain({ dataRoot: root });
});

test("the archive plan is regenerated by the verifier, not trusted", async (t) => {
  const root = await tempDir(t, "anu-live-archive-forgery-");
  const config = archivingConfig();
  const [epoch] = await runLiveUniverse({
    dataRoot: root,
    config,
    cognition: scriptedLiveCognition(),
    epochs: 1,
  });
  const store = openLiveEpochEvidence(root, LIVE_UNIVERSE_ID, epoch.runId);
  const manifest = await store.readManifest();
  const stored = await store.readConfig();
  const events = await readEvents(root, epoch.runId);
  // The untampered chain is accepted, so every refusal below is about the rule.
  assert.equal(
    ReplayEngine.replay(events, manifest, stored, undefined, LIVE_PROJECTION).stateHash,
    epoch.summary.finalStateHash,
  );

  // The first tick whose upkeep archives anything, and the last archival of
  // that tick: everything after it in the prefix below is one `tick.completed`
  // with no causal parent and no embedded sequence, which is what makes the
  // renumbering in `resequenceEventChain` sound here.
  const firstArchived = events.find((event) => event.type.endsWith(".archived"));
  assert.ok(firstArchived !== undefined);
  const tick = firstArchived.tick;
  const completed = events.find((event) => event.tick === tick && event.type === "tick.completed");
  const prefix = events.filter((event) => event.seq <= completed.seq);
  const lastArchived = prefix.filter((event) => event.tick === tick && event.type.endsWith(".archived")).at(-1);

  // 1. An omitted archival. The tick kept a record the windows require it to
  //    archive, and the plan the verifier regenerates from the state at
  //    `tick.completed` says so — a run cannot quietly stop bounding itself.
  const omitted = resequenceEventChain(
    prefix.filter((event) => event.seq !== lastArchived.seq),
    manifest,
  );
  assert.throws(
    () => ReplayEngine.replay(omitted, manifest, stored, undefined, LIVE_PROJECTION),
    /the upkeep left records the archive windows require it to archive/,
  );
  // The same prefix with nothing removed is accepted right up to its (missing)
  // completion, so the refusal above is the archive rule and not the truncation.
  assert.throws(
    () => ReplayEngine.replay(resequenceEventChain(prefix, manifest), manifest, stored, undefined, LIVE_PROJECTION),
    /Event stream ends before run.completed/,
  );

  // 2. Archiving a record the rule would have kept. A settled task still
  //    inside its window is a legal removal as far as the reducer's structural
  //    checks go; the regenerated plan does not name it, so the verifier
  //    refuses it. No renumbering — the forgery is one payload, re-signed.
  const archivedTask = prefix.find((event) => event.type === "task.archived");
  assert.ok(archivedTask !== undefined);
  // A task that expired on the very tick of the archival: settled, so the
  // reducer's structural checks pass, and far inside its ten-tick window, so
  // the regenerated plan does not name it.
  const spared = events
    .filter((event) => event.type === "task.expired" && event.tick === archivedTask.tick)
    .map((event) => event.data.taskId)
    .at(-1);
  assert.ok(spared !== undefined, "the archiving tick also expires work");
  const wrongRecord = resignEventChain(events.map((event) => (
    event.seq === archivedTask.seq ? { ...event, data: { taskId: spared } } : event
  )));
  assert.throws(
    () => ReplayEngine.replay(wrongRecord, manifest, stored, undefined, LIVE_PROJECTION),
    /task archival data|unexpected task.archived event|cannot be archived/,
  );

  // 3. A `task.archived` outside the upkeep is not in the live phase table.
  const misphased = resignEventChain(events.map((event) => (
    event.seq === archivedTask.seq ? { ...event, phase: "resolution" } : event
  )));
  assert.throws(
    () => ReplayEngine.replay(misphased, manifest, stored, undefined, LIVE_PROJECTION),
    /phase resolution/,
  );
});

test("archival is a live-only rule of the one reducer", () => {
  const config = { ...structuredClone(DEFAULT_GENESIS_CONFIG), agents: 2, ticks: 4 };
  const logical = createRunManifest(config, "U0001");
  const state = initialWorldState(logical);
  assert.equal(state.mode, undefined, "a logical state has no live-only field");
  // A world that has started and holds one settled task: everything the
  // reducer's structural checks want, except the one thing it refuses.
  state.started = true;
  state.tick = 1;
  state.tasks["task:settled"] = {
    id: "task:settled",
    family: "arithmetic",
    input: { kind: "arithmetic" },
    createdTick: 0,
    deadlineTick: 0,
    status: "expired",
  };
  assert.throws(
    () => applyWorldEventMutable(state, {
      schemaVersion: 1,
      runId: logical.runId,
      universeId: "U0001",
      seq: 1,
      eventId: "event:x",
      previousHash: "0".repeat(64),
      hash: "0".repeat(64),
      tick: 1,
      phase: "upkeep",
      type: "task.archived",
      data: { taskId: "task:settled" },
    }),
    /Archival is a live-only rule/,
  );
});

test("the archive plan is a pure fixpoint over the state", () => {
  const windows = { taskTicks: 10, messageTicks: 10, submissionTicks: 10 };
  const state = {
    schemaVersion: 1,
    mode: "live",
    tick: 100,
    completed: true,
    agents: { "agent:a": { id: "agent:a", inbox: ["message:old", "message:new"] } },
    tasks: {
      "task:settled": { id: "task:settled", status: "completed", completedTick: 80, deadlineTick: 90 },
      "task:expired": { id: "task:expired", status: "expired", deadlineTick: 70 },
      "task:fresh": { id: "task:fresh", status: "completed", completedTick: 95, deadlineTick: 99 },
      "task:open": { id: "task:open", status: "available", deadlineTick: 120 },
      "task:held": { id: "task:held", status: "completed", completedTick: 80, deadlineTick: 90 },
    },
    submissions: {
      "submission:held": { id: "submission:held", taskId: "task:held", submittedTick: 95 },
    },
    submissionOrder: ["submission:held"],
    verifications: {},
    messages: {
      "message:old": { id: "message:old", recipientId: "agent:a", deliveredTick: 80 },
      "message:new": { id: "message:new", recipientId: "agent:a", deliveredTick: 95 },
    },
  };

  assert.equal(liveTaskSettledTick(state.tasks["task:settled"]), 80);
  assert.equal(liveTaskSettledTick(state.tasks["task:expired"]), 70, "an expired task settles at its deadline");

  const plan = archivableRecords(windows, state.tick, state);
  assert.deepEqual(plan.tasks, ["task:expired", "task:settled"], "settled and past the window, in id order");
  assert.deepEqual(plan.submissions, [], "the newest submissions stay observable");
  assert.deepEqual(plan.messages, [], "the newest inbox entries stay observable");
  assert.ok(!plan.tasks.includes("task:held"), "a task a live submission still names is kept");
  assert.ok(!plan.tasks.includes("task:open"), "an open task is not settled");
  assert.ok(!plan.tasks.includes("task:fresh"), "a task inside the window is kept");

  // Applying the plan and recomputing yields nothing: that fixpoint is what
  // lets the verifier demand an upkeep archived everything it had to.
  const compacted = compactWorldState(state, { kind: "windows", archive: windows });
  assert.ok(isEmptyLiveArchivePlan(archivableRecords(windows, state.tick, compacted)));
  assert.deepEqual(
    compactWorldState(compacted, { kind: "windows", archive: windows }),
    compacted,
    "compaction is idempotent",
  );
  assert.deepEqual(Object.keys(compacted.tasks).sort(), ["task:fresh", "task:held", "task:open"]);
  // `none` is still the identity rule, and an unknown kind is still refused.
  assert.deepEqual(compactWorldState(state, { kind: "none" }), state);
  assert.throws(() => compactWorldState(state, { kind: "everything" }), /Unsupported live compaction rule/);
  // Outside live mode the rule does not exist at all.
  assert.deepEqual(
    planLiveArchive({ mode: "logical" }, DEFAULT_GENESIS_CONFIG, 100, state),
    emptyLiveArchivePlan(),
  );
});

test("the boundary compaction is recorded, self-describing and part of the child's identity", async (t) => {
  const root = await tempDir(t, "anu-live-compaction-");
  const config = archivingConfig();
  const results = await runLiveUniverse({
    dataRoot: root,
    config,
    cognition: scriptedLiveCognition(),
    epochs: 2,
  });
  const child = openLiveEpochEvidence(root, LIVE_UNIVERSE_ID, results[1].runId);
  const childConfig = await child.readConfig();
  assert.deepEqual(childConfig.live.genesisFrom.compaction, {
    kind: "windows",
    archive: liveArchiveConfigOf(config),
  });
  assert.deepEqual(liveCompactionRule(config, undefined), childConfig.live.genesisFrom.compaction);

  // The inherited genesis is exactly what the rule produces from the parent's
  // final state, and `verifyLiveChain` re-derives it rather than trusting it.
  const parent = openLiveEpochEvidence(root, LIVE_UNIVERSE_ID, results[0].runId);
  const parentFinal = (await parent.readCheckpoints()).at(-1).state;
  const genesisState = await child.readGenesisState();
  assert.equal(
    hashValue(genesisState),
    hashValue(compactWorldState(parentFinal, childConfig.live.genesisFrom.compaction)),
  );
  assert.equal(hashValue(genesisState), childConfig.live.genesisFrom.genesisStateHash);
  const verified = await verifyLiveChain({ dataRoot: root });
  assert.equal(verified.epochs.length, 2);

  // The rule is inside `configHash`, so a universe that inherits verbatim is a
  // different chain, not the same chain run differently.
  const verbatimRoot = await tempDir(t, "anu-live-compaction-none-");
  const verbatim = await runLiveUniverse({
    dataRoot: verbatimRoot,
    config,
    cognition: scriptedLiveCognition(),
    epochs: 2,
    archive: { compaction: "none" },
  });
  assert.equal(verbatim[0].runId, results[0].runId, "epoch 0 inherits nothing, so it is the same epoch");
  assert.notEqual(verbatim[1].runId, results[1].runId, "the compaction rule is part of the child's identity");
  const verbatimConfig = await openLiveEpochEvidence(verbatimRoot, LIVE_UNIVERSE_ID, verbatim[1].runId).readConfig();
  assert.deepEqual(verbatimConfig.live.genesisFrom.compaction, { kind: "none" });
  await verifyLiveChain({ dataRoot: verbatimRoot });
});

/* ------------------------------------------------------------------ */
/* The measurement: 16 agents, 5 000 ticks, ten chained epochs          */
/* ------------------------------------------------------------------ */

/**
 * The one criterion that proves the world is *actually* bounded rather than
 * merely equipped with an archival function.
 *
 * The universe runs ten chained epochs of 500 absolute ticks with
 * `checkpointEvery` equal to the epoch length, so there is exactly one
 * checkpoint per epoch and the ten checkpoints of the run are the ten samples
 * — all at the same phase of an epoch, spanning the whole 5 000 ticks. If the
 * world were unbounded, the series would climb; the assertion is that all ten
 * lie within ±5 % of their mean, and that the mean per-tick wall time of the
 * last three epochs has not run away from the first three (the bound is loose,
 * at 2x, because wall time on a shared machine is noisy — what it catches is a
 * per-tick cost that scales with the history, which is what an unbounded world
 * produces).
 *
 * This is the longest test in the suite by a wide margin: it executes and then
 * semantically replays 5 000 ticks of a sixteen-agent world (each epoch is
 * replay-verified by `runGenesis` before it is attested). Its cost is stated in
 * `CHANGELOG.md`.
 */
test("16 agents over 5 000 ticks: checkpoint bytes plateau and per-tick time stays bounded", async (t) => {
  const root = await tempDir(t, "anu-live-bounded-");
  const epochTicks = 500;
  const epochs = 10;
  const resources = {
    credits: 100_000_000,
    llmTokens: 100_000_000,
    computeMs: 100_000_000,
    storageBytes: 100_000_000,
    bandwidthBytes: 100_000_000,
  };
  const config = liveTestConfig({
    agents: 16,
    ticks: epochTicks,
    metricEvery: 50,
    checkpointEvery: epochTicks,
    initialResources: resources,
    treasuryResources: resources,
    taskStream: {
      families: [...DEFAULT_GENESIS_CONFIG.taskStream.families],
      tasksPerTick: 4,
      deadlineTicks: 20,
      maxBacklog: 256,
    },
    live: {
      epochTicks,
      tiers: {
        fast: { pricePpm: 1_000_000 },
        standard: { pricePpm: 3_000_000 },
        deliberate: { pricePpm: 8_000_000 },
      },
      exhaustion: { minThinkTokens: 1_500, graceTicks: 20 },
      archive: { taskTicks: 100, messageTicks: 50, submissionTicks: 50 },
      fsyncEveryTick: false,
    },
  });

  const samples = [];
  let previous = process.hrtime.bigint();
  const results = await runLiveUniverse({
    dataRoot: root,
    config,
    cognition: rotatingLiveCognition({ agentsPerTick: 2 }),
    epochs,
    hooks: {
      onCheckpoint(checkpoint) {
        const now = process.hrtime.bigint();
        samples.push({
          tick: checkpoint.tick,
          bytes: Buffer.byteLength(JSON.stringify(checkpoint.state), "utf8"),
          msPerTick: Number(now - previous) / 1e6 / epochTicks,
          tasks: Object.keys(checkpoint.state.tasks).length,
          submissions: Object.keys(checkpoint.state.submissions).length,
          messages: Object.keys(checkpoint.state.messages).length,
          created: checkpoint.state.counters.tasksCreated,
        });
        previous = now;
      },
    },
  });

  assert.equal(results.length, epochs);
  assert.equal(results.at(-1).ticks, epochTicks * epochs);
  assert.equal(samples.length, epochs, "one checkpoint per epoch, at the epoch's final tick");
  const readout = samples
    .map((sample) => `t=${sample.tick} ${sample.bytes}B ${sample.msPerTick.toFixed(1)}ms/tick`
      + ` tasks=${sample.tasks} subs=${sample.submissions} msgs=${sample.messages} created=${sample.created}`)
    .join("\n");

  // The world kept working the whole time: lifetime totals grew by roughly the
  // same amount each epoch, so the plateau below is boundedness and not a
  // universe that quietly stopped doing anything.
  const created = samples.map((sample) => sample.created);
  assert.ok(created.at(-1) > created[0] * 5, `lifetime task total keeps growing:\n${readout}`);
  assert.ok(
    samples.at(-1).tasks > 0 && samples.at(-1).submissions > 0 && samples.at(-1).messages > 0,
    `all three archivable record kinds are live at the end:\n${readout}`,
  );

  const bytes = samples.map((sample) => sample.bytes);
  const mean = bytes.reduce((total, value) => total + value, 0) / bytes.length;
  const deviation = Math.max(...bytes.map((value) => Math.abs(value - mean))) / mean;
  assert.ok(
    deviation <= 0.05,
    `checkpoint bytes are on a plateau (max deviation ${(deviation * 100).toFixed(2)} % of ${mean.toFixed(0)}):\n${readout}`,
  );
  // The working set is bounded well below the history it summarises.
  assert.ok(
    samples.at(-1).created > samples.at(-1).tasks * 10,
    `the working set stays far below the lifetime history:\n${readout}`,
  );

  const perTick = samples.map((sample) => sample.msPerTick);
  const head = perTick.slice(0, 3).reduce((total, value) => total + value, 0) / 3;
  const tail = perTick.slice(-3).reduce((total, value) => total + value, 0) / 3;
  assert.ok(
    tail <= head * 2,
    `per-tick time stays bounded (first three epochs ${head.toFixed(1)} ms/tick, last three ${tail.toFixed(1)} ms/tick):\n${readout}`,
  );
  t.diagnostic(`bounded world over ${epochTicks * epochs} ticks:\n${readout}`);
});
