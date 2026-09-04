/**
 * The Genesis-Live supervisor (design §4.H, phase L3c).
 *
 * What is proven here — the properties the guards exist for, and the one
 * property they must not violate:
 *
 *  - a provider that returns nothing but failures pauses the universe after
 *    `outageTicks` ticks, at a **tick boundary** and never mid-tick;
 *  - while the universe is paused, the append-only evidence does not change by
 *    one byte — in particular not one `task.expired`, which is the failure the
 *    outage guard exists to prevent (a 500-tick epoch flying past during an
 *    outage, expiring its whole backlog);
 *  - once the provider recovers, the same epoch continues from the boundary it
 *    stopped at and completes;
 *  - **the pause leaves no trace in the evidence**: the paused-and-resumed
 *    epoch has the same final event hash, state hash and attestation
 *    commitment as an epoch that ran the same recorded answers without ever
 *    pausing. The supervisor's observations — free bytes, provider health,
 *    elapsed milliseconds — decide when the world advances and nothing else;
 *  - the disk guard stops a universe *before* it writes anything when the
 *    volume is already low, and at the next tick boundary when it runs low
 *    mid-epoch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  openLiveEpochEvidence,
  planLiveEpoch,
  runLiveEpoch,
  verifyLiveChain,
} from "../dist/lab/live/epoch.js";
import {
  LIVE_DEFAULT_OUTAGE_TICKS,
  LiveSupervisor,
  LiveSupervisorGaveUpError,
  assertLiveSupervisorOptions,
} from "../dist/lab/live/supervisor.js";
import { failingLiveCognition, liveTestConfig, scriptedLiveCognition } from "./live-fixture.mjs";

async function tempDir(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A short universe: enough ticks to trip a guard and finish afterwards. */
function supervisedConfig() {
  const base = liveTestConfig();
  return liveTestConfig({
    ticks: 20,
    live: { ...base.live, epochTicks: 20, fsyncEveryTick: false },
  });
}

/**
 * A provider that is down until `outage.down` is cleared. Both halves are the
 * fixture's own deterministic cognitions, so the recorded answers of a paused
 * run and of an unpaused run with the same outage window are identical.
 */
function switchableCognition(outage) {
  const healthy = scriptedLiveCognition();
  const broken = failingLiveCognition();
  return {
    id: healthy.id,
    cohort: "C",
    propose: (requests, signal) => (outage.down ? broken : healthy).propose(requests, signal),
  };
}

function countType(text, type) {
  return text.split("\n").filter((line) => line.includes(`"type":"${type}"`)).length;
}

