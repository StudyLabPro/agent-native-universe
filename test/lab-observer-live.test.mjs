import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EvidenceStore } from "../dist/lab/artifacts.js";
import { DEFAULT_GENESIS_CONFIG } from "../dist/lab/config.js";
import { runGenesis } from "../dist/lab/genesis.js";
import { startObserverServer } from "../dist/lab/observer.js";
import { applyWorldEventMutable, initialWorldState } from "../dist/lab/reducer.js";

const AUTH_TOKEN = "anu_observer_live_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function stateProjectionConfig(seed) {
  const config = structuredClone(DEFAULT_GENESIS_CONFIG);
  config.seed = seed;
  config.ticks = 6;
  config.metricEvery = 2;
  config.checkpointEvery = 2;
  return config;
}

async function startFixture(t, dataDir, authToken) {
  const options = { dataDir, host: "127.0.0.1", port: 0 };
  if (authToken !== undefined) options.authToken = authToken;
  const server = await startObserverServer(options);
  t.after(async () => {
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
    });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

async function replayExpectedState(manifestPath, eventsPath) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const eventsText = await readFile(eventsPath, "utf8");
  const lines = eventsText.trim().length === 0 ? [] : eventsText.trim().split("\n");
  let state = initialWorldState(manifest);
  for (const line of lines) {
    state = applyWorldEventMutable(state, JSON.parse(line));
  }
  return state;
}

test("observer projects run state from a checkpoint plus tail events, matching full replay", async (t) => {
  const runsRoot = await mkdtemp(join(tmpdir(), "anu-observer-live-state-"));
  t.after(() => rm(runsRoot, { recursive: true, force: true }));

  const config = stateProjectionConfig("observer-live-state-projection");
  const summary = await runGenesis({ config, runsRoot, universeId: "U0001" });
  const evidence = await EvidenceStore.openExisting(runsRoot, config.experimentId, "U0001", summary.runId);
  const expectedState = await replayExpectedState(evidence.manifestPath, evidence.eventsPath);

  // world.ts always emits a final checkpoint at run.completed, in addition to
  // the periodic ones at tick % checkpointEvery === 0. Remove it so the
  // fixture actually exercises checkpoint-plus-tail projection (checkpoint at
  // tick 4, then tail events through completion at tick 6) rather than the
  // degenerate checkpoint-only case.
  await rm(evidence.checkpointPath(summary.ticks));

  const baseUrl = await startFixture(t, runsRoot);

  const headResponse = await fetch(`${baseUrl}/api/runs/${summary.runId}/head`);
  assert.equal(headResponse.status, 200);
  const head = await headResponse.json();
  assert.deepEqual(head, {
    runId: summary.runId,
    lastSeq: summary.events,
    lastTick: summary.ticks,
    eventsBytes: head.eventsBytes,
    latestCheckpointTick: 4,
    completed: true,
  });
  assert.equal(typeof head.eventsBytes, "number");
  assert.ok(head.eventsBytes > 0);
  const headEtag = headResponse.headers.get("etag");
  assert.ok(headEtag && headEtag.length > 0);

  const stateResponse = await fetch(`${baseUrl}/api/runs/${summary.runId}/state`);
  assert.equal(stateResponse.status, 200);
  const projected = await stateResponse.json();
  assert.equal(projected.runId, summary.runId);
  assert.equal(projected.tick, summary.ticks);
  assert.equal(projected.seq, summary.events);
  assert.deepEqual(projected.state, expectedState);
  const stateEtag = stateResponse.headers.get("etag");
  assert.ok(stateEtag && stateEtag.length > 0);
  // The state route's ETag is the event log's identity, shared with /events and /head.
  assert.equal(stateEtag, headEtag);

  const eventsResponse = await fetch(`${baseUrl}/api/runs/${summary.runId}/events?after=0&limit=1`);
  assert.equal(eventsResponse.status, 200);
  assert.equal(eventsResponse.headers.get("etag"), headEtag);

  for (const path of [
    `/api/runs/${summary.runId}/head`,
    `/api/runs/${summary.runId}/state`,
    `/api/runs/${summary.runId}/events?after=0&limit=1`,
  ]) {
    const conditional = await fetch(`${baseUrl}${path}`, { headers: { "If-None-Match": headEtag } });
    assert.equal(conditional.status, 304, path);
    assert.equal(await conditional.text(), "");
    assert.equal(conditional.headers.get("etag"), headEtag);

    const mismatched = await fetch(`${baseUrl}${path}`, { headers: { "If-None-Match": '"stale-etag-value"' } });
    assert.equal(mismatched.status, 200, path);
  }
});

