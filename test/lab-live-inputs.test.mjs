/**
 * Genesis-Live recorded inputs (design §4.F, phase L3b).
 *
 * What is proven here: external work enters the world from `tasks/inbox.jsonl`
 * as a recorded input and, having no hidden oracle, is allowed to outlive its
 * epoch and expire on its own ABSOLUTE tick; calibration work never crosses a
 * boundary even when the task source's deadlines are unbounded by the epoch; a
 * recorded verdict is committed verbatim BEFORE the evaluation it justifies
 * and pays a reward in proportion to its grade; the whole run replays
 * byte-for-byte with no provider and no grader anywhere; operator physics
 * apply on their own tick; and a record that steers one agent is refused by
 * the parser rather than honoured.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hashValue } from "../dist/lab/canonical.js";
import { PPM } from "../dist/lab/types.js";
import { externalTaskId, isExternalTask, proportionalReward } from "../dist/lab/epoch-rules.js";
import { ReplayEngine } from "../dist/lab/replay.js";
import { LiveIdlePolicy } from "../dist/lab/live/live-idle-policy.js";
import {
  openLiveEpochEvidence,
  runLiveUniverse,
  verifyLiveChain,
} from "../dist/lab/live/epoch.js";
import { LIVE_UNIVERSE_ID } from "../dist/lab/live/identity.js";
import {
  CompositeTaskSource,
  FileTaskSource,
  RecordedTaskSource,
  parseExternalTaskRecord,
} from "../dist/lab/live/task-source.js";
import {
  InboxEvaluator,
  LlmEvaluator,
  parseGraderQuality,
} from "../dist/lab/live/evaluator-port.js";
import {
  FilePressureSource,
  RecordedPressureSource,
  parsePressureRecord,
} from "../dist/lab/live/physics-inbox.js";
import { liveTestConfig, resignEventChain, scriptedLiveCognition } from "./live-fixture.mjs";

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

/** An agent that only looks: nothing is claimed, so nothing is submitted. */
function observingCognition(id = "cognition-live-test-v1:observing:cb65536") {
  return {
    id,
    cohort: "C",
    async propose(requests) {
      return requests.map((request) => ({
        tick: request.tick,
        agentId: request.agentId,
        cohort: "C",
        provider: "scripted",
        model: "scripted-live",
        content: JSON.stringify({ actions: [{ type: "observe" }] }),
        usage: { inputTokens: 4, outputTokens: 4, totalTokens: 8 },
        latencyMs: 1,
        actions: [{ type: "observe" }],
        tier: "fast",
      }));
    },
  };
}

/**
 * An agent that prefers recorded work: it claims an external task when one is
 * available and submits an answer for whatever it holds.
 */
function externalWorkerCognition(id = "cognition-live-test-v1:external:cb65536") {
  return {
    id,
    cohort: "C",
    async propose(requests) {
      return requests.map((request) => {
        const mine = request.observation.tasks.filter(
          (task) => task.status === "claimed" && task.claimedBy === request.agentId,
        );
        const available = request.observation.tasks.filter((task) => task.status === "available");
        const preferred = available.find((task) => task.family === "external") ?? available[0];
        const actions = mine.length > 0
          ? [{ type: "submit", taskId: mine[0].id, result: { answer: mine[0].id } }]
          : preferred === undefined
            ? [{ type: "observe" }]
            : [{ type: "claimTask", taskId: preferred.id }];
        return {
          tick: request.tick,
          agentId: request.agentId,
          cohort: "C",
          provider: "scripted",
          model: "scripted-live",
          content: JSON.stringify({ actions }),
          usage: { inputTokens: 4, outputTokens: 4, totalTokens: 8 },
          latencyMs: 1,
          actions,
          tier: "fast",
        };
      });
    },
  };
}

/** A grader that always returns the same grade. No network, no wall clock. */
function fakeGrader(qualityPpm) {
  let calls = 0;
  const completion = {
    async complete() {
      calls += 1;
      return {
        provider: "fake",
        model: "fake-grader",
        content: JSON.stringify({ qualityPpm, rationale: "meets the rubric in part" }),
        usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
        latencyMs: 1,
      };
    },
  };
  return { completion, calls: () => calls };
}