test("a provider outage pauses the universe at a tick boundary and commits nothing while paused", async (t) => {
  const root = await tempDir(t, "anu-live-outage-");
  const config = supervisedConfig();
  const outage = { down: true };
  const cognition = switchableCognition(outage);

  // The run id is a pure function of the config, so the evidence path is known
  // before the first event: that is what lets the test watch the file *while*
  // the universe is paused.
  const plan = await planLiveEpoch({ dataRoot: root, config, cognition });
  const store = openLiveEpochEvidence(root, "U0001", plan.manifest.runId);

  const pauses = [];
  const resumes = [];
  const duringPause = [];
  let probes = 0;
  let waits = 0;
  const result = await runLiveEpoch({
    dataRoot: root,
    config,
    cognition,
    supervisor: {
      outageTicks: 3,
      probeIntervalMs: 1,
      maxProbeRounds: 20,
      probe: async () => {
        probes += 1;
        return !outage.down;
      },
      // Every probe round is one observation of the evidence while paused.
      wait: async () => {
        waits += 1;
        duringPause.push(await readFile(store.eventsPath, "utf8"));
        if (waits >= 3) outage.down = false;
      },
      onPause: (pause) => pauses.push(pause),
      onResume: (pause) => resumes.push(pause),
    },
  });

  assert.equal(pauses.length, 1, "the universe pauses exactly once");
  assert.equal(resumes.length, 1);
  assert.equal(pauses[0].reason, "provider_outage");
  // Three failing ticks, decided at the end of the third — never mid-tick.
  assert.equal(pauses[0].tick, 3);
  assert.match(pauses[0].detail, /3 consecutive ticks without a consulted answer/);
  assert.equal(probes, 3, "the pause ends on the first probe that reports health");
  assert.equal(waits, 3);

  // Not one byte of evidence moved while the universe was paused.
  assert.equal(duringPause.length, 3);
  assert.equal(new Set(duringPause).size, 1, "the event log is byte-identical throughout the pause");
  for (const snapshot of duringPause) {
    assert.equal(countType(snapshot, "task.expired"), 0, "no task expired while the universe was paused");
    assert.equal(countType(snapshot, "tick.completed"), 3, "the clock stopped at the boundary of tick 3");
  }

  // The epoch finished, and the assertion above is not vacuous: this universe
  // does expire tasks — just not while it is paused.
  const events = await readFile(store.eventsPath, "utf8");
  assert.equal(result.ticks, 20);
  assert.ok(countType(events, "task.expired") > 0, "the epoch expires tasks once it is running again");
  assert.equal(countType(events, "tick.completed"), 20);
  await verifyLiveChain({ dataRoot: root });

  // The pause left no trace. An epoch that ran the same recorded answers
  // without a supervisor produces the same evidence, hash for hash.
  const cleanRoot = await tempDir(t, "anu-live-outage-clean-");
  const clean = await runLiveEpoch({
    dataRoot: cleanRoot,
    config,
    // The same outage window, replayed by tick number instead of by a guard.
    cognition: {
      id: cognition.id,
      cohort: "C",
      propose: (requests, signal) => (
        (requests[0]?.tick ?? 0) <= 3 ? failingLiveCognition() : scriptedLiveCognition()
      ).propose(requests, signal),
    },
  });
  assert.equal(clean.runId, result.runId, "a pause does not change the epoch's identity");
  assert.equal(clean.summary.finalEventHash, result.summary.finalEventHash);
  assert.equal(clean.summary.finalStateHash, result.summary.finalStateHash);
  assert.equal(clean.link.commitment, result.link.commitment);
});

test("the disk guard refuses to start a universe on a full volume, and writes nothing while it waits", async (t) => {
  const root = await tempDir(t, "anu-live-disk-start-");
  const config = supervisedConfig();
  const cognition = scriptedLiveCognition();
  const plan = await planLiveEpoch({ dataRoot: root, config, cognition });
  const store = openLiveEpochEvidence(root, "U0001", plan.manifest.runId);

  const disk = { free: 512 };
  const pauses = [];
  const resumes = [];
  let waits = 0;
  const result = await runLiveEpoch({
    dataRoot: root,
    config,
    cognition,
    supervisor: {
      outageTicks: 0,
      minFreeBytes: 4_096,
      probeIntervalMs: 1,
      maxProbeRounds: 20,
      freeBytes: async () => disk.free,
      wait: async () => {
        waits += 1;
        // While the guard holds, the universe has not written one event —
        // the epoch's evidence does not exist at all yet.
        await assert.rejects(() => stat(store.eventsPath), { code: "ENOENT" });
        if (waits >= 2) disk.free = 1_048_576;
      },
      onPause: (pause) => pauses.push(pause),
      onResume: (pause) => resumes.push(pause),
    },
  });

  assert.equal(pauses.length, 1);
  assert.equal(pauses[0].reason, "low_disk");
  assert.match(pauses[0].detail, /512 free bytes below the 4096-byte floor/);
  assert.equal(pauses[0].tick, undefined, "the guard tripped before the universe had a tick");
  assert.equal(resumes.length, 1);
  assert.equal(waits, 2);
  assert.equal(result.ticks, 20);
  await verifyLiveChain({ dataRoot: root });
});