test("observer state and head routes fail closed on missing runs and oversized checkpoints", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "anu-observer-live-bounds-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const oversizedRunDirectory = join(dataDir, "runs", "genesis-1", "U0001");
  await mkdir(oversizedRunDirectory, { recursive: true });
  await writeJson(join(oversizedRunDirectory, "manifest.json"), {
    schemaVersion: 1,
    experimentId: "genesis-1",
    engineVersion: "genesis-logical-v1.1.0",
    mode: "logical",
    policyId: "neutral-backpressure-v1",
    taskGeneratorId: "deterministic-task-stream-v1",
    runId: "oversized-checkpoint-run",
    universeId: "U0001",
    seed: "seed-oversized",
    configHash: "0".repeat(64),
  });
  await mkdir(join(oversizedRunDirectory, "checkpoints"), { recursive: true });
  await writeJson(join(oversizedRunDirectory, "checkpoints", "0.json"), {
    schemaVersion: 1,
    runId: "oversized-checkpoint-run",
    universeId: "U0001",
    tick: 0,
    seq: 0,
    eventHash: "1".repeat(64),
    stateHash: "2".repeat(64),
    state: { padding: "x".repeat(9_000_000) },
  });

  const oversizedResponseDirectory = join(dataDir, "runs", "genesis-1", "U0002");
  await mkdir(oversizedResponseDirectory, { recursive: true });
  await writeJson(join(oversizedResponseDirectory, "manifest.json"), {
    schemaVersion: 1,
    experimentId: "genesis-1",
    engineVersion: "genesis-logical-v1.1.0",
    mode: "logical",
    policyId: "neutral-backpressure-v1",
    taskGeneratorId: "deterministic-task-stream-v1",
    runId: "oversized-response-run",
    universeId: "U0002",
    seed: "seed-oversized-response",
    configHash: "1".repeat(64),
  });
  await mkdir(join(oversizedResponseDirectory, "checkpoints"), { recursive: true });
  await writeJson(join(oversizedResponseDirectory, "checkpoints", "0.json"), {
    schemaVersion: 1,
    runId: "oversized-response-run",
    universeId: "U0002",
    tick: 0,
    seq: 0,
    eventHash: "1".repeat(64),
    stateHash: "2".repeat(64),
    state: { padding: "x".repeat(4_500_000) },
  });

  const baseUrl = await startFixture(t, dataDir);

  for (const path of ["head", "state"]) {
    const response = await fetch(`${baseUrl}/api/runs/missing-run/${path}`);
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: "run_not_found" });
  }

  const checkpointTooLarge = await fetch(`${baseUrl}/api/runs/oversized-checkpoint-run/state`);
  assert.equal(checkpointTooLarge.status, 413);
  assert.deepEqual(await checkpointTooLarge.json(), { error: "artifact_too_large" });

  const responseTooLarge = await fetch(`${baseUrl}/api/runs/oversized-response-run/state`);
  assert.equal(responseTooLarge.status, 413);
  assert.deepEqual(await responseTooLarge.json(), { error: "state_too_large" });
});

test("observer live head, /api/runs/:id/head and /api/runs/:id/state require Bearer auth when configured", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "anu-observer-live-auth-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const baseUrl = await startFixture(t, dataDir, AUTH_TOKEN);

  for (const path of ["/api/live", "/api/runs/missing/head", "/api/runs/missing/state"]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 401, path);
    assert.equal(response.headers.get("www-authenticate"), 'Bearer realm="anu-lab-observer"');
    assert.deepEqual(await response.json(), { error: "unauthorized" });
  }

  const authorizedLive = await fetch(`${baseUrl}/api/live`, {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  });
  assert.equal(authorizedLive.status, 200);
});

