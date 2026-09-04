import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvidenceConflictError, EvidenceStore } from "../dist/lab/artifacts.js";
import { canonicalJson, hashValue } from "../dist/lab/canonical.js";
import { DEFAULT_GENESIS_CONFIG } from "../dist/lab/config.js";
import { LAB_ENGINE_VERSION } from "../dist/lab/manifest.js";
import { readBootId, requireProcessStartTicks } from "../dist/lab/process-identity.js";
import { LAB_SCHEMA_VERSION } from "../dist/lab/types.js";

const zeroResources = () => ({
  credits: 0,
  llmTokens: 0,
  computeMs: 0,
  storageBytes: 0,
  bandwidthBytes: 0,
});

function fixture() {
  const config = structuredClone(DEFAULT_GENESIS_CONFIG);
  const manifest = {
    schemaVersion: LAB_SCHEMA_VERSION,
    experimentId: config.experimentId,
    engineVersion: LAB_ENGINE_VERSION,
    mode: "logical",
    policyId: "neutral-backpressure-v1",
    taskGeneratorId: "deterministic-task-stream-v1",
    runId: "run:test-001",
    universeId: "U0001",
    seed: config.seed,
    configHash: hashValue(config),
  };
  return { config, manifest };
}

function metric(tick) {
  return {
    schemaVersion: LAB_SCHEMA_VERSION,
    tick,
    tasksCreated: tick,
    tasksCompleted: 0,
    taskSuccessRatePpm: 0,
    meanQualityPpm: 0,
    p50LatencyTicks: 0,
    p95LatencyTicks: 0,
    creditsPerAcceptedTaskPpm: 0,
    computePerAcceptedTaskPpm: 0,
    bandwidthPerAcceptedTaskPpm: 0,
    activeAgents: 0,
    activeLinks: 0,
    densityPpm: 0,
    connectedComponents: 0,
    degreeCentralizationPpm: 0,
    resourceGiniPpm: 0,
    meanSpecializationPpm: 0,
    linkTurnover: 0,
    violations: 0,
  };
}

function state(manifest, tick, metrics = []) {
  return {
    schemaVersion: LAB_SCHEMA_VERSION,
    runId: manifest.runId,
    universeId: manifest.universeId,
    configHash: manifest.configHash,
    seed: manifest.seed,
    tick,
    agents: {},
    links: {},
    tasks: {},
    submissions: {},
    capabilities: {},
    physics: {
      resourcePricePpm: {
        credits: 1_000_000,
        llmTokens: 1_000_000,
        computeMs: 1_000_000,
        storageBytes: 1_000_000,
        bandwidthBytes: 1_000_000,
      },
      bandwidthCapacityPpm: 1_000_000,
      taskLoadPpm: 1_000_000,
    },
    treasury: zeroResources(),
    resourceSpent: zeroResources(),
    metrics,
    completed: false,
  };
}