test("the disk guard pauses a running universe at the next tick boundary", async (t) => {
  const root = await tempDir(t, "anu-live-disk-mid-");
  const config = supervisedConfig();
  const cognition = scriptedLiveCognition();
  const plan = await planLiveEpoch({ dataRoot: root, config, cognition });
  const store = openLiveEpochEvidence(root, "U0001", plan.manifest.runId);

  // Free space is read on each clearance check (twice before the epoch's first
  // event) and then once per tick, on the way out of the tick's consultations.
  // The sixth reading is therefore tick 4's, and it is the one that trips.
  let readings = 0;
  const pauses = [];
  const duringPause = [];
  let waits = 0;
  const result = await runLiveEpoch({
    dataRoot: root,
    config,
    cognition,
    supervisor: {
      outageTicks: 0,
      minFreeBytes: 4_096,
      probeIntervalMs: 1,
      maxProbeRounds: 20,
      freeBytes: async () => {
        readings += 1;
        return readings >= 6 && waits < 2 ? 512 : 1_048_576;
      },
      wait: async () => {
        waits += 1;
        duringPause.push(await readFile(store.eventsPath, "utf8"));
      },
      onPause: (pause) => pauses.push(pause),
    },
  });

  assert.equal(pauses.length, 1);
  assert.equal(pauses[0].reason, "low_disk");
  assert.equal(pauses[0].tick, 4);
  assert.ok(waits >= 1);
  assert.equal(new Set(duringPause).size, 1, "the event log is byte-identical throughout the pause");
  // The property that matters: the universe stopped at the boundary of the very
  // tick the guard decided in — the tick finished, and no further tick began.
  assert.equal(countType(duringPause[0], "tick.completed"), pauses[0].tick);
  assert.ok(pauses[0].tick > 0 && pauses[0].tick < config.ticks);
  assert.equal(result.ticks, 20);
  await verifyLiveChain({ dataRoot: root });
});

test("a guard that never clears gives up instead of spinning for ever", async (t) => {
  const root = await tempDir(t, "anu-live-giveup-");
  let waits = 0;
  const supervisor = new LiveSupervisor(root, {
    minFreeBytes: 4_096,
    probeIntervalMs: 1,
    maxProbeRounds: 4,
    freeBytes: async () => 0,
    wait: async () => {
      waits += 1;
    },
  });
  await assert.rejects(() => supervisor.awaitClearance(), LiveSupervisorGaveUpError);
  assert.equal(waits, 4, "one wait per probe round, then the supervisor stops");

  // A free-space reading that cannot be taken is not a licence to keep writing.
  const unreadable = new LiveSupervisor(root, {
    minFreeBytes: 4_096,
    probeIntervalMs: 1,
    maxProbeRounds: 1,
    freeBytes: async () => {
      throw new Error("statfs refused");
    },
    wait: async () => undefined,
  });
  await assert.rejects(() => unreadable.awaitClearance(), /free space of .* is unreadable: statfs refused/);
});

test("supervisor options are validated, and the guards can be turned off explicitly", async (t) => {
  const root = await tempDir(t, "anu-live-supervisor-options-");
  assert.throws(() => assertLiveSupervisorOptions(null), /supervisor must be an object/);
  assert.throws(() => assertLiveSupervisorOptions({ outageTicks: 1.5 }), /outageTicks must be a non-negative safe integer/);
  assert.throws(() => assertLiveSupervisorOptions({ probeIntervalMs: 0 }), /probeIntervalMs must be a positive safe integer/);
  assert.throws(() => assertLiveSupervisorOptions({ maxProbeRounds: 0 }), /maxProbeRounds must be a positive safe integer/);
  assert.throws(() => assertLiveSupervisorOptions({ nonsense: 1 }), /supervisor contains unknown field nonsense/);
  assert.deepEqual(assertLiveSupervisorOptions({ outageTicks: 0, minFreeBytes: 0 }), {
    outageTicks: 0,
    minFreeBytes: 0,
  });
  assert.equal(LIVE_DEFAULT_OUTAGE_TICKS, 3);

  // Both guards off: a supervisor that observes nothing never pauses, and
  // never reads the filesystem either.
  let reads = 0;
  const supervisor = new LiveSupervisor(root, {
    outageTicks: 0,
    minFreeBytes: 0,
    freeBytes: async () => {
      reads += 1;
      return 0;
    },
  });
  await supervisor.awaitClearance();
  assert.equal(supervisor.pause, undefined);
  assert.equal(reads, 0);

  // An epoch that never trips a guard is the epoch it would have been without
  // one, including its identity.
  const config = supervisedConfig();
  const cognition = scriptedLiveCognition();
  const supervised = await runLiveEpoch({ dataRoot: root, config, cognition, supervisor });
  const plainRoot = await tempDir(t, "anu-live-unsupervised-");
  const plain = await runLiveEpoch({ dataRoot: plainRoot, config, cognition });
  assert.equal(supervised.runId, plain.runId);
  assert.equal(supervised.summary.finalStateHash, plain.summary.finalStateHash);
  assert.equal(supervised.link.commitment, plain.link.commitment);
});

