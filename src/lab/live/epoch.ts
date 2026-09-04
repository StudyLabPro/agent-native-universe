/**
 * Genesis-Live epochs: the chain, the inherited genesis and the idempotent
 * boundary (design §4.B, phase L3a).
 *
 * A live universe's life is a chain of bounded epochs. Epoch `k` is an
 * ordinary run of this laboratory — the same `LogicalUniverse`, the same
 * reducer, the same hash chain, the same protocol verifier — that replays and
 * attests like any other. What makes it a chain is that ticks are numbered
 * absolutely (`config.ticks(k) = genesisFrom.tick + epochTicks`) and that the
 * parent's final state, event hash, state hash and runtime are pinned inside
 * `config.live.genesisFrom`, which is part of `configHash` and therefore of
 * the child's `runId`. The child's identity is a pure function of what the
 * parent left on disk.
 *
 * That is also what makes the boundary idempotent. Every step
 *
 *   1. `run.completed` in the events of `k`
 *   2. `summary.json` + `attestations/final.json` of `k`
 *   3. `chain/<k>.json`
 *   4. `manifest.json`, `config.json` and `genesis.json` of `k+1`
 *   5. `run.started{inherited}` of `k+1`
 *
 * is derived from the disk state and writes only what is missing; identical
 * bytes are tolerated by the immutable-artifact writer and differing bytes are
 * an `EvidenceConflictError`. A `kill -9` at any of those points therefore
 * converges to the same `runId(k+1)` and the same first-tick `stateHash`.
 *
 * Import discipline (enforced by `.github/scripts/check-live-isolation.mjs`):
 * nothing under `src/lab/live/` may import `src/core/*` runtime code,
 * `src/runtime/*` or `src/v2/*`, and the scientific instruments
 * (`baselines`, `population`, `pareto`, `genesis`) may not reach this file —
 * which is why `genesis.ts` and `protocol-verifier.ts` receive the live idle
 * policy as an injected factory instead of importing it.
 */
import { stat } from "node:fs/promises";
import { EvidenceConflictError, EvidenceStore, LiveChainIndex } from "../artifacts.js";
import { hashValue } from "../canonical.js";
import type { CognitionPort } from "../cognition.js";
import { compactWorldState, isExternalTask } from "../epoch-rules.js";
import { createRunEvidenceAttestation } from "../evidence-attestation.js";
import { GenesisRunPausedError, runGenesis, type GenesisRunOptions } from "../genesis.js";
import { LAB_LIVE_ENGINE_VERSION } from "../manifest.js";
import { ReplayEngine, type ReplayProjectionOptions } from "../replay.js";
import {
  LAB_LIVE_EXPERIMENT_ID,
  type Checkpoint,
  type GenesisConfig,
  type LiveChainLink,
  type LiveCompaction,
  type LiveGenesisFrom,
  type RunManifest,
  type RunSummary,
  type WorldState,
  LAB_SCHEMA_VERSION,
} from "../types.js";
import type {
  LiveEvaluatorPort,
  LivePressureSource,
  LiveRecordedInputs,
  LiveTaskSource,
} from "../live-ports.js";
import {
  assertLiveArchiveOptions,
  liveCompactionRule,
  LIVE_COMPACTION_NONE,
  type LiveArchiveOptions,
} from "./archive.js";
import {
  LiveSupervisor,
  assertLiveSupervisorOptions,
  type LiveSupervisorOptions,
} from "./supervisor.js";
import { LIVE_ORACLE_EVALUATOR_ID } from "./evaluator-port.js";
import { createLiveIdlePolicy } from "./live-idle-policy.js";
import { LIVE_DATA_ROOT_SEGMENT, LIVE_UNIVERSE_ID, createLiveEpochManifest } from "./identity.js";

/**
 * The points of the epoch boundary a caller can observe. They exist for the
 * supervisor's progress reporting (phase L3c), for the Observer's
 * `boundary: true` window, and for the crash tests that must fail a process
 * at exactly one of the design's four kill points.
 */
export type LiveBoundaryStep = "genesis_written" | "epoch_attested" | "chain_linked";

export { LIVE_COMPACTION_NONE } from "./archive.js";