/* ------------------------------------------------------------------ */
/* External work: recorded in, crossing a boundary, expiring on its    */
/* own absolute tick                                                    */
/* ------------------------------------------------------------------ */

test("an inherited external task expires on its own absolute tick, and no calibration work crosses the boundary", async (t) => {
  const root = await tempDir(t, "anu-live-external-");
  const config = liveTestConfig();
  // Deliberately unbounded by the epoch: the task is created at tick 45 of a
  // 50-tick epoch and is due at absolute tick 60, eleven ticks into the next
  // one. A calibration task could never do this — its generation stops
  // `deadlineTicks + 1` before the end — which is exactly why this source is
  // what the boundary sweep has to be exercised against.
  const record = { tick: 45, deadlineTick: 60, slug: "cross", prompt: "p", rubric: "r" };
  const taskId = externalTaskId(45, 60, { kind: "external", slug: "cross", prompt: "p", rubric: "r" });

  const results = await runLiveUniverse({
    dataRoot: root,
    config,
    cognition: observingCognition(),
    taskSource: new RecordedTaskSource([record]),
    evaluator: new InboxEvaluator(join(root, "verdicts", "inbox.jsonl")),
    epochs: 2,
  });

  const first = await readEvents(root, results[0].runId);
  const created = first.filter((event) => event.type === "task.created" && event.data.source !== undefined);
  assert.equal(created.length, 1, "the recorded task enters exactly once");
  assert.equal(created[0].tick, 45, "a recorded task enters on the tick its record names");
  assert.equal(created[0].data.source, "external");
  assert.equal(created[0].data.task.id, taskId, "the id is the commitment to the record's content");
  assert.equal(created[0].data.task.family, "external");

  // It is NOT swept at the boundary: it carries no hidden oracle, so it is the
  // one kind of work that may outlive its epoch.
  const boundary = await openLiveEpochEvidence(root, LIVE_UNIVERSE_ID, results[0].runId)
    .readCheckpoint(results[0].ticks);
  const openAtBoundary = Object.values(boundary.state.tasks).filter(
    (task) => task.status === "available" || task.status === "claimed" || task.status === "submitted",
  );
  assert.deepEqual(
    openAtBoundary.map((task) => task.id),
    [taskId],
    "the external task crosses the boundary and nothing else does",
  );
  assert.equal(
    openAtBoundary.filter((task) => !isExternalTask(task)).length,
    0,
    "no calibration task — and therefore no hidden oracle — is open when the epoch ends",
  );
  assert.ok(openAtBoundary.length > 0, "the sweep check is not vacuous: something did cross");

  // Epoch 1 inherits it and expires it by its own absolute deadline, not by
  // any epoch-relative one: due at 60, expired on the first tick after that.
  const second = await readEvents(root, results[1].runId);
  const expiries = second.filter(
    (event) => event.type === "task.expired" && event.data.taskId === taskId,
  );
  assert.equal(expiries.length, 1);
  assert.equal(expiries[0].tick, 61, "an inherited external task expires on its own absolute tick");
  assert.equal(expiries[0].phase, "task_generation");
  assert.equal(expiries[0].data.reason, undefined, "it expires by deadline, not by the boundary sweep");

  const finalState = await openLiveEpochEvidence(root, LIVE_UNIVERSE_ID, results[1].runId)
    .readCheckpoint(results[1].ticks);
  assert.equal(finalState.state.tasks[taskId].status, "expired");
  assert.equal(finalState.state.counters.externalTasks, 1);

  // Both boundaries hold up under the full audit.
  const audit = await verifyLiveChain({ dataRoot: root });
  assert.equal(audit.epochs.length, 2);
  assert.equal(audit.finalStateHash, results[1].summary.finalStateHash);
});

/* ------------------------------------------------------------------ */
/* Verdicts                                                            */
/* ------------------------------------------------------------------ */

