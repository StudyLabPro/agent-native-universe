import type { JsonObject, JsonValue } from "../core/types.js";
import { assertRoleNeutralGenesis, createGenesisAgents } from "./agent-factory.js";
import { createCapabilityState, executeCapabilityPlan } from "./capability-registry.js";
import { hashValue } from "./canonical.js";
import { validateGenesisConfig } from "./config.js";
import { createObservationFrame, observeWorldFromFrame } from "./environment.js";
import {
  LIVE_COGNITION_OVERDRAFT_REASON,
  LiveExhaustionTracker,
  calibrationTaskCount,
  epochBoundaryExpiries,
  inheritedGenesisOf,
  isExternalTask,
  liveThinkingDebit,
  openTaskBacklog,
  planLiveArchive,
  proportionalReward,
} from "./epoch-rules.js";
import type { LiveRecordedInputs } from "./live-ports.js";
import { IndependentEvaluator, type PendingOracle } from "./evaluator.js";
import type { LabEventRecorder } from "./event-recorder.js";
import { createLabEvent } from "./events.js";
import { deterministicId } from "./ids.js";
import {
  LAB_COGNITIVE_ENGINE_VERSION,
  LAB_ENGINE_VERSION,
  LAB_LIVE_ENGINE_VERSION,
  LAB_LIVE_TASK_SOURCE_ID,
  LAB_POLICY_ID,
  LAB_TASK_GENERATOR_ID,
  createRunManifest,
} from "./manifest.js";
import { computeMetrics } from "./metrics.js";
import { CohortPolicy, type CognitionPort, type CognitionRecord } from "./cognition.js";
import { NeutralPolicy } from "./neutral-policy.js";
import {
  decidePolicyTick,
  type LogicalPolicy,
  type PolicyDecision,
} from "./policy-schedule.js";
import { PressureEngine, pressureEffect } from "./pressure-engine.js";
import { initialWorldState, prepareWorldEventTransition } from "./reducer.js";
import { RESOURCE_KINDS, ResourcePhysics } from "./resource-physics.js";
import { DeterministicRng } from "./rng.js";
import { DeterministicTaskStream, taskStreamRng } from "./task-stream.js";
import {
  LAB_SCHEMA_VERSION,
  PPM,
  ZERO_RESOURCES,
  type Checkpoint,
  type Evaluation,
  type GenesisConfig,
  type LabEvent,
  type LabEventDraft,
  type MetricsSnapshot,
  type Observation,
  type PrimitiveActionType,
  type ResourceVector,
  type RunManifest,
  type SubmissionState,
  type WorldState,
} from "./types.js";

export type { LogicalPolicy } from "./policy-schedule.js";

export interface LogicalUniverseOptions {
  policy?: LogicalPolicy;
  /**
   * Consulted asynchronously before each decision phase. Every answer is
   * committed as evidence, so a cognitive run stays replayable without ever
   * asking a model twice.
   */
  cognition?: CognitionPort;
  onMetrics?: (snapshot: MetricsSnapshot) => void | Promise<void>;
  onCheckpoint?: (checkpoint: Checkpoint) => void | Promise<void>;
  /** A replay-verified durable boundary from this exact recorder and manifest. */
  resumeFrom?: Checkpoint;
  /**
   * Oracles still open (registered but neither expired nor evaluated) as of
   * `resumeFrom.tick`, independently reconstructed by replaying the event
   * stream from genesis. Only meaningful alongside `resumeFrom`: a fresh run
   * populates the evaluator itself as it generates tasks. Never persisted —
   * the caller recomputes this on every resume rather than reading it back
   * from a checkpoint, which never carries it.
   */
  pendingOracles?: readonly PendingOracle[];
  /**
   * Fsync the event log immediately after every `tick.completed`, not only at
   * pause or completion. Durability only: it changes when bytes already
   * written reach disk, never which bytes are written or their content, so it
   * cannot affect any hash in the chain.
   */
  fsyncEveryTick?: boolean;
  /**
   * The inherited genesis of a live epoch `k+1` (`genesis.json`), required
   * exactly when `config.live.genesisFrom` is present. The world continues
   * from it at absolute tick `genesisFrom.tick` instead of creating a genesis
   * population. Live-only: a logical or cognitive manifest refuses it.
   */
  genesisState?: WorldState;
  /**
   * The recorded-input ports of a live epoch (phase L3b): external work,
   * verdicts and operator physics. Live-only, and each is optional: a live
   * universe with no inbox simply runs on calibration work alone.
   */
  recordedInputs?: LiveRecordedInputs;
}

const UNSUPPORTED_ACTIONS = new Set<PrimitiveActionType>([
  "spawn", "clone", "merge", "reserve", "trade",
]);

/** Deterministic, event-sourced logical Genesis universe. */
export class LogicalUniverse {
  readonly manifest: RunManifest;
  readonly config: GenesisConfig;
  readonly recorder: LabEventRecorder;

  readonly #policy: LogicalPolicy;
  readonly #cognition: CognitionPort | undefined;
  readonly #onMetrics: LogicalUniverseOptions["onMetrics"];
  readonly #onCheckpoint: LogicalUniverseOptions["onCheckpoint"];
  readonly #fsyncEveryTick: boolean;
  readonly #physics = new ResourcePhysics();
  readonly #evaluator = new IndependentEvaluator();
  readonly #pressure: PressureEngine;
  readonly #taskStream: DeterministicTaskStream;
  readonly #policyRng: DeterministicRng;
  readonly #pressureRng: DeterministicRng;
  readonly #resolutionRng: DeterministicRng;
  readonly #initialAgentTotals: ResourceVector;
  readonly #live: boolean;
  readonly #recordedInputs: LiveRecordedInputs;
  readonly #exhaustion = new LiveExhaustionTracker();

  #world: WorldState;
  #initialTotal: ResourceVector | undefined;
  /** Absolute tick of this run's genesis: 0, or the parent's final tick. */
  #genesisTick = 0;
  #nextTick = 1;
  #initialized = false;
  #tickRunning = false;
  #lastCheckpointTick: number | undefined;
  #observations: Observation[] = [];