/* ------------------------------------------------------------------ */
/* The command surface                                                  */
/* ------------------------------------------------------------------ */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runnerPath = join(repositoryRoot, "dist", "lab", "runner.js");

function invoke(args, environment = {}) {
  const scrubbed = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("ANU_LIVE_")),
  );
  return spawnSync(process.execPath, [runnerPath, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...scrubbed, ...environment },
  });
}

function lastJson(text) {
  return JSON.parse(text.trim().split("\n").at(-1));
}

test("anu lab live --help documents the guards and the whole flag surface", () => {
  const result = invoke(["live", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  const help = lastJson(result.stdout);
  assert.equal(help.command, "live");
  assert.equal(help.status, "ok");
  for (const flag of [
    "--data-dir", "--experiment", "--universe-id", "--config", "--epoch-ticks", "--epochs",
    "--tiers", "--task-inbox", "--verdict-inbox", "--physics-inbox",
    "--outage-ticks", "--min-free-bytes", "--probe-interval-ms",
    "--recover-stale-lease", "--accept-parent-engine", "--no-compaction",
  ]) {
    assert.ok(help.usage.includes(flag.replace("--", "--")) || flag in help.options, `usage or options documents ${flag}`);
    assert.ok(typeof help.options[flag] === "string" && help.options[flag].length > 0, `${flag} is described`);
  }
  assert.match(help.options["--outage-ticks"], /consecutive ticks with no consulted answer/);
  assert.match(help.options["--min-free-bytes"], /free bytes of the evidence volume/);
  for (const variable of [
    "ANU_LIVE_TIERS", "ANU_LLM_BASE_URL", "ANU_LIVE_OUTAGE_TICKS", "ANU_LIVE_MIN_FREE_BYTES",
    "ANU_LIVE_PROBE_INTERVAL_MS", "ANU_LIVE_TASK_INBOX", "ANU_LIVE_VERDICT_INBOX", "ANU_LIVE_PHYSICS_INBOX",
  ]) {
    assert.ok(typeof help.environment[variable] === "string", `${variable} is documented`);
  }
  // The honesty the command owes its operator: what a pause is, and that it
  // leaves the evidence alone.
  assert.ok(help.notes.some((note) => /never mid-tick/.test(note)));
  assert.ok(help.notes.some((note) => /Nothing they observe enters the/.test(note)));
});

test("anu lab live refuses to start without physics or without tiers", () => {
  const withoutConfig = invoke(["live"]);
  assert.equal(withoutConfig.status, 2);
  assert.match(lastJson(withoutConfig.stderr).error.message, /requires --config/);

  const livePath = join(repositoryRoot, "experiments", "genesis-live", "config.json");
  const withoutTiers = invoke(["live", "--config", livePath]);
  assert.equal(withoutTiers.status, 2);
  assert.match(lastJson(withoutTiers.stderr).error.message, /requires the live tiers/);

  // The identity gate is unchanged: only genesis-live may run live.
  const scientific = invoke(["live", "--experiment", "genesis-1"]);
  assert.equal(scientific.status, 2);
  assert.match(lastJson(scientific.stderr).error.message, /not allowed for live; allowed: genesis-live/);

  // Deployment values are validated before anything is written.
  const badGuard = invoke(["live", "--config", livePath, "--outage-ticks", "-1"]);
  assert.equal(badGuard.status, 2);
  assert.match(lastJson(badGuard.stderr).error.message, /--outage-ticks must be an integer/);
});