export interface LiveUniverseHooks {
  /** After a durable tick boundary is on disk. Never writes evidence. */
  onCheckpoint?(checkpoint: Checkpoint): void | Promise<void>;
  onBoundaryStep?(step: LiveBoundaryStep, context: LiveBoundaryContext): void | Promise<void>;
}

export interface LiveBoundaryContext {
  epoch: number;
  runId: string;
  startTick: number;
  ticks: number;
}

/**
 * The ports an epoch takes. The three recorded-input ports arrived in phase
 * L3b; the two remaining seams are declared here so that the shape of the call
 * is fixed and a caller that supplies one gets a clear refusal instead of a
 * silently ignored argument.
 */
export interface LiveRecordedInputPorts {
  /** `FileTaskSource` / `CompositeTaskSource` over `tasks/inbox.jsonl` (L3b). */
  taskSource?: LiveTaskSource;
  /** `LlmEvaluator` / `InboxEvaluator` (L3b); absent means calibration work only. */
  evaluator?: LiveEvaluatorPort;
  /** `RecordedPressureSource` / `FilePressureSource` over `physics/inbox.jsonl` (L3b). */
  pressureSource?: LivePressureSource;
  /**
   * How the universe bounds itself at a boundary (L3c). Absent means the
   * default: an inherited genesis is compacted with the universe's own
   * `live.archive` windows. The per-tick archival is not optional — it is the
   * physics of the universe and part of every epoch's `configHash`.
   */
  archive?: LiveArchiveOptions;
  /**
   * The outage and disk guards (L3c). Absent means an unsupervised run, which
   * is what a test or a bounded audit wants; `anu lab live` always supplies
   * one. `runLiveUniverse` builds a single instance and shares it across
   * epochs, because the outage clock belongs to the provider, not the epoch.
   */
  supervisor?: LiveSupervisorOptions | LiveSupervisor;
}

export interface LiveUniverseOptions extends LiveRecordedInputPorts {
  /** Evidence root; the universe lives at `<dataRoot>/genesis-live/<universeId>/`. */
  dataRoot: string;
  universeId?: string;
  /**
   * Physics of the universe, in epoch-0 shape: `experimentId: "genesis-live"`,
   * a `live` section and no `genesisFrom`. Each epoch's own config is derived
   * from it, so the caller never hand-builds an epoch identity.
   */
  config: GenesisConfig;
  cognition: CognitionPort;
  signal?: AbortSignal;
  /** Recover a writer lease this process can prove stale (a crashed epoch). */
  recoverStaleLease?: boolean;
  /**
   * Accept a parent epoch produced by a different engine version. The accepted
   * version is recorded in the child's `genesisFrom.engineVersion` and is
   * therefore part of its `runId`; without it a chain never silently crosses
   * an engine change.
   */
  acceptParentEngine?: string;
  hooks?: LiveUniverseHooks;
}

export interface LiveEpochResult {
  epoch: number;
  runId: string;
  startTick: number;
  ticks: number;
  summary: RunSummary;
  link: LiveChainLink;
}

/** What the next epoch of a universe is, derived from the disk state alone. */
export interface LiveEpochPlan {
  epoch: number;
  manifest: RunManifest;
  config: GenesisConfig;
  /** Absent for epoch 0. */
  genesisState?: WorldState;
  parent?: LiveChainLink;
}

/**
 * The calibration realization of a live universe is one continuous stream for
 * the universe's whole life, not one per epoch: the child restores the
 * parent's task-stream cursor and RNG state from `genesisFrom.runtime`, which
 * is only possible when the stream is seeded from the universe rather than
 * from each epoch's `runId` (`taskStreamRng`, `task-stream.ts`). A universe
 * that pins its own `realizationSeed` keeps it.
 */
export function liveRealizationSeed(seed: string): string {
  return hashValue({
    domain: "agent-native-universe/lab/live/calibration-realization/v1",
    seed,
  });
}