test("an external task graded qualityPpm 600000 pays a proportional reward, verdict first, and replays with no provider", async (t) => {
  const root = await tempDir(t, "anu-live-verdict-");
  const config = {
    ...liveTestConfig(),
    // Two non-zero reward resources, so a proportional payout is visible in
    // more than one dimension.
    acceptedTaskReward: {
      credits: 5, llmTokens: 5_000, computeMs: 0, storageBytes: 0, bandwidthBytes: 0,
    },
  };
  const grader = fakeGrader(600_000);
  const evaluator = new LlmEvaluator({ model: "fake-grader", completion: grader.completion });
  const [epoch] = await runLiveUniverse({
    dataRoot: root,
    config,
    cognition: externalWorkerCognition(),
    taskSource: new RecordedTaskSource([
      { tick: 2, deadlineTick: 40, slug: "grade-me", prompt: "p", rubric: "r" },
    ]),
    evaluator,
    epochs: 1,
  });

  const events = await readEvents(root, epoch.runId);
  const verdicts = events.filter((event) => event.type === "verdict.recorded");
  assert.equal(verdicts.length, 1, "one recorded verdict for the one piece of recorded work");
  const verdict = verdicts[0];
  assert.equal(verdict.phase, "evaluation");
  assert.equal(verdict.actorId, undefined, "a verdict is a system event: it grades, it does not act");
  assert.equal(verdict.data.evaluatorId, evaluator.id);
  assert.equal(
    verdict.data.content,
    JSON.stringify({ qualityPpm: 600_000, rationale: "meets the rubric in part" }),
    "the grader's answer is on record verbatim, not summarised",
  );
  assert.deepEqual(verdict.data.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 });

  const evaluated = events.filter(
    (event) => event.type === "task.evaluated" && event.data.evaluatorId !== undefined,
  );
  assert.equal(evaluated.length, 1);
  assert.equal(
    verdict.seq + 1,
    evaluated[0].seq,
    "verdict.recorded immediately precedes the task.evaluated it justifies",
  );
  assert.equal(evaluated[0].data.qualityPpm, 600_000);
  assert.equal(evaluated[0].data.accepted, true);
  assert.equal(evaluated[0].data.evaluatorId, evaluator.id);
  assert.equal(evaluated[0].data.taskId, verdict.data.taskId);

  // floor(5 × 0.6) = 3 credits; floor(5000 × 0.6) = 3000 llmTokens.
  const expectedReward = proportionalReward(config.acceptedTaskReward, 600_000);
  assert.deepEqual(expectedReward, {
    credits: 3, llmTokens: 3_000, computeMs: 0, storageBytes: 0, bandwidthBytes: 0,
  });
  const rewards = events.filter(
    (event) => event.type === "resource.transferred"
      && event.causationId === evaluated[0].eventId,
  );
  assert.deepEqual(
    rewards.map((event) => [event.data.resource, event.data.amount]),
    [["credits", 3], ["llmTokens", 3_000]],
    "the treasury pays in proportion to the recorded grade, never the whole reward",
  );
  for (const reward of rewards) {
    assert.equal(reward.phase, "evaluation");
    assert.equal(reward.data.reason, "accepted-task");
    assert.equal(reward.actorId, "@treasury");
    assert.equal(reward.targetId, evaluated[0].actorId);
  }
  assert.equal(grader.calls(), 1, "the grader was asked exactly once, while the epoch ran");

  // Byte-for-byte replay with no provider: the events file alone reproduces
  // the run, through the same verifier, with no cognition port and no
  // evaluator anywhere in the call.
  const store = openLiveEpochEvidence(root, LIVE_UNIVERSE_ID, epoch.runId);
  const manifest = await store.readManifest();
  const stored = await store.readConfig();
  const before = await readFile(store.eventsPath);
  const replay = await ReplayEngine.replayFile(store.eventsPath, manifest, stored, undefined, {
    live: { createFallbackPolicy: () => new LiveIdlePolicy() },
  });
  assert.equal(replay.stateHash, epoch.summary.finalStateHash);
  assert.equal(replay.finalEventHash, epoch.summary.finalEventHash);
  assert.equal(hashValue(replay.state), epoch.summary.finalStateHash);
  assert.equal(grader.calls(), 1, "replay never asks the grader again");
  assert.deepEqual(await readFile(store.eventsPath), before, "replay reads; it never writes");
  assert.equal(manifest.evaluatorId, evaluator.id, "the grader is part of the epoch's identity");

  // A verdict from another evaluator is not the one this manifest names. The
  // forged chain is re-signed, so the hash chain accepts it and only the
  // verifier's own rule is left to refuse it.
  const tampered = resignEventChain(events.map((event) => (
    event.seq === verdict.seq
      ? { ...event, data: { ...event.data, evaluatorId: "evaluator-llm-v1:other:0000" } }
      : event
  )));
  assert.throws(
    () => ReplayEngine.replay(tampered, manifest, stored, undefined, {
      live: { createFallbackPolicy: () => new LiveIdlePolicy() },
    }),
    /evaluator this manifest names/,
  );
});