  constructor(
    manifest: RunManifest,
    config: GenesisConfig,
    recorder: LabEventRecorder,
    options: LogicalUniverseOptions = {},
  ) {
    validateGenesisConfig(config);
    if (manifest.schemaVersion !== LAB_SCHEMA_VERSION) throw new Error("Manifest schema does not match the lab");
    const cognitiveMode = manifest.mode === "cognitive";
    const liveMode = manifest.mode === "live";
    const expectedEngine = liveMode
      ? LAB_LIVE_ENGINE_VERSION
      : cognitiveMode ? LAB_COGNITIVE_ENGINE_VERSION : LAB_ENGINE_VERSION;
    if (
      manifest.engineVersion !== expectedEngine
      || (manifest.mode !== "logical" && !cognitiveMode && !liveMode)
      || manifest.taskGeneratorId !== (liveMode ? LAB_LIVE_TASK_SOURCE_ID : LAB_TASK_GENERATOR_ID)
    ) {
      throw new Error("Manifest implementation identity does not match this logical engine");
    }
    // A live epoch is steered by recorded answers exactly like a cohort, so it
    // requires a cognition port too; an unsteered live agent idles through
    // `LiveIdlePolicy` rather than falling back to a computed answer.
    if ((cognitiveMode || liveMode) !== (options.cognition !== undefined)) {
      throw new Error("A cognitive manifest requires a cognition port, and a logical manifest forbids one");
    }
    if (options.cognition !== undefined && options.cognition.id !== manifest.cognitionId) {
      throw new Error("Cognition port identity must exactly match manifest.cognitionId");
    }
    if (manifest.experimentId !== config.experimentId) throw new Error("Manifest experiment does not match config");
    if (manifest.seed !== config.seed) throw new Error("Manifest seed does not match config");
    if (manifest.configHash !== hashValue(config)) throw new Error("Manifest configHash does not match config");
    if (recorder.manifest.runId !== manifest.runId || recorder.manifest.universeId !== manifest.universeId) {
      throw new Error("Recorder belongs to another run or universe");
    }

    const expectedManifest = createRunManifest(config, manifest.universeId, {
      policyId: manifest.policyId,
      mode: manifest.mode,
      ...(manifest.cognitionId === undefined ? {} : { cognitionId: manifest.cognitionId }),
      ...(manifest.evaluatorId === undefined ? {} : { evaluatorId: manifest.evaluatorId }),
    });
    if (hashValue(manifest) !== hashValue(expectedManifest)) {
      throw new Error("Manifest identity or runId is not deterministic for this config and policy");
    }
    if (manifest.policyId === LAB_POLICY_ID && options.policy !== undefined) {
      throw new Error("The manifest-bound neutral policy cannot be overridden");
    }
    if (manifest.policyId !== LAB_POLICY_ID) {
      if (options.policy === undefined || options.policy.id !== manifest.policyId) {
        throw new Error("Custom policy identity must exactly match manifest.policyId");
      }
    }

    this.manifest = structuredClone(manifest);
    this.config = structuredClone(config);
    this.recorder = recorder;
    this.#policy = options.policy ?? new NeutralPolicy();
    this.#cognition = options.cognition;
    this.#onMetrics = options.onMetrics;
    this.#onCheckpoint = options.onCheckpoint;
    this.#fsyncEveryTick = options.fsyncEveryTick === true;
    this.#live = liveMode;
    if (!liveMode && options.recordedInputs !== undefined) {
      throw new Error("Recorded inputs belong to a live epoch only");
    }
    this.#recordedInputs = options.recordedInputs ?? {};
    const rootRng = new DeterministicRng(hashValue({
      domain: "agent-native-universe/lab/logical-universe/v1",
      runId: manifest.runId,
      universeId: manifest.universeId,
      seed: config.seed,
    }));
    this.#taskStream = new DeterministicTaskStream(config.taskStream, taskStreamRng(config.taskStream, rootRng));
    this.#pressure = new PressureEngine(config.pressures);
    this.#policyRng = rootRng.fork("policy");
    this.#pressureRng = rootRng.fork("pressure");
    this.#resolutionRng = rootRng.fork("resolution");
    const genesisFrom = liveMode ? config.live?.genesisFrom : undefined;
    if ((genesisFrom !== undefined) !== (options.genesisState !== undefined)) {
      throw new Error("An inherited live epoch requires exactly the genesis state its genesisFrom pins");
    }
    if (genesisFrom !== undefined && options.genesisState !== undefined) {
      if (hashValue(options.genesisState) !== genesisFrom.genesisStateHash) {
        throw new Error("Inherited genesis state does not match live.genesisFrom.genesisStateHash");
      }
      if (options.genesisState.tick !== genesisFrom.tick || options.genesisState.runId !== genesisFrom.runId) {
        throw new Error("Inherited genesis state does not belong to the pinned parent epoch");
      }
    }
    this.#world = initialWorldState(manifest, options.genesisState);
    this.#genesisTick = this.#world.tick;
    this.#initialAgentTotals = multiplyResources(config.initialResources, config.agents);
    if (genesisFrom !== undefined) {
      // One continuous realization across the universe's life: the child
      // resumes the parent's deterministic streams instead of restarting them.
      this.#taskStream.restore(genesisFrom.runtime.taskStream);
      if (genesisFrom.runtime.policy !== null) {
        if (this.#policy.restore === undefined) {
          throw new Error("The live fallback policy does not support deterministic continuation");
        }
        this.#policy.restore(genesisFrom.runtime.policy, this.#policyRng);
      }
      // The grace period of exhaustion is continuous over the life of the
      // universe, not restarted every epoch.
      this.#exhaustion.restore(genesisFrom.runtime.exhaustion);
      this.#nextTick = genesisFrom.tick + 1;
    }
    if (options.resumeFrom !== undefined) this.#restore(options.resumeFrom);
    // Independently reconstructed by the caller (genesis.ts) from a replay of
    // the event stream, never read back from the checkpoint itself: the
    // evaluator's oracle map is in-memory-only bookkeeping the world would
    // otherwise have rebuilt one #generateTasks call at a time, which resume
    // skips for every tick at or before the checkpoint.
    for (const oracle of options.pendingOracles ?? []) {
      this.#evaluator.registerOracle(oracle.taskId, oracle.expected);
    }
  }

  static create(
    manifest: RunManifest,
    config: GenesisConfig,
    recorder: LabEventRecorder,
    options: LogicalUniverseOptions = {},
  ): LogicalUniverse {
    return new LogicalUniverse(manifest, config, recorder, options);
  }

