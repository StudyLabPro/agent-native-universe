/**
 * Crash safety of the Genesis-Live epoch boundary (design §4.B, phase L3a).
 *
 * The boundary `k → k+1` is a pure function of the disk state: every step
 * checks for its artifact and writes only what is missing, identical bytes are
 * tolerated and differing bytes are a conflict. These tests kill a real
 * process with SIGKILL at each of the design's four kill points and at a tick
 * boundary inside an epoch, then let a fresh process continue — and require
 * the resulting universe to be indistinguishable from one that was never
 * interrupted: the same run ids, the same first-tick state hash of the next
 * epoch, the same final hashes and the same commitments.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { LiveChainIndex } from "../dist/lab/artifacts.js";
import { ReplayEngine } from "../dist/lab/replay.js";
import {
  liveReplayProjection,
  openLiveEpochEvidence,
  runLiveEpoch,
  runLiveUniverse,
  verifyLiveChain,
} from "../dist/lab/live/epoch.js";
import { LIVE_UNIVERSE_ID } from "../dist/lab/live/identity.js";
import { liveTestConfig, scriptedLiveCognition } from "./live-fixture.mjs";

const driverPath = fileURLToPath(new URL("./live-crash-driver.mjs", import.meta.url));

async function tempDir(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** Run the chain in a child process that kills itself at `crashAt`. */
function runUntilCrash(root, crashAt, epochs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [driverPath], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ANU_LIVE_CRASH_ROOT: root,
        ANU_LIVE_CRASH_AT: crashAt,
        ANU_LIVE_CRASH_EPOCHS: String(epochs),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

/** How many epochs the universe has already linked into its chain. */
async function chainLength(root) {
  try {
    const entries = await readdir(join(root, "genesis-live", LIVE_UNIVERSE_ID, "chain"));
    return entries.filter((entry) => /^\d+\.json$/.test(entry)).length;
  } catch {
    return 0;
  }
}

/**
 * Continue the universe until it has `target` linked epochs. How much work
 * that takes depends on where the process was killed, which is exactly what
 * the boundary being derived from the disk state means.
 */
async function resumeUntil(root, target) {
  while (await chainLength(root) < target) {
    await runLiveEpoch({
      dataRoot: root,
      config: liveTestConfig(),
      cognition: scriptedLiveCognition(),
      recoverStaleLease: true,
    });
  }
}

/** An uninterrupted chain of `epochs` epochs, for comparison. */
async function controlChain(t, epochs) {
  const root = await tempDir(t, "anu-live-control-");
  await runLiveUniverse({
    dataRoot: root,
    config: liveTestConfig(),
    cognition: scriptedLiveCognition(),
    epochs,
  });
  return { root, audit: await verifyLiveChain({ dataRoot: root }) };
}

/**
 * The state hash after the first tick of an epoch — the value the design
 * requires a restart from any kill point to converge to.
 */
async function firstTickStateHash(root, runId) {
  const store = openLiveEpochEvidence(root, LIVE_UNIVERSE_ID, runId);
  const manifest = await store.readManifest();
  const config = await store.readConfig();
  const genesisState = await store.readGenesisState();
  const startTick = config.live.genesisFrom?.tick ?? 0;
  const replay = await ReplayEngine.replayFile(
    store.eventsPath,
    manifest,
    config,
    startTick + 1,
    liveReplayProjection(genesisState),
  );
  assert.equal(replay.lastTick, startTick + 1);
  return replay.stateHash;
}

function comparableAudit(audit) {
  return audit.epochs.map((epoch) => ({
    epoch: epoch.epoch,
    runId: epoch.runId,
    startTick: epoch.startTick,
    ticks: epoch.ticks,
    stateHash: epoch.stateHash,
    eventHash: epoch.eventHash,
    commitment: epoch.commitment,
    events: epoch.events,
  }));
}

test("kill -9 inside an epoch resumes that epoch and produces the hashes of an uninterrupted chain", async (t) => {
  const control = await controlChain(t, 3);
  const root = await tempDir(t, "anu-live-crash-mid-");

  // Tick 70 is a durable boundary inside epoch 1 (absolute ticks 51..100).
  const crashed = await runUntilCrash(root, "checkpoint:70", 3);
  assert.equal(crashed.signal, "SIGKILL", `driver output: ${crashed.stderr}`);
  const lock = join(root, "genesis-live", LIVE_UNIVERSE_ID, control.audit.epochs[1].runId, ".runner.lock");
  await assert.doesNotReject(() => stat(lock), "the killed writer leaves its lease behind");

  // A fresh process finishes the interrupted epoch and continues the chain.
  await resumeUntil(root, 3);

  const audit = await verifyLiveChain({ dataRoot: root });
  assert.deepEqual(comparableAudit(audit), comparableAudit(control.audit));
  assert.equal(audit.finalStateHash, control.audit.finalStateHash);
  assert.equal(audit.finalTick, 150);
});

test("kill -9 at each of the four boundary points converges to the same next epoch", async (t) => {
  const control = await controlChain(t, 2);
  const controlRunId = control.audit.epochs[1].runId;
  const controlFirstTick = await firstTickStateHash(control.root, controlRunId);

  // The four points the design names, in the order they are reached:
  // after `run.completed` (the final checkpoint of epoch 0 is written right
  // after it), after `summary.json`/`attestations/final.json`, after
  // `chain/0.json`, and after `genesis.json`+`manifest.json` of epoch 1 but
  // before its `run.started`.
  const points = [
    ["after run.completed", "checkpoint:50"],
    ["after summary.json", "step:epoch_attested:0"],
    ["after chain/0.json", "step:chain_linked:0"],
    ["after genesis.json of epoch 1", "step:genesis_written:1"],
  ];

  for (const [label, crashAt] of points) {
    const root = await tempDir(t, "anu-live-crash-boundary-");
    const crashed = await runUntilCrash(root, crashAt, 2);
    assert.equal(crashed.signal, "SIGKILL", `${label}: driver output ${crashed.stderr}`);

    await resumeUntil(root, 2);

    const audit = await verifyLiveChain({ dataRoot: root });
    assert.deepEqual(comparableAudit(audit), comparableAudit(control.audit), `${label}: chain differs`);
    assert.equal(audit.epochs[1].runId, controlRunId, `${label}: epoch 1 has a different run id`);
    assert.equal(
      await firstTickStateHash(root, audit.epochs[1].runId),
      controlFirstTick,
      `${label}: epoch 1 starts from a different state`,
    );
  }
});

test("repeating a boundary step is tolerated; contradicting one is a conflict", async (t) => {
  const root = await tempDir(t, "anu-live-conflict-");
  const [first, second] = await runLiveUniverse({
    dataRoot: root,
    config: liveTestConfig(),
    cognition: scriptedLiveCognition(),
    epochs: 2,
  });

  assert.equal(
    await openLiveEpochEvidence(root, LIVE_UNIVERSE_ID, first.runId).readGenesisState(),
    undefined,
    "epoch 0 has no inherited genesis",
  );
  const child = openLiveEpochEvidence(root, LIVE_UNIVERSE_ID, second.runId);
  const genesisState = await child.readGenesisState();
  assert.equal(genesisState.tick, first.ticks);
  assert.equal(genesisState.runId, first.runId);
  // Step 4 repeated after a crash writes identical bytes; a different
  // inherited world would be a conflict, never a silent overwrite.
  await assert.doesNotReject(() => child.writeGenesisState(genesisState));
  await assert.rejects(
    () => child.writeGenesisState({ ...genesisState, tick: genesisState.tick + 1 }),
    /Refusing to replace existing genesis state/,
  );

  // Step 3 behaves the same way, and the index refuses a gap.
  const index = new LiveChainIndex(root, "genesis-live", LIVE_UNIVERSE_ID);
  await assert.doesNotReject(() => index.writeLink(second.link));
  await assert.rejects(
    () => index.writeLink({ ...second.link, stateHash: "0".repeat(64) }),
    /Refusing to replace existing chain link 1/,
  );
  await assert.rejects(
    () => index.writeLink({ ...second.link, epoch: 5 }),
    /has no parent link/,
  );
});