test("a recorded grade is bounded, and an unparsable grader answer grades zero", () => {
  assert.equal(parseGraderQuality(JSON.stringify({ qualityPpm: 600_000 })), 600_000);
  assert.equal(parseGraderQuality("here you go: {\"qualityPpm\": 250000} thanks"), 250_000);
  assert.equal(parseGraderQuality("not json at all"), 0);
  assert.equal(parseGraderQuality(JSON.stringify({ qualityPpm: -5 })), 0);
  assert.equal(parseGraderQuality(JSON.stringify({ qualityPpm: PPM * 4 })), PPM);
  assert.deepEqual(proportionalReward(
    { credits: 5, llmTokens: 5_000, computeMs: 1, storageBytes: 0, bandwidthBytes: 0 },
    0,
  ), { credits: 0, llmTokens: 0, computeMs: 0, storageBytes: 0, bandwidthBytes: 0 });
});

/* ------------------------------------------------------------------ */
/* Operator physics                                                     */
/* ------------------------------------------------------------------ */

test("a pressure from physics/inbox.jsonl applies on its own tick", async (t) => {
  const root = await tempDir(t, "anu-live-physics-");
  const universeRoot = join(root, "genesis-live", LIVE_UNIVERSE_ID);
  await mkdir(join(universeRoot, "physics"), { recursive: true });
  const inbox = join(universeRoot, "physics", "inbox.jsonl");
  await writeFile(inbox, [
    JSON.stringify({ tick: 6, type: "task_load_multiplier", multiplierPpm: 2 * PPM }),
    JSON.stringify({ tick: 9, type: "resource_price_multiplier", resource: "credits", multiplierPpm: 3 * PPM }),
    JSON.stringify({ tick: 12, type: "retire_agent_fraction", fractionPpm: 250_000 }),
    "",
  ].join("\n"));

  const [epoch] = await runLiveUniverse({
    dataRoot: root,
    // Checkpoints every five ticks, so the state is on disk on both sides of
    // the ticks the records name.
    config: liveTestConfig({ checkpointEvery: 5 }),
    cognition: scriptedLiveCognition(),
    pressureSource: new FilePressureSource(inbox),
    epochs: 1,
  });

  const events = await readEvents(root, epoch.runId);
  const applied = events.filter((event) => event.type === "pressure.applied");
  assert.deepEqual(
    applied.map((event) => [event.tick, event.data.type]),
    [[6, "task_load_multiplier"], [9, "resource_price_multiplier"], [12, "retire_agent_fraction"]],
    "each recorded pressure applies on exactly the tick its record names",
  );
  for (const event of applied) assert.equal(event.phase, "pressure");

  const store = openLiveEpochEvidence(root, LIVE_UNIVERSE_ID, epoch.runId);
  const before = await store.readCheckpoint(5);
  const after = await store.readCheckpoint(10);
  assert.equal(before.state.physics.taskLoadPpm, PPM, "physics is untouched before the pressure's tick");
  assert.equal(before.state.physics.resourcePricePpm.credits, PPM);
  assert.equal(after.state.physics.taskLoadPpm, 2 * PPM);
  assert.equal(after.state.physics.resourcePricePpm.credits, 3 * PPM);

  // The share is the operator's; which agents it takes is not. The retirements
  // are drawn from `pressureRng` and caused by the pressure event.
  const retirement = applied.find((event) => event.data.type === "retire_agent_fraction");
  const retired = events.filter(
    (event) => event.type === "agent.retired" && event.causationId === retirement.eventId,
  );
  assert.equal(retired.length, 1, "25% of four agents is one");
  assert.deepEqual(retirement.data.retiredAgentIds, retired.map((event) => event.actorId));
  assert.equal(retired[0].data.reason, "pressure");
  assert.equal(retired[0].phase, "pressure");

  const audit = await verifyLiveChain({ dataRoot: root });
  assert.equal(audit.finalStateHash, epoch.summary.finalStateHash);

  // Aiming the retirement is not possible: the payload is regenerated from the
  // same forked RNG, so a hand-picked victim list is refused.
  const manifest = await store.readManifest();
  const stored = await store.readConfig();
  const forged = resignEventChain(events.map((event) => (
    event.seq === retirement.seq
      ? { ...event, data: { ...event.data, retiredAgentIds: ["N0001"] } }
      : event
  )));
  assert.throws(
    () => ReplayEngine.replay(forged, manifest, stored, undefined, {
      live: { createFallbackPolicy: () => new LiveIdlePolicy() },
    }),
    /recorded pressure data/,
  );
});