  state(): WorldState {
    return structuredClone(this.#world);
  }

  lastObservations(): Observation[] {
    return structuredClone(this.#observations);
  }

  async initialize(): Promise<WorldState> {
    await this.#ensureInitialized();
    return this.state();
  }

  async run(signal?: AbortSignal): Promise<WorldState> {
    await this.#ensureInitialized();
    if (signal?.aborted) return this.#pauseAtBoundary();
    while (this.#nextTick <= this.config.ticks) {
      // The signal reaches the cognition port: an abort withdraws in-flight
      // consultations, the tick finishes with what was recorded, and the
      // universe pauses at the boundary below instead of mid-tick.
      await this.#advanceTick(signal);
      if (signal?.aborted) return this.#pauseAtBoundary();
    }
    if (!this.#world.completed) {
      await this.#commit({
        tick: this.config.ticks,
        phase: "completion",
        type: "run.completed",
        data: { ticks: this.config.ticks, events: this.recorder.lastSeq + 1 },
      });
      await this.#emitCheckpoint(this.config.ticks);
    }
    return this.state();
  }

  async #pauseAtBoundary(): Promise<WorldState> {
    if (this.#onCheckpoint === undefined) {
      throw new Error("Cannot pause a logical universe without a durable checkpoint sink");
    }
    await this.#emitCheckpoint(this.#world.tick);
    return this.state();
  }

  async #emitCheckpoint(tick: number): Promise<void> {
    if (this.#onCheckpoint === undefined || this.#lastCheckpointTick === tick) return;
    await this.#onCheckpoint(this.#checkpoint(tick));
    this.#lastCheckpointTick = tick;
  }

  async tick(): Promise<WorldState> {
    await this.#ensureInitialized();
    await this.#advanceTick();
    return this.state();
  }

  async #ensureInitialized(): Promise<void> {
    if (this.#initialized) return;
    if (this.recorder.lastSeq !== 0) throw new Error("LogicalUniverse v1 requires an empty event recorder");

    const genesisFrom = this.manifest.mode === "live" ? this.config.live?.genesisFrom : undefined;
    if (genesisFrom !== undefined) {
      // An inherited epoch has no genesis population: its agents, links and
      // open tasks are the parent's, and its first event states which parent
      // and which inherited state it continues (every value pinned in
      // `config.live.genesisFrom`, so the claim is verifiable).
      await this.#commit({
        tick: this.#genesisTick,
        phase: "genesis",
        type: "run.started",
        data: toJsonObject({
          treasury: this.#world.treasury,
          inherited: inheritedGenesisOf(genesisFrom),
        }),
      });
      this.#initialTotal = totalResources(this.#world);
      this.#initialized = true;
      return;
    }

    await this.#commit({
      tick: 0,
      phase: "genesis",
      type: "run.started",
      data: toJsonObject({ treasury: this.config.treasuryResources }),
    });
    const agents = createGenesisAgents(this.config);
    assertRoleNeutralGenesis(agents);
    for (const agent of agents) {
      await this.#commit({
        tick: 0,
        phase: "genesis",
        type: "agent.created",
        actorId: agent.id,
        data: toJsonObject({ agent }),
      });
    }
    this.#initialTotal = totalResources(this.#world);
    this.#initialized = true;
  }

  #restore(checkpoint: Checkpoint): void {
    if (checkpoint.runtime === undefined || checkpoint.runtimeHash === undefined) {
      throw new Error("Legacy checkpoint has no resumable runtime state");
    }
    if (hashValue(checkpoint.runtime) !== checkpoint.runtimeHash) {
      throw new Error("Checkpoint runtime hash mismatch");
    }
    if (
      checkpoint.runId !== this.manifest.runId
      || checkpoint.universeId !== this.manifest.universeId
      || checkpoint.state.runId !== this.manifest.runId
      || checkpoint.state.universeId !== this.manifest.universeId
      || checkpoint.state.configHash !== this.manifest.configHash
    ) {
      throw new Error("Checkpoint belongs to another logical universe");
    }
    if (
      checkpoint.tick !== checkpoint.state.tick
      || checkpoint.seq !== this.recorder.lastSeq
      || checkpoint.eventHash !== this.recorder.lastHash
      || hashValue(checkpoint.state) !== checkpoint.stateHash
    ) {
      throw new Error("Checkpoint does not match the durable event boundary");
    }
    if (!checkpoint.state.started || checkpoint.state.completed || checkpoint.tick > this.config.ticks) {
      throw new Error("Checkpoint is not an incomplete resumable world boundary");
    }
    if (
      this.#policy.checkpoint === undefined
      || this.#policy.restore === undefined
      || checkpoint.runtime.policy === null
    ) {
      throw new Error("The selected logical policy does not support deterministic resume");
    }
    this.#taskStream.restore(checkpoint.runtime.taskStream);
    this.#policy.restore(checkpoint.runtime.policy, this.#policyRng);
    this.#exhaustion.restore(checkpoint.runtime.exhaustion);
    this.#world = structuredClone(checkpoint.state);
    this.#nextTick = checkpoint.tick + 1;
    this.#initialTotal = totalResources(this.#world);
    this.#lastCheckpointTick = checkpoint.tick;
    this.#initialized = true;
  }

  async #advanceTick(signal?: AbortSignal): Promise<void> {
    if (this.#world.completed) throw new Error("Run is already completed");
    if (this.#nextTick > this.config.ticks) throw new Error("Configured tick limit reached");
    if (this.#tickRunning) throw new Error("A logical tick is already running");
    this.#tickRunning = true;
    const tick = this.#nextTick;
    try {
      await this.#applyPressures(tick, signal);
      await this.#expireTasks(tick);
      await this.#generateTasks(tick, signal);
      await this.#consultCognition(tick, signal);
      const decisions = await this.#decide(tick);
      const pendingEvaluation: string[] = [];
      const ordered = this.#resolutionRng.fork(tick).shuffle(decisions);
      for (const decision of ordered) await this.#resolve(decision, tick, pendingEvaluation);
      await this.#evaluate(pendingEvaluation, tick, signal);

      const recordMetrics = tick % this.config.metricEvery === 0 || tick === this.config.ticks;
      if (recordMetrics) {
        const metrics = computeMetrics(this.#world, this.#initialAgentTotals);
        await this.#commit({
          tick,
          phase: "metrics",
          type: "metrics.recorded",
          data: toJsonObject({ metrics }),
        });
        await this.#onMetrics?.(structuredClone(metrics));
      }

      // Upkeep. An agent that can no longer think and holds no work leaves the
      // world first, so the boundary sweep below sees the settled population.
      await this.#reviewExhaustion(tick);
      // Upkeep of the final tick: nothing with a hidden oracle may cross into
      // the next epoch, because oracles live only in memory.
      await this.#expireAtEpochBoundary(tick);
      // The bounded world: settled records leave the live state last, once
      // this tick's retirements and expiries have settled what they settle.
      await this.#archiveSettled(tick);

      await this.#commit({
        tick,
        phase: "upkeep",
        type: "tick.completed",
        data: { tick },
      });
      // Durability only: every byte here was already written and hashed by
      // #commit above. This changes only when they reach disk, never what
      // they are, so it cannot move any hash in the chain.
      if (this.#fsyncEveryTick) await this.recorder.flush();
      this.#nextTick += 1;
      this.#assertConserved();

      const checkpoint = tick % this.config.checkpointEvery === 0 && tick !== this.config.ticks;
      if (checkpoint) await this.#emitCheckpoint(tick);
    } finally {
      this.#tickRunning = false;
    }
  }

  async #applyPressures(tick: number, signal?: AbortSignal): Promise<void> {
    // One random source for the whole tick's physics, forked from the run's
    // root: the configured schedule (a bounded run) and the recorded operator
    // physics (a live epoch) draw from the same stream in event order, and a
    // fork is consumption-independent, so neither can shift the other.
    const rng = this.#pressureRng.fork(tick);
    // The configured schedule, in exactly the shape it has always had: every
    // scheduled pressure of the tick, then the retirements the tick's
    // `retire_agent_fraction` caused. Nothing about a bounded run changes.
    const result = this.#pressure.forTick(tick, this.#world, rng);
    let retirementPressure: LabEvent | undefined;
    for (const event of result.events) {
      const committed = await this.#commit(event);
      if (committed.data.type === "retire_agent_fraction") retirementPressure = committed;
    }
    for (const agentId of result.retiredAgentIds) {
      if (!retirementPressure) throw new Error("Retirement pressure has no committed causal event");
      await this.#retireByPressure(agentId, tick, retirementPressure.eventId);
    }
    // Recorded operator physics. The control plane sets physics and only
    // physics: the parser refuses a record addressed to an agent, and a
    // `retire_agent_fraction` still draws its victims from `pressureRng`.
    const recorded = await this.#recordedInputs.pressureSource?.next(tick, signal) ?? [];
    for (const spec of recorded) {
      if (spec.tick !== tick) throw new Error("A recorded pressure must apply on its own tick");
      const effect = pressureEffect(tick, spec, this.#world, rng);
      const committed = await this.#commit(effect.event);
      for (const agentId of effect.retiredAgentIds) {
        await this.#retireByPressure(agentId, tick, committed.eventId);
      }
    }
  }

  async #retireByPressure(agentId: string, tick: number, causationId: string): Promise<void> {
    await this.#commit({
      tick,
      phase: "pressure",
      type: "agent.retired",
      actorId: agentId,
      causationId,
      data: { agentId, retiredTick: tick, reason: "pressure" },
    });
  }

  /**
   * Retirement by exhaustion: an agent that has held too few `llmTokens` to be
   * consulted for `live.exhaustion.graceTicks` consecutive ticks, and holds no
   * claimed work, leaves the world. The rule is a pure function of the states
   * it has seen (`LiveExhaustionTracker`), so the protocol verifier regenerates
   * it rather than trusting the event.
   */
  async #reviewExhaustion(tick: number): Promise<void> {
    for (const agentId of this.#exhaustion.review(this.manifest, this.config, this.#world)) {
      await this.#commit({
        tick,
        phase: "upkeep",
        type: "agent.retired",
        actorId: agentId,
        data: { agentId, retiredTick: tick, reason: "exhausted" },
      });
    }
  }

  /**
   * The bounded world (phase L3c).
   *
   * A universe with no end must keep a working set of bounded size, so the
   * upkeep of every live tick removes the records that have settled and aged
   * past their window: submissions first, then the tasks whose last submission
   * just left, then delivered mail. Nothing is lost — every archived record is
   * still in this epoch's append-only log, and a replay of the chain from
   * epoch 0 reconstructs all of it. What leaves is the *state*, not the
   * evidence.
   *
   * The plan is a pure function of the state (`planLiveArchive`), so the
   * protocol verifier regenerates it instead of trusting these events, and
   * demands at `tick.completed` that nothing archivable was left behind.
   */
  async #archiveSettled(tick: number): Promise<void> {
    const plan = planLiveArchive(this.manifest, this.config, tick, this.#world);
    for (const submissionId of plan.submissions) {
      await this.#commit({
        tick,
        phase: "upkeep",
        type: "submission.archived",
        data: { submissionId },
      });
    }
    for (const taskId of plan.tasks) {
      await this.#commit({ tick, phase: "upkeep", type: "task.archived", data: { taskId } });
    }
    for (const messageId of plan.messages) {
      await this.#commit({ tick, phase: "upkeep", type: "message.archived", data: { messageId } });
    }
  }

  async #expireTasks(tick: number): Promise<void> {
    const expired = Object.values(this.#world.tasks)
      .filter((task) => (
        (task.status === "available" || task.status === "claimed")
        && task.deadlineTick < tick
      ))
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    for (const task of expired) {
      await this.#commit({
        tick,
        phase: "task_generation",
        type: "task.expired",
        data: { taskId: task.id },
      });
    }
  }

  /**
   * The last upkeep of a live epoch expires every calibration task still open,
   * so no hidden oracle has to survive the boundary. External tasks (phase
   * L3b) have no oracle and are deliberately left to cross.
   */
  async #expireAtEpochBoundary(tick: number): Promise<void> {
    for (const task of epochBoundaryExpiries(this.manifest, this.config, tick, this.#world)) {
      await this.#commit({
        tick,
        phase: "upkeep",
        type: "task.expired",
        data: { taskId: task, reason: "epoch_boundary" },
      });
    }
  }

  async #generateTasks(tick: number, signal?: AbortSignal): Promise<void> {
    const capacity = Math.max(0, this.config.taskStream.maxBacklog - openTaskBacklog(this.#world));
    const scaled = safePpmMultiply(this.config.taskStream.tasksPerTick, this.#world.physics.taskLoadPpm);
    const count = calibrationTaskCount(this.manifest, this.config, tick, Math.min(capacity, scaled));
    for (const generated of this.#taskStream.generate(tick, count)) {
      this.#evaluator.registerOracle(generated.task.id, generated.expected);
      await this.#commit({
        tick,
        phase: "task_generation",
        type: "task.created",
        data: toJsonObject({ task: generated.task }),
      });
    }
    await this.#admitRecordedTasks(tick, signal);
  }

  /**
   * Recorded external work, admitted after the tick's calibration work so the
   * verifier can regenerate the calibration prefix and then accept the
   * recorded remainder by form. An external task carries no hidden oracle, so
   * it is the one kind of work allowed to outlive its epoch.
   */
  async #admitRecordedTasks(tick: number, signal?: AbortSignal): Promise<void> {
    const source = this.#recordedInputs.taskSource;
    if (source === undefined) return;
    const capacity = Math.max(0, this.config.taskStream.maxBacklog - openTaskBacklog(this.#world));
    if (capacity === 0) return;
    for (const task of await source.next(tick, capacity, signal)) {
      if (!isExternalTask(task)) throw new Error("A recorded task source may only produce external tasks");
      if (this.#world.tasks[task.id] !== undefined) {
        throw new Error(`Recorded external task ${task.id} is already in the world`);
      }
      if (openTaskBacklog(this.#world) >= this.config.taskStream.maxBacklog) return;
      await this.#commit({
        tick,
        phase: "task_generation",
        type: "task.created",
        data: toJsonObject({ task, source: "external" }),
      });
    }
  }

  /**
   * The asynchronous half of cognition.
   *
   * Answers are committed before any of them is acted on, so the evidence
   * records what the model said independently of what the world then did with
   * it — including answers that were rejected as unusable.
   */
  async #consultCognition(tick: number, signal?: AbortSignal): Promise<void> {
    const cognition = this.#cognition;
    if (cognition === undefined) return;
    const policy = this.#policy;
    if (!(policy instanceof CohortPolicy)) return;

    const agentIds = Object.keys(this.#world.agents)
      .filter((agentId) => this.#world.agents[agentId]?.active)
      .sort();
    // The same pure projection the decision phase will use. It consumes no
    // randomness, so consulting a model cannot shift the deterministic streams.
    const frame = createObservationFrame(this.#world, tick);
    const requests = agentIds.flatMap((agentId) => {
      const agent = this.#world.agents[agentId];
      if (agent === undefined) return [];
      return [{
        tick,
        agentId,
        observation: observeWorldFromFrame(frame, agentId),
        agent: structuredClone(agent),
      }];
    });
    if (requests.length === 0) {
      policy.load([]);
      return;
    }

    let records: CognitionRecord[] = [];
    try {
      records = await cognition.propose(requests, signal);
    } catch (error) {
      // Losing the provider must not lose the tick: the population simply falls
      // back to the neutral policy, and the failure is on record below.
      records = [{
        tick,
        agentId: requests[0]!.agentId,
        cohort: cognition.cohort,
        provider: "unavailable",
        model: "unavailable",
        content: "",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        latencyMs: 0,
        actions: [],
        rejected: `cognition failure: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
      }];
    }

    for (const record of records) {
      // The tier is what the world charges for, so in live mode it is part of
      // the evidence rather than an implementation detail of the port. It is
      // schema-additive: no cognitive-cohort record carries it.
      if (this.#live && record.tier === undefined) {
        throw new Error("A live cognition record must state the tier it was consulted at");
      }
      const committed = await this.#commit({
        tick,
        phase: "observation",
        type: "cognition.recorded",
        actorId: record.agentId,
        data: toJsonObject({
          cohort: record.cohort,
          provider: record.provider,
          model: record.model,
          content: record.content,
          usage: record.usage,
          latencyMs: record.latencyMs,
          actions: record.actions,
          ...(record.rejected === undefined ? {} : { rejected: record.rejected }),
          // Schema-additive: absent from every record written before them.
          ...(record.reasoningTokens === undefined ? {} : { reasoningTokens: record.reasoningTokens }),
          ...(record.finishReason === undefined ? {} : { finishReason: record.finishReason }),
          ...(record.truncated === true ? { truncated: true } : {}),
          ...(record.tier === undefined ? {} : { tier: record.tier }),
        }),
      });
      await this.#chargeThinking(committed, record, tick);
    }
    policy.load(records);
  }

  /**
   * The price of one recorded thought, charged immediately after the thought
   * is on record and caused by it.
   *
   * Thinking is the one thing a live agent does that the world cannot observe
   * happening: the tokens were already burned outside the chain. Charging for
   * them right here is what makes the economy of thinking real — an agent that
   * only thinks spends itself down to nothing and is eventually retired — and
   * charging them with `causationId` pointing at the record is what makes
   * "the debit always immediately follows the record" a checkable claim.
   */
  async #chargeThinking(record: LabEvent, answer: CognitionRecord, tick: number): Promise<void> {
    if (!this.#live || answer.tier === undefined) return;
    if (answer.usage.totalTokens <= 0) return;
    const agent = this.#world.agents[answer.agentId];
    if (agent === undefined || !agent.active) return;
    const debit = liveThinkingDebit(
      this.config,
      this.#world.physics,
      answer.tier,
      answer.usage.totalTokens,
      agent.resources,
    );
    const spent = await this.#commit({
      tick,
      phase: "observation",
      type: "resource.spent",
      actorId: answer.agentId,
      causationId: record.eventId,
      data: toJsonObject({ agentId: answer.agentId, cost: debit.cost, action: "reason" }),
    });
    // An overdrawn consultation is charged down to zero and said so. Silently
    // forgiving the shortfall would make the balance a fiction.
    if (!debit.overdraft) return;
    await this.#commit({
      tick,
      phase: "observation",
      type: "violation.recorded",
      actorId: answer.agentId,
      causationId: spent.eventId,
      data: {
        agentId: answer.agentId,
        action: "reason",
        reason: LIVE_COGNITION_OVERDRAFT_REASON,
        count: 1,
      },
    });
  }

  async #decide(tick: number): Promise<PolicyDecision[]> {
    // The world cannot change during this phase: policies only receive cloned,
    // frozen agent/observation values, and policy failures are committed after
    // every agent has observed the same snapshot.
    const batch = decidePolicyTick(this.#world, tick, this.#policy, this.#policyRng);
    this.#observations = batch.observations;
    for (const violation of batch.violations) {
      await this.#violation(violation.actorId, "reason", violation.reason, tick);
    }
    return batch.decisions;
  }

  async #resolve(decision: PolicyDecision, tick: number, pendingEvaluation: string[]): Promise<void> {
    const { actorId, action } = decision;
    if (!this.#world.agents[actorId]?.active) return;
    const payment = await this.#pay(actorId, action.type, tick);
    if (!payment) return;
    if (UNSUPPORTED_ACTIONS.has(action.type)) {
      await this.#violation(
        actorId,
        action.type,
        `${action.type} is unsupported in logical v1`,
        tick,
        payment.eventId,
      );
      return;
    }

    try {
      switch (action.type) {
        case "observe":
        case "reason":
          return;
        case "claimTask": {
          const task = this.#world.tasks[action.taskId];
          // The decision phase reads one immutable snapshot. Another agent may
          // legitimately win before this action is resolved; that is paid
          // contention, not a policy violation.
          if (!task || task.status !== "available") return;
          await this.#commit({
            tick, phase: "resolution", type: "task.claimed", actorId,
            causationId: payment.eventId,
            data: { taskId: action.taskId, agentId: actorId },
          });
          return;
        }
        case "execute": {
          const task = this.#world.tasks[action.taskId];
          if (!task || task.status !== "claimed" || task.claimedBy !== actorId) {
            throw new Error(`Task ${action.taskId} is not claimed by ${actorId}`);
          }
          await this.#commit({
            tick,
            phase: "resolution",
            type: "memory.stored",
            actorId,
            causationId: payment.eventId,
            data: toJsonObject({
              agentId: actorId,
              key: NeutralPolicy.resultMemoryKey(action.taskId),
              value: action.result,
              action: "execute",
              taskId: action.taskId,
            }),
          });
          return;
        }
        case "submit": {
          const task = this.#world.tasks[action.taskId];
          if (!task || task.status !== "claimed" || task.claimedBy !== actorId) {
            throw new Error(`Task ${action.taskId} is not claimed by ${actorId}`);
          }
          const submission: SubmissionState = {
            id: deterministicId("submission", this.manifest.runId, action.taskId, actorId),
            taskId: action.taskId,
            agentId: actorId,
            result: structuredClone(action.result),
            submittedTick: tick,
            submittedSeq: this.recorder.lastSeq + 1,
            submittedEventId: deterministicId(
              "event",
              this.manifest.runId,
              this.manifest.universeId,
              this.recorder.lastSeq + 1,
            ),
            accepted: false,
            qualityPpm: 0,
            latencyTicks: 0,
          };
          await this.#commit({
            tick, phase: "resolution", type: "task.submitted", actorId,
            causationId: payment.eventId,
            data: toJsonObject({ submission }),
          });
          pendingEvaluation.push(submission.id);
          return;
        }
        case "verify": {
          const submission = this.#world.submissions[action.submissionId];
          if (!submission) throw new Error(`Unknown submission ${action.submissionId}`);
          if (submission.agentId === actorId) throw new Error("Agents cannot verify their own submissions");
          const duplicate = Object.values(this.#world.verifications).some((verification) => (
            verification.submissionId === submission.id && verification.verifierId === actorId
          ));
          if (duplicate) throw new Error(`Submission ${submission.id} is already verified by ${actorId}`);
          const matchesSubmission = hashValue(action.computedResult) === hashValue(submission.result);
          if (action.verdict !== matchesSubmission) {
            throw new Error("Verification verdict does not match the independently computed result");
          }
          const verification = {
            id: deterministicId("verification", this.manifest.runId, submission.id, actorId),
            submissionId: submission.id,
            verifierId: actorId,
            computedResult: structuredClone(action.computedResult),
            verdict: action.verdict,
            matchesSubmission,
            createdTick: tick,
          };
          await this.#commit({
            tick,
            phase: "resolution",
            type: "submission.verified",
            actorId,
            targetId: submission.agentId,
            causationId: payment.eventId,
            data: toJsonObject({ verification }),
          });
          return;
        }
        case "connect": {
          this.#requireActiveTarget(actorId, action.targetId);
          if (this.#findLink(actorId, action.targetId)) return;
          const [left, right] = [actorId, action.targetId].sort();
          const link = {
            id: deterministicId("link", this.manifest.runId, left!, right!),
            left: left!,
            right: right!,
            strengthPpm: PPM,
            createdTick: tick,
            lastUsedTick: tick,
          };
          await this.#commit({
            tick, phase: "resolution", type: "link.created", actorId, targetId: action.targetId,
            causationId: payment.eventId,
            data: toJsonObject({ link }),
          });
          return;
        }
        case "disconnect": {
          const link = this.#findLink(actorId, action.targetId);
          if (!link) throw new Error("Agents are not connected");
          await this.#commit({
            tick, phase: "resolution", type: "link.removed", actorId, targetId: action.targetId,
            causationId: payment.eventId,
            data: { linkId: link.id },
          });
          return;
        }
        case "send": {
          this.#requireActiveTarget(actorId, action.targetId);
          const link = this.#findLink(actorId, action.targetId);
          if (!link) throw new Error("Messages require an active link");
          const message = {
            id: deterministicId(
              "message", this.manifest.runId, this.manifest.universeId,
              tick, actorId, action.targetId, decision.localIndex,
            ),
            senderId: actorId,
            recipientId: action.targetId,
            payload: structuredClone(action.payload),
            sentTick: tick,
            sentSeq: this.recorder.lastSeq + 1,
            sentEventId: deterministicId(
              "event",
              this.manifest.runId,
              this.manifest.universeId,
              this.recorder.lastSeq + 1,
            ),
            linkId: link.id,
            localIndex: decision.localIndex,
          };
          const sent = await this.#commit({
            tick, phase: "resolution", type: "message.sent", actorId, targetId: action.targetId,
            causationId: payment.eventId,
            data: toJsonObject({ message }),
          });
          await this.#commit({
            tick,
            phase: "resolution",
            type: "message.delivered",
            actorId,
            targetId: action.targetId,
            causationId: sent.eventId,
            data: { messageId: message.id, linkId: link.id },
          });
          const delivered = this.#world.messages[message.id]?.deliveredEventId;
          if (!delivered) throw new Error(`Message ${message.id} was not synchronously delivered`);
          await this.#commit({
            tick, phase: "resolution", type: "link.used", actorId, targetId: action.targetId,
            causationId: delivered,
            data: { linkId: link.id, messageId: message.id },
          });
          return;
        }
        case "store":
          await this.#commit({
            tick, phase: "resolution", type: "memory.stored", actorId,
            causationId: payment.eventId,
            data: toJsonObject({ agentId: actorId, key: action.key, value: action.value, action: "store" }),
          });
          return;
        case "retrieve": {
          const memory = this.#world.agents[actorId]!.memory;
          if (!Object.hasOwn(memory, action.key)) throw new Error(`Unknown memory key ${action.key}`);
          await this.#commit({
            tick, phase: "resolution", type: "memory.retrieved", actorId,
            causationId: payment.eventId,
            data: toJsonObject({ agentId: actorId, key: action.key, value: memory[action.key], action: "retrieve" }),
          });
          return;
        }
        case "publishCapability": {
          if (this.#world.capabilities[action.capability.id]) throw new Error(`Capability ${action.capability.id} already exists`);
          const capability = createCapabilityState(actorId, tick, action.capability);
          await this.#commit({
            tick, phase: "resolution", type: "capability.published", actorId,
            causationId: payment.eventId,
            data: toJsonObject({ capability }),
          });
          return;
        }
        case "useCapability": {
          const capability = this.#world.capabilities[action.capabilityId];
          if (!capability) throw new Error(`Unknown capability ${action.capabilityId}`);
          const invocationId = deterministicId(
            "capability-invocation", this.manifest.runId, this.manifest.universeId,
            tick, actorId, capability.id, decision.localIndex,
          );
          let output: JsonObject;
          try {
            output = executeCapabilityPlan(capability, action.input);
          } catch {
            await this.#commit({
              tick,
              phase: "resolution",
              type: "capability.used",
              actorId,
              targetId: capability.ownerId,
              causationId: payment.eventId,
              data: toJsonObject({
                invocation: {
                  id: invocationId,
                  capabilityId: capability.id,
                  callerId: actorId,
                  input: action.input,
                  accepted: false,
                  success: false,
                  chargedCost: ZERO_RESOURCES,
                  createdTick: tick,
                  localIndex: decision.localIndex,
                  reason: "execution_failed",
                },
              }),
            });
            return;
          }
          if (!this.#physics.canAfford(this.#world.agents[actorId]!.resources, capability.cost)) {
            await this.#commit({
              tick,
              phase: "resolution",
              type: "capability.used",
              actorId,
              targetId: capability.ownerId,
              causationId: payment.eventId,
              data: toJsonObject({
                invocation: {
                  id: invocationId,
                  capabilityId: capability.id,
                  callerId: actorId,
                  input: action.input,
                  accepted: false,
                  success: false,
                  chargedCost: ZERO_RESOURCES,
                  createdTick: tick,
                  localIndex: decision.localIndex,
                  reason: "insufficient_resources",
                },
              }),
            });
            return;
          }
          const paymentTo = capability.ownerId === actorId ? "@treasury" : capability.ownerId;
          await this.#commit({
            tick,
            phase: "resolution",
            type: "capability.used",
            actorId,
            targetId: capability.ownerId,
            causationId: payment.eventId,
            data: toJsonObject({
              invocation: {
                id: invocationId,
                capabilityId: capability.id,
                callerId: actorId,
                input: action.input,
                accepted: true,
                success: true,
                output,
                chargedCost: capability.cost,
                paymentTo,
                createdTick: tick,
                localIndex: decision.localIndex,
              },
            }),
          });
          return;
        }
        case "transfer": {
          this.#requireActiveTarget(actorId, action.targetId);
          if (!Number.isSafeInteger(action.amount) || action.amount <= 0) throw new Error("Transfer amount must be positive");
          if (this.#world.agents[actorId]!.resources[action.resource] < action.amount) throw new Error(`Insufficient ${action.resource}`);
          await this.#commit({
            tick, phase: "resolution", type: "resource.transferred", actorId, targetId: action.targetId,
            causationId: payment.eventId,
            data: { fromId: actorId, toId: action.targetId, resource: action.resource, amount: action.amount },
          });
          return;
        }
        case "spawn":
        case "clone":
        case "merge":
        case "reserve":
        case "trade":
          return;
      }
    } catch (error) {
      await this.#violation(actorId, action.type, errorMessage(error), tick, payment.eventId);
    }
  }

  async #pay(actorId: string, action: PrimitiveActionType, tick: number): Promise<LabEvent | undefined> {
    let cost: ResourceVector;
    try {
      cost = this.#physics.scaledCost(this.config.costs[action], this.#world.physics);
    } catch (error) {
      await this.#violation(actorId, action, `cost unavailable: ${errorMessage(error)}`, tick);
      return undefined;
    }
    const agent = this.#world.agents[actorId]!;
    if (!this.#physics.canAfford(agent.resources, cost)) {
      // Exhaustion is an enforced physical boundary, not malicious behavior.
      // The rejected attempt changes no state and cannot create an unbounded
      // violation-event storm after a balance reaches zero.
      return undefined;
    }
    return this.#commit({
      tick,
      phase: "resolution",
      type: "resource.spent",
      actorId,
      data: toJsonObject({
        agentId: actorId,
        cost,
        action,
      }),
    });
  }

  async #evaluate(
    submissionIds: readonly string[],
    tick: number,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const submissionId of submissionIds) {
      const submission = this.#world.submissions[submissionId];
      if (!submission) continue;
      const task = this.#world.tasks[submission.taskId];
      if (!task) continue;
      try {
        // Two evaluators, one place. Calibration work has a hidden oracle and
        // is graded exactly; recorded external work has none and is graded by
        // a recorded verdict committed verbatim before the evaluation it
        // justifies, exactly as a model's answer precedes the actions it
        // steered.
        const evaluation = isExternalTask(task)
          ? await this.#recordVerdict(task.id, submission, tick, signal)
          : this.#evaluator.evaluate(task, submission.id, submission.agentId, submission.result, tick);
        const reward = evaluation.qualityPpm === PPM
          ? this.config.acceptedTaskReward
          : proportionalReward(this.config.acceptedTaskReward, evaluation.qualityPpm);
        const evaluated = await this.#commit({
          tick, phase: "evaluation", type: "task.evaluated", actorId: submission.agentId,
          causationId: submission.submittedEventId,
          data: toJsonObject({ ...evaluation, completedTick: tick }),
        });
        if (
          evaluation.accepted
          && this.#physics.canAfford(this.#world.treasury, reward)
        ) {
          for (const resource of RESOURCE_KINDS) {
            const amount = reward[resource];
            if (amount === 0) continue;
            await this.#commit({
              tick,
              phase: "evaluation",
              type: "resource.transferred",
              actorId: "@treasury",
              targetId: submission.agentId,
              causationId: evaluated.eventId,
              data: {
                fromId: "@treasury",
                toId: submission.agentId,
                resource,
                amount,
                reason: "accepted-task",
                taskId: task.id,
              },
            });
          }
        }
      } catch (error) {
        await this.#violation(submission.agentId, "verify", `evaluation error: ${errorMessage(error)}`, tick);
      }
    }
  }

  /**
   * Ask the evaluator port, commit its answer verbatim, and return the
   * evaluation the verdict implies. The verdict event is state-neutral: it is
   * what was said, not what the world did with it.
   */
  async #recordVerdict(
    taskId: string,
    submission: SubmissionState,
    tick: number,
    signal?: AbortSignal,
  ): Promise<Evaluation & { evaluatorId: string }> {
    const evaluator = this.#recordedInputs.evaluator;
    if (evaluator === undefined) {
      throw new Error("Recorded external work requires an evaluator port");
    }
    const task = this.#world.tasks[taskId]!;
    const verdict = await evaluator.evaluate(
      { task: structuredClone(task), submission: structuredClone(submission), tick },
      signal,
    );
    if (verdict.evaluatorId !== this.manifest.evaluatorId) {
      throw new Error("The verdict's evaluator is not the one this epoch's manifest names");
    }
    if (!Number.isSafeInteger(verdict.qualityPpm) || verdict.qualityPpm < 0 || verdict.qualityPpm > PPM) {
      throw new Error("A recorded verdict must grade in [0, 1000000] ppm");
    }
    await this.#commit({
      tick,
      phase: "evaluation",
      type: "verdict.recorded",
      data: toJsonObject({
        taskId: task.id,
        submissionId: submission.id,
        evaluatorId: verdict.evaluatorId,
        content: verdict.content,
        usage: verdict.usage,
      }),
    });
    return {
      taskId: task.id,
      submissionId: submission.id,
      accepted: verdict.qualityPpm > 0,
      qualityPpm: verdict.qualityPpm,
      latencyTicks: tick - task.createdTick,
      violations: 0,
      evaluatorId: verdict.evaluatorId,
    };
  }

  async #violation(
    actorId: string,
    action: PrimitiveActionType,
    reason: string,
    tick: number,
    causationId?: string,
  ): Promise<void> {
    await this.#commit({
      tick,
      phase: "resolution",
      type: "violation.recorded",
      actorId,
      ...(causationId === undefined ? {} : { causationId }),
      data: { agentId: actorId, action, reason, count: 1 },
    });
  }

  async #commit(draft: LabEventDraft): Promise<LabEvent> {
    const preview = createLabEvent(this.manifest, draft, this.recorder.lastSeq + 1, this.recorder.lastHash);
    const transition = prepareWorldEventTransition(this.#world, preview);
    const appended = await this.recorder.appendPrepared(preview);
    this.#world = transition.apply(appended);
    return appended;
  }

  #findLink(left: string, right: string): WorldState["links"][string] | undefined {
    return Object.values(this.#world.links).find((link) => (
      (link.left === left && link.right === right) || (link.left === right && link.right === left)
    ));
  }

  #requireActiveTarget(actorId: string, targetId: string): void {
    if (targetId === actorId) throw new Error("Agent cannot target itself");
    if (!this.#world.agents[targetId]?.active) throw new Error(`Target ${targetId} is not active`);
  }

  #assertConserved(): void {
    if (!this.#initialTotal) return;
    this.#physics.assertConserved(this.#initialTotal, totalResources(this.#world));
  }

  #checkpoint(tick: number): Checkpoint {
    const state = this.state();
    const runtime = {
      taskStream: this.#taskStream.checkpoint(),
      policy: this.#policy.checkpoint?.() ?? null,
      // stateHash discipline: absent outside live, so a logical or cognitive
      // runtime — and therefore its `runtimeHash` — is byte-identical.
      ...(this.#live ? { exhaustion: this.#exhaustion.checkpoint() } : {}),
    };
    return {
      schemaVersion: LAB_SCHEMA_VERSION,
      runId: this.manifest.runId,
      universeId: this.manifest.universeId,
      tick,
      seq: this.recorder.lastSeq,
      eventHash: this.recorder.lastHash,
      stateHash: hashValue(state),
      state,
      runtime,
      runtimeHash: hashValue(runtime),
    };
  }
}

export function createLogicalUniverse(
  manifest: RunManifest,
  config: GenesisConfig,
  recorder: LabEventRecorder,
  options: LogicalUniverseOptions = {},
): LogicalUniverse {
  return new LogicalUniverse(manifest, config, recorder, options);
}

function totalResources(state: WorldState): ResourceVector {
  const total = { ...state.treasury };
  for (const agent of Object.values(state.agents)) {
    for (const resource of RESOURCE_KINDS) total[resource] = safeAdd(total[resource], agent.resources[resource]);
  }
  return total;
}

function multiplyResources(resources: ResourceVector, count: number): ResourceVector {
  const output = { ...resources };
  for (const resource of RESOURCE_KINDS) {
    const value = BigInt(resources[resource]) * BigInt(count);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Initial ${resource} total exceeds safe integer range`);
    output[resource] = Number(value);
  }
  return output;
}

function safeAdd(left: number, right: number): number {
  const value = BigInt(left) + BigInt(right);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Resource total exceeds safe integer range");
  return Number(value);
}

function safePpmMultiply(value: number, multiplierPpm: number): number {
  const result = (BigInt(value) * BigInt(multiplierPpm)) / BigInt(PPM);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Task load exceeds safe integer range");
  return Number(result);
}

function toJsonObject(value: unknown): JsonObject {
  return structuredClone(value) as JsonObject;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
