import { EvidenceConflictError, EvidenceStore } from "./artifacts.js";
import { hashValue } from "./canonical.js";
import { validateGenesisConfig } from "./config.js";
import { createRunEvidenceAttestation } from "./evidence-attestation.js";
import { writeFinalAttestationInternal } from "./evidence-attestation-storage.js";
import { createLogicalPolicyById } from "./baselines.js";
import { CohortPolicy, type CognitionPort } from "./cognition.js";
import type { LogicalPolicy } from "./policy-schedule.js";
import { createRunManifest } from "./manifest.js";
import { NeutralPolicy } from "./neutral-policy.js";
import { ReplayEngine, type ReplayResult } from "./replay.js";
import {
  LAB_SCHEMA_VERSION,
  type Checkpoint,
  type GenesisConfig,
  type MetricsSnapshot,
  type RunManifest,
  type RunSummary,
  type WorldState,
} from "./types.js";
import { LogicalUniverse } from "./world.js";

export interface GenesisRunOptions {
  config: GenesisConfig;
  runsRoot: string;
  universeId: string;
  signal?: AbortSignal;
  /**
   * Supplying a port makes this a cognitive run: the manifest takes a separate
   * engine identity so its evidence can never be confused with a run a seed
   * alone reproduces.
   */
  cognition?: CognitionPort;
  /**
   * A deterministic control-arm policy from the manifest registry (see
   * baselines.ts). Mutually exclusive with `cognition`: a control that thinks
   * with a model would not be a control.
   */
  policy?: LogicalPolicy;
}

export class GenesisRunPausedError extends Error {
  readonly runId: string;
  readonly universeId: string;
  readonly tick: number;

  constructor(runId: string, universeId: string, tick: number) {
    super(`Genesis run ${universeId} paused durably at tick ${tick}`);
    this.name = "GenesisRunPausedError";
    this.runId = runId;
    this.universeId = universeId;
    this.tick = tick;
  }
}

/**
 * Execute one logical Genesis universe and commit its scientific evidence.
 *
 * The live state is never accepted on trust: after completion the append-only
 * event stream is reduced from genesis again and both state hashes must match.
 */
export async function runGenesis(options: GenesisRunOptions): Promise<RunSummary> {
  if (!options.runsRoot) throw new TypeError("Genesis runs root must not be empty");
  const config = structuredClone(options.config);
  validateGenesisConfig(config);
  const cognition = options.cognition;
  if (cognition !== undefined && options.policy !== undefined) {
    throw new Error("A run takes either a cognition port or a baseline policy, never both");
  }
  // Never run with the caller's instance. A stateful policy that already
  // decided a previous run would draw from advanced RNG streams, and the
  // verifier — which always regenerates from a fresh instance — would refuse
  // the evidence after the compute was already spent. Deriving a fresh policy
  // from the identity guarantees the run uses exactly what replay will use.
  const policy = cognition !== undefined
    ? new CohortPolicy(cognition.cohort, new NeutralPolicy())
    : options.policy === undefined
      ? undefined
      : createLogicalPolicyById(options.policy.id);
  const manifest = createRunManifest(
    config,
    options.universeId,
    policy === undefined
      ? {}
      : {
        policyId: policy.id,
        mode: cognition === undefined ? "logical" : "cognitive",
        // The consulted model is part of the treatment: without it in the
        // identity, rerunning the same cohort against a different model
        // would recover the earlier run's evidence instead of running.
        ...(cognition === undefined ? {} : { cognitionId: cognition.id }),
      },
  );
  const evidence = new EvidenceStore(
    options.runsRoot,
    manifest.experimentId,
    manifest.universeId,
    { retainEvents: false, runId: manifest.runId },
  );
  const releaseLease = await evidence.acquireWriterLease(manifest.runId);

  try {
    await evidence.initialize(manifest, config);
    const recovery = await recoverExistingRun(evidence, manifest, config);
    if (recovery.kind === "completed") return recovery.summary;

    const universe = new LogicalUniverse(manifest, config, evidence.events, {
      ...(policy === undefined ? {} : { policy }),
      ...(cognition === undefined ? {} : { cognition }),
      onMetrics: (metrics) => evidence.appendMetrics(metrics),
      onCheckpoint: (checkpoint) => evidence.writeCheckpoint(checkpoint),
      ...(recovery.kind === "checkpoint" ? { resumeFrom: recovery.checkpoint } : {}),
    });
    const liveState = await universe.run(options.signal);
    await evidence.flush();
    if (!liveState.completed) {
      throw new GenesisRunPausedError(manifest.runId, manifest.universeId, liveState.tick);
    }

    const replay = await ReplayEngine.replayFile(evidence.eventsPath, manifest, config);
    assertReplayEquivalent(liveState, replay, config);
    const summary = await createSummary(evidence, manifest, config, replay);
    await evidence.writeSummary(summary);
    await writeFinalAttestationInternal(evidence, createRunEvidenceAttestation(
      manifest,
      config,
      summary,
      replay.state.metrics,
    ));
    await evidence.flush();
    return structuredClone(summary);
  } catch (error) {
    // Do not remove partial artifacts: a failed run is itself diagnostic evidence.
    await evidence.flush().catch(() => undefined);
    throw error;
  } finally {
    await releaseLease();
  }
}