test("the parser refuses a record addressed to an agent — the control plane sets physics only", () => {
  // Physics.
  assert.throws(
    () => parsePressureRecord({
      tick: 6, type: "task_load_multiplier", multiplierPpm: 2 * PPM, agentId: "N0001",
    }),
    /control plane sets physics only, never who does what/,
  );
  for (const field of ["agent", "targetId", "assignTo", "assignee", "claimedBy", "onlyAgent", "to"]) {
    assert.throws(
      () => parsePressureRecord({ tick: 1, type: "task_load_multiplier", multiplierPpm: 1, [field]: "N0001" }),
      /control plane sets physics only/,
      `an operator cannot steer one agent through ${field}`,
    );
  }
  // External work: the backlog is common, never assigned.
  assert.throws(
    () => parseExternalTaskRecord({
      tick: 1, deadlineTick: 5, slug: "s", prompt: "p", rubric: "r", assignTo: "N0002",
    }),
    /control plane sets physics only/,
  );
  // And nothing else gets in either.
  assert.throws(
    () => parsePressureRecord({ tick: 1, type: "grant_credits", multiplierPpm: 1 }),
    /Unknown pressure type grant_credits/,
  );
  assert.throws(
    () => parsePressureRecord({ tick: 1, type: "task_load_multiplier", multiplierPpm: 1, note: "x" }),
    /unknown field note/,
  );
  assert.throws(
    () => parsePressureRecord({ tick: 1, type: "retire_agent_fraction", fractionPpm: PPM + 1 }),
    /at most 1,000,000 ppm/,
  );
  assert.throws(
    () => parseExternalTaskRecord({ tick: 1, deadlineTick: 5, slug: "s", prompt: "p" }),
    /non-empty string rubric/,
  );
  assert.throws(
    () => parseExternalTaskRecord({ tick: 5, deadlineTick: 5, slug: "s", prompt: "p", rubric: "r" }),
    /deadlineTick after its tick/,
  );
  assert.throws(
    () => parseExternalTaskRecord({ tick: 1, deadlineTick: 5, slug: "s", prompt: "p", rubric: "r", family: "arithmetic" }),
    /unknown field family/,
  );
});