/** The config of one epoch: absolute end tick, and the parent it continues. */
export function liveEpochConfig(base: GenesisConfig, genesisFrom?: LiveGenesisFrom): GenesisConfig {
  assertLiveUniverseConfig(base);
  const live = structuredClone(base.live!);
  const taskStream = {
    ...structuredClone(base.taskStream),
    realizationSeed: base.taskStream.realizationSeed ?? liveRealizationSeed(base.seed),
  };
  if (genesisFrom === undefined) {
    delete live.genesisFrom;
    return { ...structuredClone(base), ticks: live.epochTicks, taskStream, live };
  }
  live.genesisFrom = structuredClone(genesisFrom);
  return {
    ...structuredClone(base),
    ticks: genesisFrom.tick + live.epochTicks,
    taskStream,
    live,
  };
}

/** The universe-level config must describe the universe, not one of its epochs. */
export function assertLiveUniverseConfig(base: GenesisConfig): void {
  if (base.experimentId !== LAB_LIVE_EXPERIMENT_ID) {
    throw new Error(`A live universe requires experiment ${LAB_LIVE_EXPERIMENT_ID}; got ${base.experimentId}`);
  }
  if (base.live === undefined) throw new Error("A live universe config requires a live section");
  if (base.live.genesisFrom !== undefined) {
    throw new Error("The universe config describes epoch 0; genesisFrom is derived per epoch, never configured");
  }
}

function assertPorts(options: LiveRecordedInputPorts): void {
  if (options.archive !== undefined) assertLiveArchiveOptions(options.archive);
  if (options.supervisor !== undefined && !(options.supervisor instanceof LiveSupervisor)) {
    assertLiveSupervisorOptions(options.supervisor);
  }
  // Recorded work that nobody can grade would hang until its deadline and then
  // expire; refusing the combination up front is the honest failure.
  if (options.taskSource !== undefined && options.evaluator === undefined) {
    throw new Error("A recorded task source needs an evaluator port: external work has no oracle");
  }
}

/** The supervisor of this call, built from options or reused across epochs. */
function resolveSupervisor(options: LiveUniverseOptions): LiveSupervisor | undefined {
  if (options.supervisor === undefined) return undefined;
  if (options.supervisor instanceof LiveSupervisor) return options.supervisor;
  return new LiveSupervisor(options.dataRoot, options.supervisor);
}

/** The evaluator identity of an epoch, named even when only oracles grade. */
export function liveEvaluatorIdOf(options: LiveRecordedInputPorts): string {
  return options.evaluator?.id ?? LIVE_ORACLE_EVALUATOR_ID;
}

/** The recorded-input ports this build passes into the shared runner. */
function recordedInputsOf(options: LiveRecordedInputPorts): LiveRecordedInputs {
  return {
    ...(options.taskSource === undefined ? {} : { taskSource: options.taskSource }),
    ...(options.evaluator === undefined ? {} : { evaluator: options.evaluator }),
    ...(options.pressureSource === undefined ? {} : { pressureSource: options.pressureSource }),
  };
}

function chainIndexOf(dataRoot: string, universeId: string): LiveChainIndex {
  return new LiveChainIndex(dataRoot, LIVE_DATA_ROOT_SEGMENT, universeId);
}

/**
 * Address one epoch's evidence. Live evidence is addressed by run id, never
 * discovered: `EvidenceStore.openExisting` refuses a live manifest on purpose,
 * so no scientific reader can stumble into a live run directory.
 */
export function openLiveEpochEvidence(
  dataRoot: string,
  universeId: string,
  runId: string,
): EvidenceStore {
  return epochStore(dataRoot, universeId, runId);
}

function epochStore(dataRoot: string, universeId: string, runId: string): EvidenceStore {
  return new EvidenceStore(dataRoot, LIVE_DATA_ROOT_SEGMENT, universeId, {
    retainEvents: false,
    runId,
    live: true,
  });
}

/** The live projection every live replay and verifier of this build is given. */
export function liveReplayProjection(genesisState?: WorldState): ReplayProjectionOptions {
  return {
    live: {
      createFallbackPolicy: () => createLiveIdlePolicy("live"),
      ...(genesisState === undefined ? {} : { genesisState }),
    },
  };
}

/**
 * Which epoch runs next, and under which identity — a pure function of the
 * chain index and the parent epoch's committed evidence. Called on every
 * start and after every boundary, so a crash anywhere converges here.
 */