test("observer live head defaults safely when the live universe has not started", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "anu-observer-live-empty-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(dataDir, { recursive: true });

  const baseUrl = await startFixture(t, dataDir);
  const response = await fetch(`${baseUrl}/api/live`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    experimentId: "genesis-live",
    universeId: "U0001",
    currentRunId: null,
    epoch: null,
    head: { lastSeq: null, lastTick: null },
    boundary: false,
    cognitionHealth: { window: 50, consulted: 0, unavailable: 0, starved: 0 },
    chain: [],
  });
});

test("observer live head merges chain and anchors, windows cognitionHealth, and skips reserved directories", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "anu-observer-live-head-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const universeRoot = join(dataDir, "genesis-live", "U0001");

  // Reserved live-universe directories that discovery must skip without error.
  await mkdir(join(universeRoot, "tasks"), { recursive: true });
  await writeFile(join(universeRoot, "tasks", "inbox.jsonl"), `${JSON.stringify({ family: "external" })}\n`, "utf8");
  await mkdir(join(universeRoot, "verdicts"), { recursive: true });
  await writeFile(join(universeRoot, "verdicts", "inbox.jsonl"), "not-even-json\n", "utf8");
  await mkdir(join(universeRoot, "physics"), { recursive: true });
  await writeFile(join(universeRoot, "physics", "inbox.jsonl"), `${JSON.stringify({ type: "pressure" })}\n`, "utf8");

  // Epoch 0: completed and chained.
  const epochZeroDirectory = join(universeRoot, "epoch-0-run");
  await mkdir(epochZeroDirectory, { recursive: true });
  await writeJson(join(epochZeroDirectory, "manifest.json"), {
    schemaVersion: 1,
    experimentId: "genesis-live",
    runId: "epoch-0-run",
    universeId: "U0001",
  });
  await writeJson(join(epochZeroDirectory, "summary.json"), {
    schemaVersion: 1,
    runId: "epoch-0-run",
    ticks: 50,
    events: 4,
  });
  await writeFile(
    join(epochZeroDirectory, "events.jsonl"),
    [
      { seq: 1, tick: 0, type: "run.started", data: {} },
      { seq: 2, tick: 25, type: "cognition.recorded", data: { provider: "kimi-k2-6" } },
      { seq: 3, tick: 50, type: "run.completed", data: {} },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );

  await mkdir(join(universeRoot, "chain"), { recursive: true });
  await writeJson(join(universeRoot, "chain", "0.json"), {
    epoch: 0,
    runId: "epoch-0-run",
    parentRunId: null,
    commitment: "c".repeat(64),
    parentCommitment: null,
    engineVersion: "genesis-live-v1.0.0",
    cognitionId: "cognition-live-v1:test",
  });
  await mkdir(join(universeRoot, "anchors"), { recursive: true });
  await writeJson(join(universeRoot, "anchors", "0.json"), {
    epoch: 0,
    runId: "epoch-0-run",
    anchoredAt: 1234567,
  });

  // Epoch 1: in progress, not yet chained. Tail event pins the head at tick 100;
  // the windowed cognitionHealth (last 50 ticks) must exclude the tick-10 record.
  const epochOneDirectory = join(universeRoot, "epoch-1-run");
  await mkdir(epochOneDirectory, { recursive: true });
  await writeJson(join(epochOneDirectory, "manifest.json"), {
    schemaVersion: 1,
    experimentId: "genesis-live",
    runId: "epoch-1-run",
    universeId: "U0001",
  });
  await writeFile(
    join(epochOneDirectory, "events.jsonl"),
    [
      { seq: 1, tick: 10, type: "cognition.recorded", data: { provider: "starved" } },
      { seq: 2, tick: 55, type: "cognition.recorded", data: { provider: "kimi-k2-6" } },
      { seq: 3, tick: 60, type: "cognition.recorded", data: { provider: "unavailable" } },
      { seq: 4, tick: 100, type: "tick.completed", data: {} },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );

  const baseUrl = await startFixture(t, dataDir);

  const liveResponse = await fetch(`${baseUrl}/api/live`);
  assert.equal(liveResponse.status, 200);
  const live = await liveResponse.json();
  assert.equal(live.experimentId, "genesis-live");
  assert.equal(live.universeId, "U0001");
  assert.equal(live.currentRunId, "epoch-1-run");
  assert.equal(live.epoch, 1);
  assert.equal(live.boundary, false);
  assert.deepEqual(live.head, { lastSeq: 4, lastTick: 100 });
  assert.deepEqual(live.cognitionHealth, { window: 50, consulted: 1, unavailable: 1, starved: 0 });
  assert.deepEqual(live.chain, [
    {
      epoch: 0,
      runId: "epoch-0-run",
      commitment: "c".repeat(64),
      engineVersion: "genesis-live-v1.0.0",
      anchoredAt: 1234567,
    },
  ]);

  // Discovery still lists real runs (including the in-progress one) and never
  // mistakes a reserved directory (tasks/verdicts/physics/chain/anchors) for one.
  const runsResponse = await fetch(`${baseUrl}/api/runs`);
  assert.equal(runsResponse.status, 200);
  const runs = await runsResponse.json();
  assert.deepEqual(
    runs.runs.map((run) => [run.runId, run.completed]).sort(),
    [["epoch-0-run", true], ["epoch-1-run", false]],
  );
});

test("observer live head reports boundary:true once the current epoch finishes but is not yet chained", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "anu-observer-live-boundary-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const universeRoot = join(dataDir, "genesis-live", "U0001");

  const chainedDirectory = join(universeRoot, "epoch-0-run");
  await mkdir(chainedDirectory, { recursive: true });
  await writeJson(join(chainedDirectory, "manifest.json"), {
    schemaVersion: 1,
    experimentId: "genesis-live",
    runId: "epoch-0-run",
    universeId: "U0001",
  });
  await writeJson(join(chainedDirectory, "summary.json"), { schemaVersion: 1, runId: "epoch-0-run", ticks: 10, events: 2 });
  await mkdir(join(universeRoot, "chain"), { recursive: true });
  await writeJson(join(universeRoot, "chain", "0.json"), {
    epoch: 0,
    runId: "epoch-0-run",
    commitment: "d".repeat(64),
    engineVersion: "genesis-live-v1.0.0",
  });

  // Epoch 1 has already run.completed (summary.json exists) but the boundary
  // transition has not yet written chain/1.json — the classic mid-transition
  // window the honesty contract calls "epoch boundary".
  const finishedUnchainedDirectory = join(universeRoot, "epoch-1-run");
  await mkdir(finishedUnchainedDirectory, { recursive: true });
  await writeJson(join(finishedUnchainedDirectory, "manifest.json"), {
    schemaVersion: 1,
    experimentId: "genesis-live",
    runId: "epoch-1-run",
    universeId: "U0001",
  });
  await writeJson(join(finishedUnchainedDirectory, "summary.json"), { schemaVersion: 1, runId: "epoch-1-run", ticks: 20, events: 2 });
  await writeFile(
    join(finishedUnchainedDirectory, "events.jsonl"),
    [
      { seq: 1, tick: 11, type: "run.started", data: {} },
      { seq: 2, tick: 20, type: "run.completed", data: {} },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );

  const baseUrl = await startFixture(t, dataDir);
  const response = await fetch(`${baseUrl}/api/live`);
  assert.equal(response.status, 200);
  const live = await response.json();
  assert.equal(live.currentRunId, "epoch-1-run");
  assert.equal(live.epoch, 1);
  assert.equal(live.boundary, true);
  assert.deepEqual(live.head, { lastSeq: 2, lastTick: 20 });
});