test("a file inbox is read line by line, and a composite source admits within the bounded backlog", async (t) => {
  const root = await tempDir(t, "anu-live-inbox-");
  const path = join(root, "inbox.jsonl");
  await writeFile(path, [
    JSON.stringify({ tick: 2, deadlineTick: 30, slug: "a", prompt: "p", rubric: "r" }),
    "",
    JSON.stringify({ tick: 2, deadlineTick: 30, slug: "b", prompt: "p", rubric: "r" }),
    JSON.stringify({ tick: 7, deadlineTick: 30, slug: "c", prompt: "p", rubric: "r" }),
    "",
  ].join("\n"));
  const source = new FileTaskSource(path);

  assert.deepEqual((await source.next(1, 10)).map((task) => task.input.slug), []);
  assert.deepEqual((await source.next(2, 10)).map((task) => task.input.slug), ["a", "b"]);
  assert.deepEqual(
    (await source.next(2, 1)).map((task) => task.input.slug),
    ["a"],
    "the bounded world admits at most what the tick has room for",
  );
  assert.deepEqual((await source.next(7, 10)).map((task) => task.input.slug), ["c"]);

  // A missing inbox is an empty inbox, not a failure.
  assert.deepEqual(await new FileTaskSource(join(root, "absent.jsonl")).next(2, 10), []);

  // Two byte-identical records would produce one task id, which the world
  // could never admit twice; the parser says so instead of letting the world
  // discover it mid-tick.
  await writeFile(path, [
    JSON.stringify({ tick: 2, deadlineTick: 30, slug: "a", prompt: "p", rubric: "r" }),
    JSON.stringify({ tick: 2, deadlineTick: 30, slug: "a", prompt: "p", rubric: "r" }),
  ].join("\n"));
  await assert.rejects(() => new FileTaskSource(path).next(2, 10), /records .* twice/);

  const composite = new CompositeTaskSource([
    new RecordedTaskSource([{ tick: 4, deadlineTick: 30, slug: "x", prompt: "p", rubric: "r" }]),
    new RecordedTaskSource([{ tick: 4, deadlineTick: 30, slug: "y", prompt: "p", rubric: "r" }]),
  ]);
  assert.deepEqual((await composite.next(4, 10)).map((task) => task.input.slug), ["x", "y"]);
  assert.deepEqual(
    (await composite.next(4, 1)).map((task) => task.input.slug),
    ["x"],
    "capacity is shared across the composed sources, not multiplied",
  );

  // Malformed lines are refused rather than skipped.
  await writeFile(path, "{not json}\n");
  await assert.rejects(() => new FileTaskSource(path).next(1, 10), /line 1 is not JSON/);
  await writeFile(path, "[1,2,3]\n");
  await assert.rejects(() => new FileTaskSource(path).next(1, 10), /line 1 is not a JSON object/);
});

test("the verifier refuses a forged recorded task", async (t) => {
  const root = await tempDir(t, "anu-live-forged-");
  const [epoch] = await runLiveUniverse({
    dataRoot: root,
    config: liveTestConfig(),
    cognition: observingCognition(),
    taskSource: new RecordedTaskSource([
      { tick: 3, deadlineTick: 40, slug: "s", prompt: "p", rubric: "r" },
    ]),
    evaluator: new InboxEvaluator(join(root, "absent.jsonl")),
    epochs: 1,
  });
  const store = openLiveEpochEvidence(root, LIVE_UNIVERSE_ID, epoch.runId);
  const manifest = await store.readManifest();
  const stored = await store.readConfig();
  const events = await readEvents(root, epoch.runId);
  const created = events.find((event) => event.data.source === "external");

  // Every forgery below is re-signed, so the hash chain accepts it and the
  // refusal that remains is the verifier's own rule.
  const replayWith = (mutate) => ReplayEngine.replay(
    resignEventChain(
      events.map((event) => (event.seq === created.seq ? mutate(structuredClone(event)) : event)),
    ),
    manifest,
    stored,
    undefined,
    { live: { createFallbackPolicy: () => new LiveIdlePolicy() } },
  );

  // The id commits to the content, so the prompt cannot be swapped after the
  // fact — and the id cannot be relabelled either.
  assert.throws(() => replayWith((event) => {
    event.data.task.input.prompt = "something else entirely";
    return event;
  }), /commitment to its own content/);
  assert.throws(() => replayWith((event) => {
    event.data.task.deadlineTick += 100;
    return event;
  }), /commitment to its own content/);
  // An arbitrary family cannot ride in on the recorded-input path.
  assert.throws(() => replayWith((event) => {
    event.data.task.family = "arithmetic";
    return event;
  }), /external/);
});