export async function planLiveEpoch(options: LiveUniverseOptions): Promise<LiveEpochPlan> {
  assertPorts(options);
  assertLiveUniverseConfig(options.config);
  const universeId = options.universeId ?? LIVE_UNIVERSE_ID;
  const links = await chainIndexOf(options.dataRoot, universeId).readLinks();
  const parent = links.at(-1);
  const manifestOptions = {
    cognitionId: options.cognition.id,
    evaluatorId: liveEvaluatorIdOf(options),
  };
  if (parent === undefined) {
    const config = liveEpochConfig(options.config);
    return {
      epoch: 0,
      config,
      manifest: createLiveEpochManifest(config, universeId, manifestOptions),
    };
  }
  assertParentEngine(parent.engineVersion, options.acceptParentEngine);
  const inherited = await inheritFromParent(
    options.dataRoot,
    universeId,
    parent,
    liveCompactionRule(options.config, options.archive),
  );
  // An epoch that inherits open external work must be able to grade it: the
  // grader is not a per-epoch convenience, it is part of the universe.
  if (
    options.evaluator === undefined
    && Object.values(inherited.genesisState.tasks).some((task) => (
      isExternalTask(task) && task.status !== "completed" && task.status !== "expired"
    ))
  ) {
    throw new Error("This universe carries open external work; the next epoch needs an evaluator port");
  }
  const config = liveEpochConfig(options.config, inherited.genesisFrom);
  return {
    epoch: parent.epoch + 1,
    config,
    manifest: createLiveEpochManifest(config, universeId, manifestOptions),
    genesisState: inherited.genesisState,
    parent,
  };
}

function assertParentEngine(parentEngine: string, acceptParentEngine?: string): void {
  if (parentEngine === LAB_LIVE_ENGINE_VERSION) return;
  if (acceptParentEngine !== parentEngine) {
    throw new EvidenceConflictError(
      `The parent epoch was produced by engine ${parentEngine}, not ${LAB_LIVE_ENGINE_VERSION};`
      + " pass --accept-parent-engine to continue the chain across an engine change",
    );
  }
}

interface InheritedGenesis {
  genesisFrom: LiveGenesisFrom;
  genesisState: WorldState;
}

/**
 * Read the parent epoch's committed final state and derive the genesis of the
 * child from it. The fast path is the parent's final checkpoint, cross-checked
 * against its summary; when the process died between `run.completed` and that
 * checkpoint, the same values are re-derived by replaying the parent.
 */
async function inheritFromParent(
  dataRoot: string,
  universeId: string,
  parent: LiveChainLink,
  compaction: LiveCompaction,
): Promise<InheritedGenesis> {
  const store = epochStore(dataRoot, universeId, parent.runId);
  const manifest = await store.readManifest();
  const config = await store.readConfig();
  const summary = await store.readSummary();
  if (summary === undefined) {
    throw new EvidenceConflictError(`Chained epoch ${parent.epoch} has no summary`);
  }
  if (
    summary.finalStateHash !== parent.stateHash
    || summary.finalEventHash !== parent.eventHash
    || summary.ticks !== parent.ticks
  ) {
    throw new EvidenceConflictError(`Chain link ${parent.epoch} disagrees with the epoch's summary`);
  }

  const checkpoint = await store.readCheckpoint(summary.ticks);
  let state: WorldState;
  let runtime = checkpoint?.runtime;
  if (
    checkpoint !== undefined
    && runtime !== undefined
    && checkpoint.stateHash === summary.finalStateHash
    && checkpoint.eventHash === summary.finalEventHash
    && checkpoint.seq === summary.events
    && checkpoint.state.completed
  ) {
    state = checkpoint.state;
  } else {
    const parentGenesis = await store.readGenesisState();
    const replay = await ReplayEngine.replayFile(
      store.eventsPath,
      manifest,
      config,
      undefined,
      liveReplayProjection(parentGenesis),
    );
    if (
      replay.stateHash !== summary.finalStateHash
      || replay.finalEventHash !== summary.finalEventHash
      || replay.lastSeq !== summary.events
      || replay.runtime === undefined
    ) {
      throw new EvidenceConflictError(`Replay of epoch ${parent.epoch} does not match its summary`);
    }
    state = replay.state;
    runtime = replay.runtime;
  }

  const genesisState = compactWorldState(state, compaction);
  return {
    genesisState,
    genesisFrom: {
      runId: summary.runId,
      engineVersion: manifest.engineVersion,
      tick: summary.ticks,
      seq: summary.events,
      eventHash: summary.finalEventHash,
      stateHash: summary.finalStateHash,
      runtimeHash: hashValue(runtime),
      genesisStateHash: hashValue(genesisState),
      runtime: structuredClone(runtime!),
      compaction: structuredClone(compaction),
    },
  };
}