test("EvidenceStore initializes the canonical run layout and reads every artifact", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-artifacts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runsRoot = join(directory, "runs");
  const { config, manifest } = fixture();
  const store = await EvidenceStore.initialize(runsRoot, manifest, config);
  const expectedDirectory = join(
    runsRoot,
    manifest.experimentId,
    manifest.universeId,
    manifest.runId,
  );
  assert.equal(store.runId, manifest.runId);
  assert.equal(store.directory, expectedDirectory);
  assert.equal(await readFile(join(expectedDirectory, "manifest.json"), "utf8"), canonicalJson(manifest));
  assert.equal(await readFile(join(expectedDirectory, "config.json"), "utf8"), canonicalJson(config));
  assert.equal(await readFile(join(expectedDirectory, "events.jsonl"), "utf8"), "");
  assert.equal(await readFile(join(expectedDirectory, "metrics.jsonl"), "utf8"), "");
  assert.deepEqual(await store.readManifest(), manifest);
  assert.deepEqual(await store.readConfig(), config);
  assert.equal(await store.readSummary(), undefined);

  await store.events.append({
    tick: 0,
    phase: "genesis",
    type: "run.started",
    data: {},
  });
  const metrics = [metric(1), metric(2), metric(3)];
  await Promise.all(metrics.map((value) => store.appendMetrics(value)));

  const checkpointState = state(manifest, 3, metrics);
  const checkpoint = {
    schemaVersion: LAB_SCHEMA_VERSION,
    runId: manifest.runId,
    universeId: manifest.universeId,
    tick: 3,
    seq: store.events.lastSeq,
    eventHash: store.events.lastHash,
    stateHash: hashValue(checkpointState),
    state: checkpointState,
  };
  await store.writeCheckpoint(checkpoint);
  await store.writeCheckpoint(structuredClone(checkpoint));
  const summary = {
    schemaVersion: LAB_SCHEMA_VERSION,
    runId: manifest.runId,
    universeId: manifest.universeId,
    seed: manifest.seed,
    ticks: 3,
    events: store.events.lastSeq,
    finalStateHash: checkpoint.stateHash,
    finalEventHash: checkpoint.eventHash,
    latestMetrics: metrics.at(-1),
  };
  await store.writeSummary(summary);
  await store.flush();

  assert.deepEqual(await store.readMetrics(), metrics);
  assert.deepEqual(await store.readCheckpoint(3), checkpoint);
  assert.deepEqual(await store.readCheckpoints(), [checkpoint]);
  assert.deepEqual(await store.readSummary(), summary);
  assert.equal(
    await readFile(join(expectedDirectory, "checkpoints", "3.json"), "utf8"),
    canonicalJson(checkpoint),
  );
  const metricLines = (await readFile(join(expectedDirectory, "metrics.jsonl"), "utf8")).trimEnd().split("\n");
  assert.deepEqual(metricLines, metrics.map((value) => canonicalJson(value)));
  assert.equal((await readdir(expectedDirectory)).some((entry) => entry.includes(".tmp-")), false);

  const resumed = await EvidenceStore.initialize(runsRoot, manifest, config);
  assert.equal(resumed.events.lastSeq, 1);
  assert.deepEqual(await resumed.readMetrics(), metrics);
});

test("EvidenceStore discovers one addressed run and requires explicit selection for two", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-artifacts-discovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runsRoot = join(directory, "runs");
  const { config, manifest } = fixture();

  await mkdir(join(runsRoot, manifest.experimentId, "U9999"), { recursive: true });
  await assert.rejects(
    EvidenceStore.openExisting(runsRoot, manifest.experimentId, "U9999"),
    (error) => {
      assert.match(error.message, /No supported evidence runs found/);
      assert.doesNotMatch(error.message, /specify --run-id/);
      return true;
    },
  );

  const first = await EvidenceStore.initialize(runsRoot, manifest, config);
  const deterministicReopen = await EvidenceStore.initialize(runsRoot, manifest, config);
  assert.equal(deterministicReopen.directory, first.directory);
  assert.deepEqual(await deterministicReopen.readManifest(), manifest);

  const selectedByDefault = await EvidenceStore.openExisting(
    runsRoot,
    manifest.experimentId,
    manifest.universeId,
  );
  assert.equal(selectedByDefault.directory, first.directory);

  const secondManifest = { ...manifest, runId: "run:test-002" };
  const second = await EvidenceStore.initialize(runsRoot, secondManifest, config);
  assert.notEqual(second.directory, first.directory);
  assert.equal(
    second.directory,
    join(runsRoot, manifest.experimentId, manifest.universeId, secondManifest.runId),
  );
  await assert.rejects(
    EvidenceStore.openExisting(runsRoot, manifest.experimentId, manifest.universeId),
    /Multiple supported evidence runs.*--run-id/,
  );

  const explicitlySelected = await EvidenceStore.openExisting(
    runsRoot,
    manifest.experimentId,
    manifest.universeId,
    secondManifest.runId,
  );
  assert.equal(explicitlySelected.directory, second.directory);
  assert.deepEqual(await explicitlySelected.readManifest(), secondManifest);
});