type ExistingRunRecovery =
  | { kind: "fresh" }
  | { kind: "checkpoint"; checkpoint: Checkpoint }
  | { kind: "completed"; summary: RunSummary };

async function recoverExistingRun(
  evidence: EvidenceStore,
  manifest: RunManifest,
  config: GenesisConfig,
): Promise<ExistingRunRecovery> {
  const stored = await evidence.readSummary();
  if (evidence.events.lastSeq === 0) {
    if (stored) throw new EvidenceConflictError("A summary exists without an event stream");
    return { kind: "fresh" };
  }

  const replay = await ReplayEngine.replayRecoverableFile(evidence.eventsPath, manifest, config);
  if (!replay.state.completed) {
    if (stored) throw new EvidenceConflictError("A summary exists for an incomplete event stream");
    if (await evidence.readFinalAttestation()) {
      throw new EvidenceConflictError("A final attestation exists for an incomplete event stream");
    }
    const checkpoint = (await evidence.readCheckpoints()).at(-1);
    if (checkpoint === undefined) {
      throw new EvidenceConflictError("Incomplete evidence has no durable checkpoint");
    }
    assertCheckpointReplayEquivalent(checkpoint, replay);
    assertMetricsMatchReplay(await evidence.readMetrics(), replay.state.metrics);
    return { kind: "checkpoint", checkpoint };
  }
  assertCompletedReplay(replay, config);
  const reconstructed = await createSummary(evidence, manifest, config, replay);
  if (stored && hashValue(stored) !== hashValue(reconstructed)) {
    throw new EvidenceConflictError("Stored summary does not match replayed evidence");
  }
  if (!stored) await evidence.writeSummary(reconstructed);
  await writeFinalAttestationInternal(evidence, createRunEvidenceAttestation(
    manifest,
    config,
    reconstructed,
    replay.state.metrics,
  ));
  await evidence.flush();
  return { kind: "completed", summary: structuredClone(stored ?? reconstructed) };
}

function assertCheckpointReplayEquivalent(checkpoint: Checkpoint, replay: ReplayResult): void {
  if (checkpoint.runtime === undefined || checkpoint.runtimeHash === undefined || replay.runtime === undefined) {
    throw new EvidenceConflictError("Latest checkpoint has no replay-verifiable runtime state");
  }
  if (
    checkpoint.tick !== replay.lastTick
    || checkpoint.seq !== replay.lastSeq
    || checkpoint.eventHash !== replay.finalEventHash
    || checkpoint.stateHash !== replay.stateHash
    || hashValue(checkpoint.state) !== replay.stateHash
    || hashValue(checkpoint.runtime) !== checkpoint.runtimeHash
    || hashValue(checkpoint.runtime) !== hashValue(replay.runtime)
  ) {
    throw new EvidenceConflictError("Latest checkpoint does not match the verified event boundary");
  }
}

async function createSummary(
  evidence: EvidenceStore,
  manifest: RunManifest,
  config: GenesisConfig,
  replay: ReplayResult,
): Promise<RunSummary> {
  assertCompletedReplay(replay, config);
  const metrics = await evidence.readMetrics();
  const latestMetrics = metrics.at(-1);
  if (!latestMetrics) throw new Error(`Run ${manifest.runId} completed without metrics`);
  assertMetricsMatchReplay(metrics, replay.state.metrics);

  return {
    schemaVersion: LAB_SCHEMA_VERSION,
    runId: manifest.runId,
    universeId: manifest.universeId,
    seed: manifest.seed,
    ticks: config.ticks,
    events: replay.eventsApplied,
    finalStateHash: replay.stateHash,
    finalEventHash: replay.finalEventHash,
    latestMetrics: structuredClone(latestMetrics),
  };
}

function assertReplayEquivalent(
  liveState: WorldState,
  replay: ReplayResult,
  config: GenesisConfig,
): void {
  assertCompletedReplay(replay, config);
  const liveHash = hashValue(liveState);
  if (liveHash !== replay.stateHash) {
    throw new Error(
      `Replay state hash mismatch for ${liveState.universeId}: live ${liveHash}, replay ${replay.stateHash}`,
    );
  }
}

function assertCompletedReplay(replay: ReplayResult, config: GenesisConfig): void {
  if (!replay.state.completed) throw new Error("Genesis event stream has no run.completed event");
  if (replay.lastTick !== config.ticks || replay.state.tick !== config.ticks) {
    throw new Error(`Genesis ended at tick ${replay.lastTick}, expected ${config.ticks}`);
  }
  if (replay.eventsApplied === 0) throw new Error("Genesis completed without events");
}

function assertMetricsMatchReplay(
  persisted: readonly MetricsSnapshot[],
  replayed: readonly MetricsSnapshot[],
): void {
  if (hashValue(persisted) !== hashValue(replayed)) {
    throw new Error("Persisted metrics do not match metrics recorded in the event stream");
  }
}