/**
 * Run the universe's current epoch to completion and link it into the chain.
 *
 * Every step is resumable: a partially run epoch resumes from its last durable
 * tick boundary, a completed-but-unsummarised epoch is summarised and attested
 * from its own events, and an already-linked epoch is simply the parent of the
 * next call.
 */
export async function runLiveEpoch(options: LiveUniverseOptions): Promise<LiveEpochResult> {
  const universeId = options.universeId ?? LIVE_UNIVERSE_ID;
  const supervisor = resolveSupervisor(options);
  // The disk guard runs before any byte of this epoch reaches the disk: a
  // universe that starts under a full volume writes nothing at all rather than
  // a manifest it cannot follow with events.
  await supervisor?.awaitClearance(options.signal);

  const plan = await planLiveEpoch(options);
  const context: LiveBoundaryContext = {
    epoch: plan.epoch,
    runId: plan.manifest.runId,
    startTick: plan.config.ticks - plan.config.live!.epochTicks,
    ticks: plan.config.ticks,
  };

  // Boundary step 4: the child's identity and inherited genesis reach the disk
  // before its first event, so a crash between them is indistinguishable from
  // a crash before either — both re-derive exactly these bytes.
  if (!(await hasEvents(options.dataRoot, universeId, plan.manifest.runId))) {
    const prepared = epochStore(options.dataRoot, universeId, plan.manifest.runId);
    await prepared.initialize(plan.manifest, plan.config);
    if (plan.genesisState !== undefined) await prepared.writeGenesisState(plan.genesisState);
    await options.hooks?.onBoundaryStep?.("genesis_written", context);
  }

  const genesisOptions: GenesisRunOptions = {
    config: plan.config,
    runsRoot: options.dataRoot,
    universeId,
    cognition: options.cognition,
    live: {
      createFallbackPolicy: () => createLiveIdlePolicy("live"),
      ...(plan.genesisState === undefined ? {} : { genesisState: plan.genesisState }),
      evaluatorId: liveEvaluatorIdOf(options),
      recordedInputs: recordedInputsOf(options),
    },
    fsyncEveryTick: plan.config.live!.fsyncEveryTick,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.recoverStaleLease === true ? { recoverStaleLease: true } : {}),
    ...(options.hooks?.onCheckpoint === undefined ? {} : { onCheckpoint: options.hooks.onCheckpoint }),
  };
  // Boundary steps 1 and 2: `run.completed`, then `summary.json` and
  // `attestations/final.json`, both written by the shared genesis runner.
  //
  // Supervised, this is a loop rather than a call: a guard that trips aborts
  // the run, `LogicalUniverse` finishes the tick it is in and checkpoints at
  // the tick boundary, `runGenesis` reports the pause, and the next attempt
  // resumes from exactly that boundary once the guard clears. The resumed
  // epoch continues the same event chain, so its evidence is what an
  // uninterrupted epoch would have written.
  const summary = supervisor === undefined
    ? await runGenesis(genesisOptions)
    : await runSupervised(supervisor, genesisOptions, options);
  await options.hooks?.onBoundaryStep?.("epoch_attested", context);

  // Boundary step 3: the index entry. It is derived from the epoch's own
  // committed artifacts, so re-running it after a crash writes the same bytes.
  const link = await linkEpoch(options.dataRoot, universeId, plan, summary);
  await options.hooks?.onBoundaryStep?.("chain_linked", context);

  return {
    epoch: plan.epoch,
    runId: plan.manifest.runId,
    startTick: context.startTick,
    ticks: plan.config.ticks,
    summary,
    link,
  };
}