test("EvidenceStore preserves legacy reads and skips unsupported engines during discovery", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-artifacts-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runsRoot = join(directory, "runs");
  const { config, manifest } = fixture();

  const legacyManifest = {
    ...manifest,
    runId: "run:legacy-current",
    universeId: "U0002",
  };
  const legacy = new EvidenceStore(runsRoot, legacyManifest.experimentId, legacyManifest.universeId);
  await legacy.initialize(legacyManifest, config);
  const implicitLegacy = await EvidenceStore.openExisting(
    runsRoot,
    legacyManifest.experimentId,
    legacyManifest.universeId,
  );
  assert.equal(implicitLegacy.directory, legacy.directory);
  assert.equal(implicitLegacy.runId, undefined);
  const explicitLegacy = await EvidenceStore.openExisting(
    runsRoot,
    legacyManifest.experimentId,
    legacyManifest.universeId,
    legacyManifest.runId,
  );
  assert.equal(explicitLegacy.directory, legacy.directory);

  const currentManifest = {
    ...manifest,
    runId: "run:current-engine",
    universeId: "U0003",
  };
  const current = await EvidenceStore.initialize(runsRoot, currentManifest, config);
  const unsupportedLegacy = {
    ...currentManifest,
    engineVersion: "genesis-logical-v1.0.0",
    runId: "run:legacy-v1",
  };
  const universeDirectory = join(
    runsRoot,
    currentManifest.experimentId,
    currentManifest.universeId,
  );
  await writeFile(join(universeDirectory, "manifest.json"), canonicalJson(unsupportedLegacy), "utf8");

  const implicitCurrent = await EvidenceStore.openExisting(
    runsRoot,
    currentManifest.experimentId,
    currentManifest.universeId,
  );
  assert.equal(implicitCurrent.directory, current.directory);
  await assert.rejects(
    EvidenceStore.openExisting(
      runsRoot,
      currentManifest.experimentId,
      currentManifest.universeId,
      unsupportedLegacy.runId,
    ),
    /unsupported.*engineVersion genesis-logical-v1\.0\.0/i,
  );

  const unsupportedSchema = {
    ...currentManifest,
    schemaVersion: 999,
    runId: "run:unsupported-schema",
  };
  const unsupportedDirectory = join(universeDirectory, unsupportedSchema.runId);
  await mkdir(unsupportedDirectory);
  await writeFile(
    join(unsupportedDirectory, "manifest.json"),
    canonicalJson(unsupportedSchema),
    "utf8",
  );
  const stillImplicitCurrent = await EvidenceStore.openExisting(
    runsRoot,
    currentManifest.experimentId,
    currentManifest.universeId,
  );
  assert.equal(stillImplicitCurrent.directory, current.directory);
  await assert.rejects(
    EvidenceStore.openExisting(
      runsRoot,
      currentManifest.experimentId,
      currentManifest.universeId,
      unsupportedSchema.runId,
    ),
    /unsupported implementation.*schemaVersion 999/i,
  );
});

test("EvidenceStore discovery rejects traversal and symbolic links", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-artifacts-symlink-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runsRoot = join(directory, "runs");
  const universeDirectory = join(runsRoot, "genesis-1", "U0001");
  const outside = join(directory, "outside");
  await mkdir(outside, { recursive: true });
  await mkdir(universeDirectory, { recursive: true });
  await symlink(outside, join(universeDirectory, "run:linked"), "dir");

  await assert.rejects(
    EvidenceStore.openExisting(runsRoot, "genesis-1", "U0001"),
    /symbolic link/,
  );
  await assert.rejects(
    EvidenceStore.openExisting(runsRoot, "genesis-1", "U0001", "run:linked"),
    /symbolic link/,
  );
  await assert.rejects(
    EvidenceStore.openExisting(runsRoot, "genesis-1", "U0001", "../outside"),
    /unsafe/,
  );
});