async function runSupervised(
  supervisor: LiveSupervisor,
  genesisOptions: GenesisRunOptions,
  options: LiveUniverseOptions,
): Promise<RunSummary> {
  for (;;) {
    await supervisor.awaitClearance(options.signal);
    const signal = supervisor.attach(options.signal);
    try {
      return await runGenesis({
        ...genesisOptions,
        signal,
        cognition: supervisor.instrument(options.cognition),
      });
    } catch (error) {
      // A pause the supervisor itself caused is resumable; a pause the caller
      // caused (SIGTERM) is the caller's, and is re-thrown untouched. An
      // aborted caller wins even when a guard tripped in the same tick:
      // retrying under an already-aborted signal would pause immediately and
      // for ever.
      if (
        !(error instanceof GenesisRunPausedError)
        || supervisor.pause === undefined
        || options.signal?.aborted === true
      ) throw error;
    } finally {
      supervisor.detach();
    }
  }
}

/**
 * Run `epochs` further epochs of the universe, chaining each into the next.
 *
 * One supervisor serves the whole call: the outage clock and the disk floor
 * are properties of the deployment, not of an epoch, and a provider that came
 * back mid-epoch must not have to fail three more ticks in the next one.
 */
export async function runLiveUniverse(
  options: LiveUniverseOptions & { epochs: number },
): Promise<LiveEpochResult[]> {
  if (!Number.isSafeInteger(options.epochs) || options.epochs < 1) {
    throw new RangeError("epochs must be a positive safe integer");
  }
  const supervisor = resolveSupervisor(options);
  const shared: LiveUniverseOptions = supervisor === undefined
    ? options
    : { ...options, supervisor };
  const results: LiveEpochResult[] = [];
  for (let index = 0; index < options.epochs; index += 1) {
    results.push(await runLiveEpoch(shared));
  }
  return results;
}

async function hasEvents(dataRoot: string, universeId: string, runId: string): Promise<boolean> {
  try {
    await stat(epochStore(dataRoot, universeId, runId).eventsPath);
    return true;
  } catch {
    return false;
  }
}

async function linkEpoch(
  dataRoot: string,
  universeId: string,
  plan: LiveEpochPlan,
  summary: RunSummary,
): Promise<LiveChainLink> {
  const store = epochStore(dataRoot, universeId, plan.manifest.runId);
  const attestation = await store.readFinalAttestation();
  if (attestation === undefined) {
    throw new EvidenceConflictError(`Epoch ${plan.epoch} completed without a final attestation`);
  }
  const link: LiveChainLink = {
    schemaVersion: LAB_SCHEMA_VERSION,
    epoch: plan.epoch,
    universeId,
    runId: plan.manifest.runId,
    ...(plan.parent === undefined ? {} : { parentRunId: plan.parent.runId }),
    startTick: plan.config.ticks - plan.config.live!.epochTicks,
    ticks: plan.config.ticks,
    eventHash: summary.finalEventHash,
    stateHash: summary.finalStateHash,
    commitment: attestation.commitment,
    ...(plan.parent === undefined ? {} : { parentCommitment: plan.parent.commitment }),
    engineVersion: plan.manifest.engineVersion,
    cognitionId: plan.manifest.cognitionId!,
  };
  await chainIndexOf(dataRoot, universeId).writeLink(link);
  return link;
}

export interface LiveChainEpochVerification {
  epoch: number;
  runId: string;
  startTick: number;
  ticks: number;
  stateHash: string;
  eventHash: string;
  commitment: string;
  events: number;
}

export interface LiveChainVerification {
  universeId: string;
  epochs: LiveChainEpochVerification[];
  /** State hash of the last epoch's final tick — the universe's current state. */
  finalStateHash: string;
  finalTick: number;
}

/**
 * The full audit: replay the chain from epoch 0.
 *
 * Every epoch is verified by the same protocol verifier that verified it while
 * it ran, its summary and attestation are recomputed rather than trusted, and
 * each boundary is re-derived — the child's inherited genesis must be exactly
 * what the compaction rule produces from the parent's replayed final state,
 * and the child's identity must be exactly what that genesis implies.
 */