test("EvidenceStore writers reject symlinked hierarchy and artifacts without touching targets", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-artifacts-writer-symlink-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runsRoot = join(directory, "runs");
  const { config, manifest } = fixture();

  const outsideHierarchy = join(directory, "outside-hierarchy");
  const linkedRunsRoot = join(directory, "linked-runs");
  await mkdir(outsideHierarchy);
  await symlink(outsideHierarchy, linkedRunsRoot, "dir");
  await assert.rejects(
    EvidenceStore.initialize(linkedRunsRoot, manifest, config),
    /symbolic link directory/,
  );
  assert.deepEqual(await readdir(outsideHierarchy), []);

  const eventsTarget = join(directory, "outside-events.jsonl");
  await writeFile(eventsTarget, "outside-events", "utf8");
  const eventStore = new EvidenceStore(
    runsRoot,
    manifest.experimentId,
    manifest.universeId,
    { runId: manifest.runId },
  );
  await mkdir(eventStore.checkpointsDirectory, { recursive: true });
  await symlink(eventsTarget, eventStore.eventsPath, "file");
  await assert.rejects(eventStore.initialize(manifest, config), /symbolic link file/);
  assert.equal(await readFile(eventsTarget, "utf8"), "outside-events");

  const metricsManifest = { ...manifest, runId: "run:metrics-symlink" };
  const metricsStore = new EvidenceStore(
    runsRoot,
    metricsManifest.experimentId,
    metricsManifest.universeId,
    { runId: metricsManifest.runId },
  );
  const metricsTarget = join(directory, "outside-metrics.jsonl");
  await writeFile(metricsTarget, "outside-metrics", "utf8");
  await mkdir(metricsStore.checkpointsDirectory, { recursive: true });
  await symlink(metricsTarget, metricsStore.metricsPath, "file");
  await assert.rejects(metricsStore.initialize(metricsManifest, config), /symbolic link file/);
  assert.equal(await readFile(metricsTarget, "utf8"), "outside-metrics");

  const checkpointManifest = { ...manifest, runId: "run:checkpoint-symlink" };
  const checkpointStore = await EvidenceStore.initialize(runsRoot, checkpointManifest, config);
  const checkpointTarget = join(directory, "outside-checkpoint.json");
  await writeFile(checkpointTarget, "outside-checkpoint", "utf8");
  await symlink(checkpointTarget, checkpointStore.checkpointPath(1), "file");
  const checkpointState = state(checkpointManifest, 1);
  await assert.rejects(
    checkpointStore.writeCheckpoint({
      schemaVersion: LAB_SCHEMA_VERSION,
      runId: checkpointManifest.runId,
      universeId: checkpointManifest.universeId,
      tick: 1,
      seq: checkpointStore.events.lastSeq,
      eventHash: checkpointStore.events.lastHash,
      stateHash: hashValue(checkpointState),
      state: checkpointState,
    }),
    /symbolic link file/,
  );
  assert.equal(await readFile(checkpointTarget, "utf8"), "outside-checkpoint");
});

test("EvidenceStore discovery bounds manifests and rejects invalid UTF-8", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-artifacts-bounds-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runsRoot = join(directory, "runs");
  const { config, manifest } = fixture();

  const oversized = new EvidenceStore(
    runsRoot,
    manifest.experimentId,
    manifest.universeId,
    { runId: "run:oversized-manifest" },
  );
  await mkdir(oversized.directory, { recursive: true });
  await writeFile(oversized.manifestPath, Buffer.alloc(1_048_577, 0x20));
  await assert.rejects(
    EvidenceStore.openExisting(
      runsRoot,
      manifest.experimentId,
      manifest.universeId,
      oversized.runId,
    ),
    /manifest exceeds the 1048576-byte discovery limit/,
  );

  const invalid = new EvidenceStore(
    runsRoot,
    manifest.experimentId,
    manifest.universeId,
    { runId: "run:invalid-utf8" },
  );
  await mkdir(invalid.directory);
  await writeFile(invalid.manifestPath, Buffer.from([0xff]));
  await assert.rejects(
    EvidenceStore.openExisting(
      runsRoot,
      manifest.experimentId,
      manifest.universeId,
      invalid.runId,
    ),
    /not valid UTF-8/,
  );
});

test("EvidenceStore bounds runtime artifact reads and immutable comparisons", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-artifacts-runtime-bounds-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runsRoot = join(directory, "runs");
  const { config, manifest } = fixture();

  const metricsManifest = { ...manifest, runId: "run:oversized-metrics" };
  const metricsStore = new EvidenceStore(
    runsRoot,
    metricsManifest.experimentId,
    metricsManifest.universeId,
    { runId: metricsManifest.runId },
  );
  await mkdir(metricsStore.directory, { recursive: true });
  await writeFile(metricsStore.metricsPath, "", "utf8");
  await truncate(metricsStore.metricsPath, 67_108_865);
  await assert.rejects(
    metricsStore.initialize(metricsManifest, config),
    /67108864-byte read limit/,
  );

  const boundedManifest = { ...manifest, runId: "run:bounded-artifacts" };
  const boundedStore = await EvidenceStore.initialize(runsRoot, boundedManifest, config);
  const summary = {
    schemaVersion: LAB_SCHEMA_VERSION,
    runId: boundedManifest.runId,
    universeId: boundedManifest.universeId,
    seed: boundedManifest.seed,
    ticks: 1,
    events: 1,
    finalStateHash: "a".repeat(64),
    finalEventHash: boundedStore.events.lastHash,
    latestMetrics: metric(1),
  };
  await boundedStore.writeSummary(summary);
  await truncate(boundedStore.summaryPath, 1_048_577);
  await assert.rejects(
    boundedStore.writeSummary(summary),
    /byte read limit/,
  );

  const checkpointPath = boundedStore.checkpointPath(1);
  await writeFile(checkpointPath, "", "utf8");
  await truncate(checkpointPath, 67_108_865);
  await assert.rejects(
    boundedStore.readCheckpoint(1),
    /67108864-byte read limit/,
  );
});

test("EvidenceStore rejects traversal and unsafe run identifiers before writing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-artifacts-safe-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { config, manifest } = fixture();
  assert.throws(() => new EvidenceStore(directory, "../genesis-1", "U0001"), /unsafe/);
  assert.throws(() => new EvidenceStore(directory, "genesis-1", "../../outside"), /unsafe/);
  assert.throws(() => new EvidenceStore(directory, "genesis-1", "U\\outside"), /unsafe/);
  assert.throws(
    () => new EvidenceStore(directory, "genesis-1", "U0001", { runId: "../run" }),
    /unsafe/,
  );
  await assert.rejects(
    EvidenceStore.initialize(directory, { ...manifest, runId: "../run" }, config),
    /unsafe/,
  );
  await assert.rejects(
    EvidenceStore.initialize(directory, { ...manifest, configHash: "0".repeat(64) }, config),
    /Config hash mismatch/,
  );
  await assert.rejects(
    EvidenceStore.initialize(directory, { ...manifest, seed: {} }, config),
    /seed must be a non-empty string/,
  );
  assert.deepEqual(await readdir(directory), []);
});

test("EvidenceStore writer lease excludes concurrent processes and releases cleanly", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-artifacts-lease-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = new EvidenceStore(directory, "genesis-1", "U0001");
  const second = new EvidenceStore(directory, "genesis-1", "U0001");
  const release = await first.acquireWriterLease("run:lease-test");
  await assert.rejects(
    second.acquireWriterLease("run:lease-test"),
    /active or stale writer lease/,
  );
  await release();
  const releaseAgain = await second.acquireWriterLease("run:lease-test");
  await releaseAgain();
});

/* ------------------------------------------------------------------ */
/* Writer lease recovery matrix (critic #10)                           */
/* ------------------------------------------------------------------ */

async function fabricateLock(store, record) {
  await mkdir(store.directory, { recursive: true });
  await writeFile(join(store.directory, ".runner.lock"), canonicalJson(record), "utf8");
}

test("acquireWriterLease({recoverStale:true}) recovers a lock left by a different boot", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-lease-recover-boot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new EvidenceStore(directory, "genesis-1", "U0001");
  const ownStartTicks = await requireProcessStartTicks(process.pid);
  // Same pid as this very process, but a boot id that cannot be this boot's:
  // staleness must be provable from bootId alone, independent of startTicks.
  await fabricateLock(store, {
    pid: process.pid,
    runId: "run:crashed",
    bootId: "00000000-0000-0000-0000-000000000000",
    startTicks: ownStartTicks,
  });
  const release = await store.acquireWriterLease("run:recovered", { recoverStale: true });
  const recovered = JSON.parse(await readFile(join(store.directory, ".runner.lock"), "utf8"));
  assert.equal(recovered.runId, "run:recovered");
  assert.equal(recovered.pid, process.pid);
  await release();
});

test("acquireWriterLease({recoverStale:true}) recovers a same-boot lock whose pid now started later", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-lease-recover-starttime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new EvidenceStore(directory, "genesis-1", "U0001");
  const realBootId = await readBootId();
  const ownStartTicks = await requireProcessStartTicks(process.pid);
  // Same pid, same boot, but the lock's recorded start time is older than
  // this process's actual start time: the pid was handed to an unrelated
  // later process (the routine low-pid case after a container restart).
  await fabricateLock(store, {
    pid: process.pid,
    runId: "run:crashed",
    bootId: realBootId,
    startTicks: Math.max(0, ownStartTicks - 1),
  });
  const release = await store.acquireWriterLease("run:recovered", { recoverStale: true });
  await release();
});