export async function verifyLiveChain(options: {
  dataRoot: string;
  universeId?: string;
}): Promise<LiveChainVerification> {
  const universeId = options.universeId ?? LIVE_UNIVERSE_ID;
  const links = await chainIndexOf(options.dataRoot, universeId).readLinks();
  if (links.length === 0) throw new EvidenceConflictError(`Live universe ${universeId} has no chained epoch`);

  const epochs: LiveChainEpochVerification[] = [];
  let parentState: WorldState | undefined;
  let parentLink: LiveChainLink | undefined;
  for (const link of links) {
    const store = epochStore(options.dataRoot, universeId, link.runId);
    const manifest = await store.readManifest();
    const config = await store.readConfig();
    const genesisState = await store.readGenesisState();
    const genesisFrom = config.live?.genesisFrom;

    if ((link.epoch === 0) !== (genesisFrom === undefined)) {
      throw new EvidenceConflictError(`Epoch ${link.epoch} inherits exactly when it is not epoch 0`);
    }
    if (genesisFrom !== undefined) {
      if (parentState === undefined || parentLink === undefined) {
        throw new EvidenceConflictError(`Epoch ${link.epoch} has no verified parent`);
      }
      if (
        genesisFrom.runId !== parentLink.runId
        || genesisFrom.stateHash !== parentLink.stateHash
        || genesisFrom.eventHash !== parentLink.eventHash
        || genesisFrom.tick !== parentLink.ticks
        || link.parentRunId !== parentLink.runId
        || link.parentCommitment !== parentLink.commitment
      ) {
        throw new EvidenceConflictError(`Epoch ${link.epoch} does not continue epoch ${parentLink.epoch}`);
      }
      // The inherited genesis is re-derived, never trusted: it must be exactly
      // what this build's compaction rule produces from the parent's replayed
      // final state.
      const rederived = compactWorldState(parentState, genesisFrom.compaction);
      if (genesisState === undefined || hashValue(genesisState) !== hashValue(rederived)) {
        throw new EvidenceConflictError(`Epoch ${link.epoch} genesis state is not derived from its parent`);
      }
      if (hashValue(genesisState) !== genesisFrom.genesisStateHash) {
        throw new EvidenceConflictError(`Epoch ${link.epoch} genesis state does not match its genesisFrom`);
      }
    }

    const replay = await ReplayEngine.replayFile(
      store.eventsPath,
      manifest,
      config,
      undefined,
      liveReplayProjection(genesisState),
    );
    if (
      replay.stateHash !== link.stateHash
      || replay.finalEventHash !== link.eventHash
      || replay.lastTick !== config.ticks
      || config.ticks !== link.ticks
    ) {
      throw new EvidenceConflictError(`Replay of epoch ${link.epoch} does not match its chain link`);
    }

    const summary = await store.readSummary();
    const metrics = await store.readMetrics();
    const stored = await store.readFinalAttestation();
    if (summary === undefined || stored === undefined) {
      throw new EvidenceConflictError(`Epoch ${link.epoch} is not fully attested`);
    }
    if (summary.finalStateHash !== replay.stateHash || summary.events !== replay.eventsApplied) {
      throw new EvidenceConflictError(`Summary of epoch ${link.epoch} does not match its replay`);
    }
    const recomputed = createRunEvidenceAttestation(manifest, config, summary, metrics);
    if (hashValue(recomputed) !== hashValue(stored) || stored.commitment !== link.commitment) {
      throw new EvidenceConflictError(`Attestation of epoch ${link.epoch} does not match its evidence`);
    }

    epochs.push({
      epoch: link.epoch,
      runId: link.runId,
      startTick: link.startTick,
      ticks: config.ticks,
      stateHash: replay.stateHash,
      eventHash: replay.finalEventHash,
      commitment: stored.commitment,
      events: replay.eventsApplied,
    });
    parentState = replay.state;
    parentLink = link;
  }

  const last = epochs.at(-1)!;
  return {
    universeId,
    epochs,
    finalStateHash: last.stateHash,
    finalTick: last.ticks,
  };
}