test("acquireWriterLease({recoverStale:true}) refuses an exact pid+bootId+startTicks match as a live conflict", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-lease-exact-match-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new EvidenceStore(directory, "genesis-1", "U0001");
  const realBootId = await readBootId();
  const ownStartTicks = await requireProcessStartTicks(process.pid);
  // This process's own true identity: acquireWriterLease cannot disprove that
  // the recorded owner is still alive, because it is this very process.
  await fabricateLock(store, { pid: process.pid, runId: "run:live", bootId: realBootId, startTicks: ownStartTicks });
  await assert.rejects(
    store.acquireWriterLease("run:new", { recoverStale: true }),
    /active or stale writer lease/,
  );
});

test("acquireWriterLease without recoverStale always conflicts, even on a provably stale lock", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-lease-no-flag-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new EvidenceStore(directory, "genesis-1", "U0001");
  const ownStartTicks = await requireProcessStartTicks(process.pid);
  await fabricateLock(store, {
    pid: process.pid,
    runId: "run:crashed",
    bootId: "00000000-0000-0000-0000-000000000000",
    startTicks: ownStartTicks,
  });
  await assert.rejects(store.acquireWriterLease("run:new"), /active or stale writer lease/);
  await assert.rejects(
    store.acquireWriterLease("run:new", { recoverStale: false }),
    /active or stale writer lease/,
  );
  // The historical behaviour is preserved byte-for-byte: the stale lock is
  // left completely untouched by a conflicting acquisition attempt.
  const untouched = JSON.parse(await readFile(join(store.directory, ".runner.lock"), "utf8"));
  assert.equal(untouched.runId, "run:crashed");
});

test("acquireWriterLease({recoverStale:true}) recovers a lock whose pid no longer exists", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-lease-recover-dead-pid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new EvidenceStore(directory, "genesis-1", "U0001");
  const realBootId = await readBootId();
  // A pid essentially guaranteed not to be held by any process right now.
  await fabricateLock(store, { pid: 999_999, runId: "run:crashed", bootId: realBootId, startTicks: 1 });
  const release = await store.acquireWriterLease("run:recovered", { recoverStale: true });
  await release();
});

test("conflicts and failed resumes preserve existing evidence byte-for-byte", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-artifacts-preserve-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runsRoot = join(directory, "runs");
  const { config, manifest } = fixture();
  const store = await EvidenceStore.initialize(runsRoot, manifest, config);
  await store.events.append({ tick: 0, phase: "genesis", type: "run.started", data: {} });
  await store.appendMetrics(metric(1));
  await store.flush();

  const paths = [store.manifestPath, store.configPath, store.eventsPath, store.metricsPath];
  const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  const changedConfig = structuredClone(config);
  changedConfig.ticks += 1;
  const conflictingManifest = {
    ...manifest,
    configHash: hashValue(changedConfig),
  };
  await assert.rejects(
    EvidenceStore.initialize(runsRoot, conflictingManifest, changedConfig),
    EvidenceConflictError,
  );
  assert.deepEqual(await Promise.all(paths.map((path) => readFile(path, "utf8"))), before);

  await assert.rejects(store.appendMetrics(metric(1)), /does not advance/);
  assert.equal(await readFile(store.metricsPath, "utf8"), before[3]);

  const firstSummary = {
    schemaVersion: LAB_SCHEMA_VERSION,
    runId: manifest.runId,
    universeId: manifest.universeId,
    seed: manifest.seed,
    ticks: 1,
    events: 1,
    finalStateHash: "a".repeat(64),
    finalEventHash: store.events.lastHash,
    latestMetrics: metric(1),
  };
  await store.writeSummary(firstSummary);
  await assert.rejects(store.writeSummary({ ...firstSummary, ticks: 2 }), EvidenceConflictError);
  assert.equal(await readFile(store.summaryPath, "utf8"), canonicalJson(firstSummary));
});
