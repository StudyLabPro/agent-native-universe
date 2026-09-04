import type { JsonObject, JsonValue } from "../core/types.js";
import { isUnsupportedAction, unsupportedActionReason } from "./action-rules.js";
import { createGenesisAgents } from "./agent-factory.js";
import { compareCodeUnits, hashValue } from "./canonical.js";
import { createCapabilityState, executeCapabilityPlan } from "./capability-registry.js";
import { validateGenesisConfig } from "./config.js";
import {
  LIVE_COGNITION_OVERDRAFT_REASON,
  LiveExhaustionTracker,
  assertExternalTask,
  calibrationTaskCount,
  epochBoundaryExpiries,
  externalTaskId,
  inheritedGenesisOf,
  isExternalTask,
  isEmptyLiveArchivePlan,
  emptyLiveArchivePlan,
  liveThinkingDebit,
  openTaskBacklog,
  planLiveArchive,
  proportionalReward,
  type LiveArchivePlan,
  type LiveExternalTaskInput,
} from "./epoch-rules.js";
import { equalJson, type PendingOracle } from "./evaluator.js";
import { deterministicId } from "./ids.js";
import { createRunManifest, LAB_POLICY_ID } from "./manifest.js";
import { computeMetrics } from "./metrics.js";
import { createLogicalPolicyById } from "./baselines.js";
import { CohortPolicy, type CognitionRecord } from "./cognition.js";
import { NeutralPolicy } from "./neutral-policy.js";
import {
  decidePolicyTick,
  type LogicalPolicy,
  type DeferredPolicyViolation,
  type PolicyDecision,
} from "./policy-schedule.js";
import { PressureEngine, parsePressureSpec, pressureEffect } from "./pressure-engine.js";
import { RESOURCE_KINDS, ResourcePhysics } from "./resource-physics.js";
import { DeterministicRng } from "./rng.js";
import { DeterministicTaskStream, taskStreamRng, type GeneratedTask } from "./task-stream.js";
import {
  PPM,
  ZERO_RESOURCES,
  type CapabilityState,
  type CheckpointRuntimeState,
  type GenesisConfig,
  type LabTaskState,
  type LiveGenesisFrom,
  type LabEvent,
  type LabEventType,
  type LiveThinkTier,
  type PrimitiveActionType,
  type ResourceVector,
  type RunManifest,
  type TickPhase,
  type WorldAction,
  type WorldState,
} from "./types.js";

const PHASE_RANK: Readonly<Record<TickPhase, number>> = Object.freeze({
  genesis: 0,
  pressure: 1,
  task_generation: 2,
  observation: 3,
  decision: 4,
  resolution: 5,
  evaluation: 6,
  metrics: 7,
  upkeep: 8,
  checkpoint: 9,
  completion: 10,
});

const EVENT_PHASES: Readonly<Partial<Record<LabEventType, readonly TickPhase[]>>> = Object.freeze({
  "run.started": ["genesis"],
  "agent.created": ["genesis"],
  "agent.retired": ["pressure"],
  "pressure.applied": ["pressure"],
  "task.created": ["task_generation"],
  "task.expired": ["task_generation"],
  "task.claimed": ["resolution"],
  "task.submitted": ["resolution"],
  "submission.verified": ["resolution"],
  "link.created": ["resolution"],
  "link.removed": ["resolution"],
  "link.used": ["resolution"],
  "resource.spent": ["resolution"],
  "resource.transferred": ["resolution", "evaluation"],
  "memory.stored": ["resolution"],
  "memory.retrieved": ["resolution"],
  "message.sent": ["resolution"],
  "message.delivered": ["resolution"],
  "capability.published": ["resolution"],
  "capability.used": ["resolution"],
  "cognition.recorded": ["observation"],
  "violation.recorded": ["resolution"],
  "task.evaluated": ["evaluation"],
  "metrics.recorded": ["metrics"],
  "tick.completed": ["upkeep"],
  "run.completed": ["completion"],
});

/**
 * Live epochs widen the frozen table in five places, all of them recorded-input
 * or bounded-world rules that do not exist in a bounded run:
 *
 *  - the final upkeep expires calibration work that would otherwise cross the
 *    epoch boundary (phase L3a);
 *  - a recorded thought is paid for in the observation phase, immediately after
 *    the `cognition.recorded` that caused it, and an overdrawn payment records
 *    its violation there too (phase L3b);
 *  - an agent that can no longer think is retired in the upkeep (phase L3b);
 *  - a recorded verdict is committed in the evaluation phase before the
 *    `task.evaluated` it justifies (phase L3b);
 *  - settled records leave the bounded world at the end of the upkeep
 *    (phase L3c) — three event types a bounded run has never had at all, so a
 *    logical stream carrying one is refused by the frozen table above.
 *
 * The logical table itself is unchanged, so a bounded run is verified by
 * exactly the phases it always was.
 */
const LIVE_EVENT_PHASES: Readonly<Partial<Record<LabEventType, readonly TickPhase[]>>> = Object.freeze({
  ...EVENT_PHASES,
  "task.expired": ["task_generation", "upkeep"],
  "resource.spent": ["resolution", "observation"],
  "violation.recorded": ["resolution", "observation"],
  "agent.retired": ["pressure", "upkeep"],
  "verdict.recorded": ["evaluation"],
  "task.archived": ["upkeep"],
  "submission.archived": ["upkeep"],
  "message.archived": ["upkeep"],
});

interface ExpectedPressureEvent {
  type: "pressure.applied" | "agent.retired";
  data: JsonObject;
  actorId?: string;
  causationId?: string;
}

interface PaymentAnchor {
  id: string;
  tick: number;
  actorId: string;
  action: PrimitiveActionType;
  decision: PolicyDecision;
  outcomeRequired: boolean;
}

interface PendingSubmission {
  id: string;
  eventId: string;
}

interface ExpectedReward {
  actorId: "@treasury";
  targetId: string;
  causationId: string;
  data: JsonObject;
}

interface MessageChain {
  stage: "delivery" | "link";
  tick: number;
  actorId: string;
  targetId: string;
  cause: string;
  messageId: string;
  linkId: string;
}

export class ProtocolVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolVerificationError";
  }
}

/**
 * What a live epoch needs on top of a bounded run to be verifiable, supplied
 * only by the Genesis-Live engine (`src/lab/live/epoch.ts`).
 *
 * Without it a live manifest is refused fail-closed exactly as before: the
 * scientific projectors never build one of these, so live evidence can never
 * be reinterpreted as logical or cognitive evidence.
 */
export interface LiveProjectionOptions {
  /**
   * The inherited genesis (`genesis.json`) of this epoch, required exactly
   * when `config.live.genesisFrom` is present and refused otherwise. It is
   * checked against `genesisFrom.genesisStateHash` before anything is
   * verified against it.
   */
  genesisState?: WorldState;
  /**
   * Builds a fresh live fallback policy (`LiveIdlePolicy`). Injected rather
   * than imported: the science guard forbids the scientific instruments —
   * which reach this file through `genesis.ts` → `replay.ts` — from reaching
   * anything under `src/lab/live/`.
   */
  createFallbackPolicy: () => LogicalPolicy;
}

export interface LabProtocolVerifierOptions {
  live?: LiveProjectionOptions;
}

/**
 * Stateful verifier for the deterministic Genesis-1 wire protocol.
 * It retains only bounded generator state and causal anchors for the current
 * tick; the WorldState projection remains the source of referential truth.
 */
export class LabProtocolVerifier {
  readonly manifest: RunManifest;
  readonly config: GenesisConfig;

  readonly #genesisAgents;
  readonly #physics = new ResourcePhysics();
  readonly #pressure: PressureEngine;
  readonly #pressureRng: DeterministicRng;
  readonly #neutral = new NeutralPolicy();
  /**
   * In cognitive mode the verifier must not regenerate a decision a model made.
   * It replays the recorded answers through the same cohort policy the run
   * used, so verification stays exact without ever calling a provider.
   */
  readonly #policy: LogicalPolicy;
  readonly #cognitive: boolean;
  readonly #live: boolean;
  readonly #genesisFrom: LiveGenesisFrom | undefined;
  readonly #genesisTick: number;
  #cognitionRecords: CognitionRecord[] = [];
  readonly #policyRng: DeterministicRng;
  readonly #resolutionRng: DeterministicRng;
  readonly #tasks: DeterministicTaskStream;
  readonly #initialAgentTotals: ResourceVector;
  readonly #oracles = new Map<string, JsonValue>();
  readonly #submissions: PendingSubmission[] = [];
  /** Live only: the exhaustion clock, regenerated tick by tick from the states. */
  readonly #exhaustion = new LiveExhaustionTracker();

  #started = false;
  #genesisAgentIndex = 0;
  #currentTick = 0;
  #lastPhaseRank = -1;
  #tickCompleted = false;
  #metricsSeen = false;
  #completed = false;
  #pressureExpected: ExpectedPressureEvent[] = [];
  #expiryExpected: string[] = [];
  /** Live only: the final upkeep's `epoch_boundary` expiries, once regenerated. */
  #boundaryExpiryExpected: string[] | undefined;
  #generatedExpected: GeneratedTask[] | undefined;
  #generatedIndex = 0;
  /** Live only: the debit (and its overdraft violation) a recorded thought owes. */
  #thinkingExpected: ExpectedThinkingEvent[] = [];
  /** Live only: the upkeep's exhaustion retirements, once regenerated. */
  #exhaustionExpected: string[] | undefined;
  /** Live only: the records this upkeep must archive, once regenerated. */
  #archiveExpected: LiveArchivePlan | undefined;
  /** Live only: the recorded verdict that must be followed by its evaluation. */
  #pendingVerdict: string | undefined;
  /** The random source of this tick's physics; shared by schedule and inbox. */
  #tickPressureRng: DeterministicRng | undefined;
  /** Live only: once recorded work enters a tick, no calibration work may follow. */
  #recordedTaskSeen = false;
  #rewards: ExpectedReward[] = [];
  #messageChain: MessageChain | undefined;
  #openPayment: PaymentAnchor | undefined;
  #policyDecisions: PolicyDecision[] | undefined;
  #policyViolations: DeferredPolicyViolation[] | undefined;
  #inheritedTreasury: ResourceVector | undefined;

  constructor(manifest: RunManifest, config: GenesisConfig, options: LabProtocolVerifierOptions = {}) {
    assertReplayConfiguration(manifest, config);
    // Fail closed rather than verify a live epoch as if it were logical: its
    // recorded inputs (external tasks, verdicts, physics) are unknown here
    // unless the caller is the live engine and hands over what a live epoch
    // needs to be regenerated.
    const live = manifest.mode === "live";
    if (live && options.live === undefined) {
      throw new ProtocolVerificationError("Live manifests are not verifiable by this engine build");
    }
    if (!live && options.live !== undefined) {
      throw new ProtocolVerificationError("A live projection belongs to a live manifest only");
    }
    this.manifest = structuredClone(manifest);
    this.config = structuredClone(config);
    this.#live = live;
    this.#genesisFrom = live ? config.live?.genesisFrom : undefined;
    this.#genesisTick = this.#genesisFrom?.tick ?? 0;
    // An inherited epoch has no genesis population: it continues the parent's.
    this.#genesisAgents = this.#genesisFrom === undefined ? createGenesisAgents(config) : [];
    const rootRng = new DeterministicRng(hashValue({
      domain: "agent-native-universe/lab/logical-universe/v1",
      runId: manifest.runId,
      universeId: manifest.universeId,
      seed: config.seed,
    }));
    this.#tasks = new DeterministicTaskStream(config.taskStream, taskStreamRng(config.taskStream, rootRng));
    this.#pressure = new PressureEngine(config.pressures);
    this.#pressureRng = rootRng.fork("pressure");
    this.#policyRng = rootRng.fork("policy");
    this.#resolutionRng = rootRng.fork("resolution");
    this.#initialAgentTotals = multiplyResources(config.initialResources, config.agents);
    this.#cognitive = manifest.mode === "cognitive";
    // Live steers exactly like a cohort — recorded answers applied through the
    // same CohortPolicy — but its unsteered agents idle instead of receiving
    // the neutral control's computed answer.
    this.#policy = live
      ? new CohortPolicy(cohortOf(manifest.policyId), options.live!.createFallbackPolicy())
      : this.#cognitive
        ? new CohortPolicy(cohortOf(manifest.policyId), this.#neutral)
        : manifest.policyId === LAB_POLICY_ID
          ? this.#neutral
          : createLogicalPolicyById(manifest.policyId);
    if (live && this.#policy.id !== manifest.policyId) {
      throw new ProtocolVerificationError(
        `Live fallback policy composes to ${this.#policy.id}, not the manifest policy ${manifest.policyId}`,
      );
    }
    if (this.#genesisFrom !== undefined) {
      const genesisState = options.live?.genesisState;
      if (genesisState === undefined) {
        throw new ProtocolVerificationError("An inherited live epoch requires its genesis state");
      }
      if (hashValue(genesisState) !== this.#genesisFrom.genesisStateHash) {
        throw new ProtocolVerificationError("Inherited genesis state does not match live.genesisFrom");
      }
      this.#inheritedTreasury = structuredClone(genesisState.treasury);
      // Continue the parent's deterministic streams: the child's realization
      // is the same one, not a new one that happens to start at this tick.
      this.#tasks.restore(this.#genesisFrom.runtime.taskStream);
      if (this.#genesisFrom.runtime.policy !== null) {
        if (this.#policy.restore === undefined) {
          throw new ProtocolVerificationError("The live fallback policy does not support deterministic continuation");
        }
        this.#policy.restore(this.#genesisFrom.runtime.policy, this.#policyRng);
      }
      this.#exhaustion.restore(this.#genesisFrom.runtime.exhaustion);
      this.#currentTick = this.#genesisTick;
      this.#tickCompleted = true;
    } else if (options.live?.genesisState !== undefined) {
      throw new ProtocolVerificationError("Live epoch 0 has no inherited genesis state");
    }
  }

  verifyNext(event: LabEvent, state: WorldState): void {
    if (this.#completed) this.#fail(event, "event follows run.completed");
    this.#assertEventPhase(event);

    if (
      event.tick === this.#genesisTick
      || !this.#started
      || this.#genesisAgentIndex < this.#genesisAgents.length
    ) {
      if (this.#verifyGenesis(event)) return;
    }
    if (event.tick <= this.#genesisTick) this.#fail(event, `tick ${this.#genesisTick} is reserved for genesis`);
    if (!this.#started || this.#genesisAgentIndex !== this.#genesisAgents.length) {
      this.#fail(event, "tick 1 cannot start before the complete genesis population");
    }

    this.#enterTick(event, state);
    const rank = PHASE_RANK[event.phase];
    this.#finalizeSkippedPhases(rank, event, state);
    if (rank < this.#lastPhaseRank) this.#fail(event, "phase moves backwards within a tick");
    this.#lastPhaseRank = rank;

    // The price of a recorded thought is owed immediately, so nothing at all
    // may come between the record and its debit.
    if (this.#thinkingExpected.length > 0) {
      this.#verifyThinkingEvent(event);
      return;
    }

    if (event.type === "cognition.recorded") {
      // Recorded cognition is an input to the decision phase, not an outcome of
      // it: accept it here and let it steer the schedule regenerated below.
      if (!this.#cognitive && !this.#live) {
        this.#fail(event, "cognition.recorded requires a cognitive manifest");
      }
      if (this.#policyDecisions !== undefined) {
        this.#fail(event, "cognition must be recorded before the decision phase of its tick");
      }
      const record = decodeCognitionRecord(event, this.#live, (reason) => this.#fail(event, reason));
      this.#cognitionRecords.push(record);
      if (this.#live) this.#expectThinkingDebit(event, record, state);
      return;
    }

    if (
      this.#openPayment !== undefined
      && event.type !== "resource.spent"
      && event.causationId !== this.#openPayment.id
    ) {
      this.#settleSilentPayment(event);
    }

    if (this.#messageChain !== undefined) this.#verifyMessageContinuation(event);
    const expectedReward = this.#rewards.length > 0;
    if (expectedReward) this.#verifyReward(event);

    switch (event.type) {
      case "pressure.applied":
        this.#verifyPressure(event, state);
        break;
      case "agent.retired":
        // Two provenances: operator physics (pressure phase, caused by its
        // pressure event) and exhaustion (upkeep, regenerated from the state).
        if (event.phase === "upkeep") this.#verifyExhaustionRetirement(event, state);
        else this.#verifyPressure(event, state);
        break;
      case "verdict.recorded":
        this.#verifyVerdict(event, state);
        break;
      case "submission.archived":
      case "task.archived":
      case "message.archived":
        this.#verifyArchived(event, state);
        break;
      case "task.expired":
        this.#verifyExpiry(event);
        break;
      case "task.created":
        this.#verifyGeneratedTask(event, state);
        break;
      case "resource.spent":
        // An observation-phase spend is the price of a thought and is only
        // ever verified through the queue above; reaching the switch means it
        // had no `cognition.recorded` in front of it.
        if (event.phase === "observation") this.#fail(event, "a thinking debit has no recorded thought before it");
        this.#verifyPayment(event, state);
        break;
      case "task.submitted":
        this.#verifyPaidOutcome(event, "submit", state);
        this.#submissions.push({ id: requiredNestedId(event.data, "submission"), eventId: event.eventId });
        break;
      case "task.evaluated":
        this.#verifyEvaluation(event, state);
        break;
      case "resource.transferred":
        if (event.phase === "resolution") this.#verifyPaidOutcome(event, "transfer", state);
        else if (!expectedReward) this.#fail(event, "unearned evaluation reward transfer");
        break;
      case "metrics.recorded":
        this.#verifyMetrics(event, state);
        break;
      case "tick.completed":
        this.#verifyTickCompleted(event, state);
        break;
      case "run.completed":
        this.#verifyRunCompleted(event);
        break;
      case "message.sent":
        this.#verifyPaidOutcome(event, "send", state);
        this.#messageChain = {
          stage: "delivery",
          tick: event.tick,
          actorId: requiredActor(event),
          targetId: requiredTarget(event),
          cause: event.eventId,
          messageId: requiredNestedString(event.data, "message", "id"),
          linkId: requiredNestedString(event.data, "message", "linkId"),
        };
        break;
      case "message.delivered":
      case "link.used":
        // The immediate chain was checked before this switch.
        break;
      case "task.claimed": this.#verifyPaidOutcome(event, "claimTask", state); break;
      case "submission.verified": this.#verifyPaidOutcome(event, "verify", state); break;
      case "link.created": this.#verifyPaidOutcome(event, "connect", state); break;
      case "link.removed": this.#verifyPaidOutcome(event, "disconnect", state); break;
      case "memory.stored":
        this.#verifyPaidOutcome(event, event.data.action === "execute" ? "execute" : "store", state);
        break;
      case "memory.retrieved": this.#verifyPaidOutcome(event, "retrieve", state); break;
      case "capability.published": this.#verifyPaidOutcome(event, "publishCapability", state); break;
      case "capability.used": this.#verifyPaidOutcome(event, "useCapability", state); break;
      case "violation.recorded": {
        if (event.phase === "observation") {
          this.#fail(event, "an overdraft violation has no thinking debit before it");
        }
        const action = requiredAction(event.data.action, event);
        if (event.causationId !== undefined) {
          this.#verifyPaidOutcome(event, action, state);
          this.#verifyViolationShape(event, false);
        } else {
          this.#verifyUncausedViolation(event, state);
          this.#verifyViolationShape(event, true);
        }
        break;
      }
      case "run.started":
      case "agent.created":
        this.#fail(event, "genesis control event appears after tick 0");
        break;
      case "agent.learning.updated":
        this.#fail(event, "agent.learning.updated is not emitted by this engine version");
        break;
    }
  }

  finish(options: { allowIncompleteBoundary?: boolean } = {}): void {
    if (!this.#started) throw new ProtocolVerificationError("Event stream has no run.started event");
    if (this.#genesisAgentIndex !== this.#genesisAgents.length) {
      throw new ProtocolVerificationError("Event stream ends before the complete genesis population");
    }
    if (!this.#completed) {
      if (!options.allowIncompleteBoundary) {
        throw new ProtocolVerificationError("Event stream ends before run.completed");
      }
      if (this.#currentTick !== 0 && !this.#tickCompleted) {
        throw new ProtocolVerificationError("Incomplete event stream does not end at a durable tick boundary");
      }
      return;
    }
    if (!this.#tickCompleted || this.#currentTick !== this.config.ticks) {
      throw new ProtocolVerificationError("Completed event stream has an invalid terminal tick");
    }
  }

  checkpointRuntime(): CheckpointRuntimeState {
    this.#assertAtDurableBoundary();
    return {
      taskStream: this.#tasks.checkpoint(),
      policy: this.#policy.checkpoint?.() ?? null,
      ...(this.#live ? { exhaustion: this.#exhaustion.checkpoint() } : {}),
    };
  }

  /**
   * Oracles for tasks that were generated but neither expired nor evaluated
   * as of the current durable boundary — reconstructed the same way the rest
   * of this verifier's state is, by replaying `task.created` / `task.expired`
   * / `task.evaluated` from genesis. Used only to rebuild the live
   * evaluator's in-memory map on resume (world.ts); never serialized.
   */
  pendingOracles(): PendingOracle[] {
    this.#assertAtDurableBoundary();
    return [...this.#oracles.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([taskId, expected]) => ({ taskId, expected: structuredClone(expected) }));
  }

  #assertAtDurableBoundary(): void {
    if (!this.#started || this.#genesisAgentIndex !== this.#genesisAgents.length) {
      throw new ProtocolVerificationError("Cannot checkpoint before complete genesis");
    }
    if (this.#currentTick !== 0 && !this.#tickCompleted) {
      throw new ProtocolVerificationError("Cannot checkpoint inside an incomplete tick");
    }
  }

  #verifyGenesis(event: LabEvent): boolean {
    if (event.tick !== this.#genesisTick || event.phase !== "genesis") return false;
    if (!this.#started) {
      if (event.seq !== 1 || event.type !== "run.started") this.#fail(event, "run.started must be event 1");
      assertNoParticipants(event, this.#fail.bind(this));
      // An inherited epoch restates the treasury it inherited and the parent
      // it continues; both are pinned in `config.live.genesisFrom`, so the
      // event cannot claim a parent or a grant of its own choosing.
      const expected = this.#genesisFrom === undefined
        ? { treasury: this.config.treasuryResources }
        : { treasury: this.#inheritedTreasury!, inherited: inheritedGenesisOf(this.#genesisFrom) };
      assertExact(event.data, expected, event, this.#fail.bind(this), "run.started data");
      this.#started = true;
      return true;
    }
    const expected = this.#genesisAgents[this.#genesisAgentIndex];
    if (expected === undefined) this.#fail(event, "extra genesis event after configured population");
    if (event.type !== "agent.created" || event.actorId !== expected.id) {
      this.#fail(event, `expected ordered genesis agent ${expected.id}`);
    }
    if (event.targetId !== undefined || event.causationId !== undefined) {
      this.#fail(event, "agent.created cannot have target or causation");
    }
    assertExact(event.data, { agent: expected }, event, this.#fail.bind(this), "genesis agent");
    this.#genesisAgentIndex += 1;
    return true;
  }

  #enterTick(event: LabEvent, state: WorldState): void {
    if (this.#currentTick === 0 && this.#genesisTick === 0) {
      if (event.tick !== 1) this.#fail(event, "logical ticks must start at 1");
      this.#startTick(1, state);
      return;
    }
    if (this.#tickCompleted) {
      if (event.type === "run.completed") {
        if (event.tick !== this.#currentTick) this.#fail(event, "run.completed must share the final completed tick");
        return;
      }
      if (event.tick !== this.#currentTick + 1) this.#fail(event, "logical ticks must be sequential");
      this.#startTick(event.tick, state);
      return;
    }
    if (event.tick !== this.#currentTick) this.#fail(event, "tick advanced before tick.completed");
  }

  #startTick(tick: number, state: WorldState): void {
    if (tick > this.config.ticks) throw new ProtocolVerificationError(`Tick ${tick} exceeds configured ticks ${this.config.ticks}`);
    this.#currentTick = tick;
    this.#lastPhaseRank = 0;
    this.#tickCompleted = false;
    this.#boundaryExpiryExpected = undefined;
    this.#metricsSeen = false;
    this.#generatedExpected = undefined;
    this.#generatedIndex = 0;
    this.#openPayment = undefined;
    this.#policyDecisions = undefined;
    this.#policyViolations = undefined;
    this.#cognitionRecords = [];
    this.#thinkingExpected = [];
    this.#exhaustionExpected = undefined;
    this.#archiveExpected = undefined;
    this.#pendingVerdict = undefined;
    this.#recordedTaskSeen = false;
    // One fork per tick, shared by the configured schedule and the recorded
    // physics inbox, exactly as the world shares it. A fork is
    // consumption-independent, so the two cannot shift each other.
    this.#tickPressureRng = this.#pressureRng.fork(tick);
    const pressure = this.#pressure.forTick(tick, state, this.#tickPressureRng);
    this.#pressureExpected = [
      ...pressure.events.map((draft) => ({ type: "pressure.applied" as const, data: draft.data })),
      ...pressure.retiredAgentIds.map((agentId) => ({
        type: "agent.retired" as const,
        actorId: agentId,
        causationId: "pending-pressure-event",
        data: { agentId, retiredTick: tick, reason: "pressure" },
      })),
    ];
    this.#expiryExpected = Object.values(state.tasks)
      .filter((task) => task.status !== "completed" && task.status !== "expired" && task.deadlineTick < tick)
      .map((task) => task.id)
      .sort();
  }

  #finalizeSkippedPhases(rank: number, event: LabEvent, state: WorldState): void {
    if (rank > PHASE_RANK.pressure && this.#pressureExpected.length > 0) {
      this.#fail(event, "configured pressure events are missing");
    }
    if (rank > PHASE_RANK.task_generation) {
      if (this.#expiryExpected.length > 0) this.#fail(event, "deterministic task expiry events are missing");
      this.#ensureGenerated(state);
      if (this.#generatedIndex !== this.#generatedExpected!.length) {
        this.#fail(event, "deterministic task generation events are missing");
      }
    }
    if (rank > PHASE_RANK.evaluation) {
      if (this.#submissions.length > 0) this.#fail(event, "submitted tasks are missing deterministic evaluations");
      if (this.#rewards.length > 0) this.#fail(event, "accepted evaluation rewards are incomplete");
    }
    if (rank > PHASE_RANK.observation && this.#thinkingExpected.length > 0) {
      this.#fail(event, "a recorded thought is missing the debit it owes");
    }
    if (rank > PHASE_RANK.evaluation && this.#pendingVerdict !== undefined) {
      this.#fail(event, "a recorded verdict is missing its evaluation");
    }
    if (rank >= PHASE_RANK.resolution) this.#ensurePolicySchedule(state);
    if (rank > PHASE_RANK.resolution) this.#finalizeResolution(event, state);
    if (rank >= PHASE_RANK.upkeep) {
      this.#ensureExhaustion(state);
      this.#ensureBoundaryExpiry(state);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Live: the economy of thinking (phase L3b)                           */
  /* ------------------------------------------------------------------ */

  /**
   * What the world owes for the thought just recorded, recomputed from the
   * recorded usage, the tier price of the config and the current physics.
   *
   * Nothing in the event says what the debit should be — the verifier derives
   * it — so a run cannot under-charge itself for thinking, and an overdrawn
   * balance cannot be quietly forgiven.
   */
  #expectThinkingDebit(event: LabEvent, record: CognitionRecord, state: WorldState): void {
    if (record.tier === undefined) {
      this.#fail(event, "a live cognition record must state the tier it was consulted at");
    }
    if (record.usage.totalTokens <= 0) return;
    const agent = state.agents[record.agentId];
    if (agent === undefined || !agent.active) return;
    let debit;
    try {
      debit = liveThinkingDebit(
        this.config,
        state.physics,
        record.tier,
        record.usage.totalTokens,
        agent.resources,
      );
    } catch (error) {
      this.#fail(event, `thinking price is undefined: ${errorMessage(error)}`);
    }
    this.#thinkingExpected = [{
      type: "resource.spent",
      actorId: record.agentId,
      causationId: event.eventId,
      data: { agentId: record.agentId, cost: debit.cost, action: "reason" } as unknown as JsonObject,
      ...(debit.overdraft ? { overdraft: true } : {}),
    }];
  }

  #verifyThinkingEvent(event: LabEvent): void {
    const expected = this.#thinkingExpected.shift()!;
    if (
      event.type !== expected.type
      || event.phase !== "observation"
      || event.actorId !== expected.actorId
      || event.targetId !== undefined
      || event.causationId !== expected.causationId
    ) {
      this.#fail(event, `the thinking ${expected.type === "resource.spent" ? "debit" : "overdraft violation"} is missing, misplaced or misattributed`);
    }
    assertExact(event.data, expected.data, event, this.#fail.bind(this), "thinking debit data");
    if (expected.overdraft !== true) return;
    // An overdrawn debit says so, in the same phase, caused by the debit.
    this.#thinkingExpected.push({
      type: "violation.recorded",
      actorId: expected.actorId,
      causationId: event.eventId,
      data: {
        agentId: expected.actorId,
        action: "reason",
        reason: LIVE_COGNITION_OVERDRAFT_REASON,
        count: 1,
      } as unknown as JsonObject,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Live: exhaustion (phase L3b)                                        */
  /* ------------------------------------------------------------------ */

  /**
   * The upkeep's retirements, regenerated from the same rule the world
   * applies over the same sequence of states. Called exactly once per tick.
   */
  #ensureExhaustion(state: WorldState): void {
    if (!this.#live || this.#exhaustionExpected !== undefined) return;
    this.#exhaustionExpected = this.#exhaustion.review(this.manifest, this.config, state);
  }

  #verifyExhaustionRetirement(event: LabEvent, state: WorldState): void {
    if (!this.#live) this.#fail(event, "retirement by exhaustion is a live-only rule");
    this.#ensureExhaustion(state);
    const expected = this.#exhaustionExpected!.shift();
    if (expected === undefined) this.#fail(event, "unexpected exhaustion retirement");
    if (event.actorId !== expected || event.targetId !== undefined || event.causationId !== undefined) {
      this.#fail(event, "exhaustion retirement provenance differs from the regenerated schedule");
    }
    assertExact(
      event.data,
      { agentId: expected, retiredTick: event.tick, reason: "exhausted" },
      event,
      this.#fail.bind(this),
      "exhaustion retirement data",
    );
  }

  #verifyPressure(event: LabEvent, state: WorldState): void {
    // A live epoch's physics arrive as recorded operator input rather than
    // from a configured schedule, so a `pressure.applied` with nothing pending
    // is not an error — it is the input. What it DID is still regenerated
    // here, from the same `pressureEffect` and the same forked RNG, so an
    // operator cannot choose which agents a retirement takes.
    if (this.#live && this.#pressureExpected.length === 0 && event.type === "pressure.applied") {
      this.#verifyRecordedPressure(event, state);
      return;
    }
    const expected = this.#pressureExpected.shift();
    if (expected === undefined || event.type !== expected.type) this.#fail(event, "unexpected or out-of-order pressure event");
    if (event.type === "pressure.applied") {
      assertNoParticipants(event, this.#fail.bind(this));
      assertExact(event.data, expected.data, event, this.#fail.bind(this), "pressure data");
      if (event.data.type === "retire_agent_fraction") {
        for (const pending of this.#pressureExpected) {
          if (pending.type === "agent.retired" && pending.causationId === "pending-pressure-event") {
            pending.causationId = event.eventId;
          }
        }
      }
      return;
    }
    if (event.actorId !== expected.actorId || event.targetId !== undefined || event.causationId !== expected.causationId) {
      this.#fail(event, "agent.retired provenance differs from deterministic pressure");
    }
    assertExact(event.data, expected.data, event, this.#fail.bind(this), "agent.retired data");
  }

  /**
   * One recorded pressure: accepted by form, applied by the one rule.
   *
   * The event carries the operator's spec; everything the spec produced —
   * including which agents a `retire_agent_fraction` takes — is recomputed
   * from `pressureEffect` against this tick's forked RNG and must match the
   * payload byte for byte.
   */
  #verifyRecordedPressure(event: LabEvent, state: WorldState): void {
    assertNoParticipants(event, this.#fail.bind(this));
    let spec;
    try {
      spec = parsePressureSpec(event.data as Record<string, unknown>, {
        tick: event.tick,
        allowedExtra: ["retiredAgentIds"],
      });
    } catch (error) {
      this.#fail(event, `recorded pressure is not admissible: ${errorMessage(error)}`);
    }
    const effect = pressureEffect(event.tick, spec, state, this.#tickPressureRng!);
    assertExact(event.data, effect.event.data, event, this.#fail.bind(this), "recorded pressure data");
    this.#pressureExpected = effect.retiredAgentIds.map((agentId) => ({
      type: "agent.retired" as const,
      actorId: agentId,
      causationId: event.eventId,
      data: { agentId, retiredTick: event.tick, reason: "pressure" } as unknown as JsonObject,
    }));
  }

  #verifyExpiry(event: LabEvent): void {
    assertNoParticipants(event, this.#fail.bind(this));
    if (event.phase === "upkeep") {
      if (this.#exhaustionExpected !== undefined && this.#exhaustionExpected.length > 0) {
        this.#fail(event, "the epoch-boundary sweep precedes the upkeep's exhaustion retirements");
      }
      const expectedBoundaryId = this.#boundaryExpiryExpected?.shift();
      if (expectedBoundaryId === undefined) this.#fail(event, "unexpected epoch-boundary task.expired event");
      assertExact(
        event.data,
        { taskId: expectedBoundaryId, reason: "epoch_boundary" },
        event,
        this.#fail.bind(this),
        "epoch-boundary task expiry data",
      );
      this.#oracles.delete(expectedBoundaryId);
      return;
    }
    const expectedId = this.#expiryExpected.shift();
    if (expectedId === undefined) this.#fail(event, "unexpected task.expired event");
    assertExact(event.data, { taskId: expectedId }, event, this.#fail.bind(this), "task expiry data");
    this.#oracles.delete(expectedId);
  }

  /* ------------------------------------------------------------------ */
  /* Live: the bounded world (phase L3c)                                 */
  /* ------------------------------------------------------------------ */

  /**
   * What this upkeep must archive, regenerated from the state at the moment
   * archival begins — after the retirements and the boundary sweep, which is
   * exactly where the world computes it.
   *
   * Not memoised across that point on purpose: unlike the exhaustion clock,
   * the archive plan is a function of the state alone, and the state the
   * archival step sees is the one after everything else in the upkeep has
   * settled.
   */
  #ensureArchive(state: WorldState): void {
    if (!this.#live || this.#archiveExpected !== undefined) return;
    this.#archiveExpected = planLiveArchive(this.manifest, this.config, this.#currentTick, state);
  }

  /**
   * One archived record: accepted only if the regenerated plan names it, in
   * the plan's own order (submissions, then the tasks their departure frees,
   * then delivered mail). A run therefore cannot archive a record the rule
   * would have kept, and `#verifyTickCompleted` refuses a tick that kept a
   * record the rule would have archived.
   */
  #verifyArchived(event: LabEvent, state: WorldState): void {
    if (!this.#live) this.#fail(event, "archival is a live-only rule");
    if (this.#exhaustionExpected !== undefined && this.#exhaustionExpected.length > 0) {
      this.#fail(event, "archival precedes the upkeep's exhaustion retirements");
    }
    if (this.#boundaryExpiryExpected !== undefined && this.#boundaryExpiryExpected.length > 0) {
      this.#fail(event, "archival precedes the epoch-boundary expiry sweep");
    }
    this.#ensureArchive(state);
    const plan = this.#archiveExpected!;
    assertNoParticipants(event, this.#fail.bind(this));
    if (event.type === "submission.archived") {
      const expected = plan.submissions.shift();
      if (expected === undefined) this.#fail(event, "unexpected submission.archived event");
      assertExact(event.data, { submissionId: expected }, event, this.#fail.bind(this), "submission archival data");
      return;
    }
    if (plan.submissions.length > 0) {
      this.#fail(event, "submissions are archived before the tasks and mail of the same upkeep");
    }
    if (event.type === "task.archived") {
      const expected = plan.tasks.shift();
      if (expected === undefined) this.#fail(event, "unexpected task.archived event");
      assertExact(event.data, { taskId: expected }, event, this.#fail.bind(this), "task archival data");
      this.#oracles.delete(expected);
      return;
    }
    if (plan.tasks.length > 0) this.#fail(event, "tasks are archived before the mail of the same upkeep");
    const expected = plan.messages.shift();
    if (expected === undefined) this.#fail(event, "unexpected message.archived event");
    assertExact(event.data, { messageId: expected }, event, this.#fail.bind(this), "message archival data");
  }

  /**
   * The final upkeep's expiry sweep, regenerated from the state the upkeep
   * phase begins with — the same pure rule the world applies.
   */
  #ensureBoundaryExpiry(state: WorldState): void {
    if (!this.#live || this.#boundaryExpiryExpected !== undefined) return;
    this.#boundaryExpiryExpected = epochBoundaryExpiries(
      this.manifest,
      this.config,
      this.#currentTick,
      state,
    );
  }

  #ensureGenerated(state: WorldState): void {
    if (this.#generatedExpected !== undefined) return;
    const backlog = Object.values(state.tasks)
      .filter((task) => task.status !== "completed" && task.status !== "expired").length;
    const capacity = Math.max(0, this.config.taskStream.maxBacklog - backlog);
    const scaled = safePpmMultiply(this.config.taskStream.tasksPerTick, state.physics.taskLoadPpm);
    this.#generatedExpected = this.#tasks.generate(
      this.#currentTick,
      calibrationTaskCount(this.manifest, this.config, this.#currentTick, Math.min(capacity, scaled)),
    );
  }

  #verifyGeneratedTask(event: LabEvent, state: WorldState): void {
    if (this.#expiryExpected.length > 0) this.#fail(event, "task.created precedes required expiry events");
    if (event.data.source !== undefined) {
      this.#verifyRecordedTask(event, state);
      return;
    }
    this.#ensureGenerated(state);
    if (this.#recordedTaskSeen) this.#fail(event, "calibration work cannot follow recorded work in a tick");
    const expected = this.#generatedExpected![this.#generatedIndex];
    if (expected === undefined) this.#fail(event, "unexpected deterministic task");
    assertNoParticipants(event, this.#fail.bind(this));
    assertExact(event.data, { task: expected.task }, event, this.#fail.bind(this), "generated task");
    this.#oracles.set(expected.task.id, structuredClone(expected.expected));
    this.#generatedIndex += 1;
  }

  /**
   * Recorded external work, accepted by form rather than regenerated.
   *
   * The verifier never reads `tasks/inbox.jsonl` — a replay must work from the
   * chain alone. What it checks instead is that the payload is a well-formed
   * external task whose id is the commitment to its own content, that it did
   * not jump the tick's calibration work, and that the bounded world had room
   * for it. An operator can put work into the world; it cannot put anything
   * else in.
   */
  #verifyRecordedTask(event: LabEvent, state: WorldState): void {
    if (!this.#live) this.#fail(event, "a recorded task source is a live-only rule");
    this.#ensureGenerated(state);
    if (this.#generatedIndex !== this.#generatedExpected!.length) {
      this.#fail(event, "recorded work precedes the tick's calibration work");
    }
    assertNoParticipants(event, this.#fail.bind(this));
    if (event.data.source !== "external") this.#fail(event, `unknown task.created source ${String(event.data.source)}`);
    const payload = event.data.task;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      this.#fail(event, "task.created must carry a task object");
    }
    const raw = payload as Record<string, unknown>;
    const input = raw.input as Partial<LiveExternalTaskInput> | undefined;
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      this.#fail(event, "a recorded external task must carry an input object");
    }
    // Rebuilt field by field, so an extra field anywhere in the payload
    // changes the hash and is refused.
    const task = {
      id: String(raw.id),
      family: "external",
      input: {
        kind: input!.kind,
        slug: input!.slug,
        prompt: input!.prompt,
        rubric: input!.rubric,
      },
      createdTick: raw.createdTick,
      deadlineTick: raw.deadlineTick,
      status: "available",
    } as unknown as LabTaskState;
    try {
      assertExternalTask(task, event.tick);
    } catch (error) {
      this.#fail(event, `recorded external task is not admissible: ${errorMessage(error)}`);
    }
    if (task.id !== externalTaskId(
      task.createdTick,
      task.deadlineTick,
      task.input as unknown as LiveExternalTaskInput,
    )) {
      this.#fail(event, "recorded external task id is not the commitment to its own content");
    }
    assertExact(event.data, { task, source: "external" }, event, this.#fail.bind(this), "recorded external task");
    if (openTaskBacklog(state) >= this.config.taskStream.maxBacklog) {
      this.#fail(event, "recorded work exceeds the bounded backlog");
    }
    this.#recordedTaskSeen = true;
  }

  /* ------------------------------------------------------------------ */
  /* Live: recorded verdicts (phase L3b)                                 */
  /* ------------------------------------------------------------------ */

  /**
   * A recorded verdict is accepted by form, exactly as a recorded model answer
   * is: what a grader said cannot be regenerated. What IS checked is that it
   * came from the evaluator this epoch's manifest names, that it grades the
   * submission whose evaluation comes next, and that it is on record BEFORE
   * that evaluation — the order that makes the grade auditable rather than
   * asserted.
   */
  #verifyVerdict(event: LabEvent, state: WorldState): void {
    if (!this.#live) this.#fail(event, "recorded verdicts are a live-only rule");
    assertNoParticipants(event, this.#fail.bind(this));
    if (this.#pendingVerdict !== undefined) this.#fail(event, "a recorded verdict is already awaiting its evaluation");
    const pending = this.#submissions[0];
    if (pending === undefined) this.#fail(event, "a recorded verdict has no pending submission");
    const data = event.data as Record<string, unknown>;
    if (data.submissionId !== pending.id) this.#fail(event, "a recorded verdict must grade the next pending submission");
    const submission = state.submissions[pending.id];
    if (submission === undefined) this.#fail(event, `unknown pending submission ${pending.id}`);
    const task = state.tasks[submission.taskId];
    if (task === undefined || !isExternalTask(task)) {
      this.#fail(event, "only recorded external work is graded by a recorded verdict");
    }
    if (data.taskId !== task.id) this.#fail(event, "a recorded verdict must name its submission's task");
    if (data.evaluatorId !== this.manifest.evaluatorId) {
      this.#fail(event, "a recorded verdict must come from the evaluator this manifest names");
    }
    if (typeof data.content !== "string") this.#fail(event, "a recorded verdict carries its answer verbatim");
    const usage = data.usage as Record<string, unknown> | undefined;
    if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
      this.#fail(event, "a recorded verdict carries a usage record");
    }
    for (const field of ["inputTokens", "outputTokens", "totalTokens"]) {
      const value = usage![field];
      if (!Number.isSafeInteger(value) || (value as number) < 0) {
        this.#fail(event, `a recorded verdict usage.${field} must be a non-negative safe integer`);
      }
    }
    assertExact(
      event.data,
      {
        taskId: task.id,
        submissionId: pending.id,
        evaluatorId: this.manifest.evaluatorId,
        content: data.content,
        usage: {
          inputTokens: usage!.inputTokens,
          outputTokens: usage!.outputTokens,
          totalTokens: usage!.totalTokens,
        },
      },
      event,
      this.#fail.bind(this),
      "recorded verdict data",
    );
    this.#pendingVerdict = pending.id;
  }

  #ensurePolicySchedule(state: WorldState): void {
    if (this.#policyDecisions !== undefined && this.#policyViolations !== undefined) return;
    if (this.#policy instanceof CohortPolicy) this.#policy.load(this.#cognitionRecords);
    const batch = decidePolicyTick(
      state,
      this.#currentTick,
      this.#policy,
      this.#policyRng,
    );
    this.#policyViolations = batch.violations;
    this.#policyDecisions = this.#resolutionRng.fork(this.#currentTick).shuffle(batch.decisions);
  }

  #takePayableDecision(event: LabEvent, state: WorldState): PolicyDecision {
    this.#ensurePolicySchedule(state);
    if (this.#policyViolations!.length > 0) {
      this.#fail(event, "deterministic policy violations must precede action payments");
    }
    while (this.#policyDecisions!.length > 0) {
      const decision = this.#policyDecisions![0]!;
      const agent = state.agents[decision.actorId];
      if (agent === undefined || !agent.active) {
        this.#policyDecisions!.shift();
        continue;
      }
      let cost: ResourceVector;
      try {
        cost = this.#physics.scaledCost(this.config.costs[decision.action.type], state.physics);
      } catch {
        this.#fail(event, "action payment appears before its deterministic cost failure");
      }
      if (!this.#physics.canAfford(agent.resources, cost)) {
        this.#policyDecisions!.shift();
        continue;
      }
      this.#policyDecisions!.shift();
      return decision;
    }
    this.#fail(event, "action payment has no deterministic neutral-policy decision");
  }

  #verifyUncausedViolation(event: LabEvent, state: WorldState): void {
    this.#ensurePolicySchedule(state);
    const expectedPolicy = this.#policyViolations!.shift();
    if (expectedPolicy !== undefined) {
      if (event.actorId !== expectedPolicy.actorId || event.targetId !== undefined) {
        this.#fail(event, "policy failure provenance differs from the deterministic schedule");
      }
      assertExact(
        event.data,
        { agentId: expectedPolicy.actorId, action: "reason", reason: expectedPolicy.reason, count: 1 },
        event,
        this.#fail.bind(this),
        "policy failure",
      );
      return;
    }

    while (this.#policyDecisions!.length > 0) {
      const decision = this.#policyDecisions![0]!;
      const agent = state.agents[decision.actorId];
      if (agent === undefined || !agent.active) {
        this.#policyDecisions!.shift();
        continue;
      }
      let cost: ResourceVector;
      try {
        cost = this.#physics.scaledCost(this.config.costs[decision.action.type], state.physics);
      } catch (error) {
        this.#policyDecisions!.shift();
        const reason = `cost unavailable: ${errorMessage(error)}`;
        if (event.actorId !== decision.actorId || event.targetId !== undefined) {
          this.#fail(event, "cost failure provenance differs from the deterministic schedule");
        }
        assertExact(
          event.data,
          { agentId: decision.actorId, action: decision.action.type, reason, count: 1 },
          event,
          this.#fail.bind(this),
          "cost failure",
        );
        return;
      }
      if (!this.#physics.canAfford(agent.resources, cost)) {
        this.#policyDecisions!.shift();
        continue;
      }
      break;
    }
    this.#fail(event, "uncaused violation is not generated by the deterministic engine");
  }

  #finalizeResolution(event: LabEvent, state: WorldState): void {
    if (this.#openPayment !== undefined) this.#settleSilentPayment(event);
    if (this.#policyViolations!.length > 0) {
      this.#fail(event, "deterministic policy violations are missing");
    }
    while (this.#policyDecisions!.length > 0) {
      const decision = this.#policyDecisions![0]!;
      const agent = state.agents[decision.actorId];
      if (agent === undefined || !agent.active) {
        this.#policyDecisions!.shift();
        continue;
      }
      let cost: ResourceVector;
      try {
        cost = this.#physics.scaledCost(this.config.costs[decision.action.type], state.physics);
      } catch {
        this.#fail(event, "deterministic cost failure event is missing");
      }
      if (!this.#physics.canAfford(agent.resources, cost)) {
        this.#policyDecisions!.shift();
        continue;
      }
      this.#fail(event, "deterministic neutral-policy action payment is missing");
    }
  }

  #decisionRequiresOutcome(decision: PolicyDecision, state: WorldState): boolean {
    switch (decision.action.type) {
      case "observe":
      case "reason":
        return false;
      case "claimTask":
        return state.tasks[decision.action.taskId]?.status === "available";
      case "connect":
        return this.#findLink(state, decision.actorId, decision.action.targetId) === undefined;
      default:
        return true;
    }
  }

  #verifyDecisionOutcome(event: LabEvent, decision: PolicyDecision, state: WorldState): void {
    if (event.type === "violation.recorded") {
      const reason = this.#expectedActionViolation(decision, state);
      if (reason === undefined || event.targetId !== undefined) {
        this.#fail(event, "deterministic neutral-policy action cannot be replaced by a violation");
      }
      assertExact(
        event.data,
        { agentId: decision.actorId, action: decision.action.type, reason, count: 1 },
        event,
        this.#fail.bind(this),
        "deterministic action violation",
      );
      return;
    }
    const actorId = decision.actorId;
    switch (decision.action.type) {
      case "claimTask":
        if (event.type !== "task.claimed" || event.targetId !== undefined) {
          this.#fail(event, "claimTask outcome differs from its deterministic decision");
        }
        assertExact(
          event.data,
          { taskId: decision.action.taskId, agentId: actorId },
          event,
          this.#fail.bind(this),
          "claimTask outcome",
        );
        return;
      case "execute":
        if (event.type !== "memory.stored" || event.targetId !== undefined) {
          this.#fail(event, "execute outcome differs from its deterministic decision");
        }
        assertExact(
          event.data,
          {
            agentId: actorId,
            key: NeutralPolicy.resultMemoryKey(decision.action.taskId),
            value: decision.action.result,
            action: "execute",
            taskId: decision.action.taskId,
          },
          event,
          this.#fail.bind(this),
          "execute outcome",
        );
        return;
      case "submit": {
        if (event.type !== "task.submitted" || event.targetId !== undefined) {
          this.#fail(event, "submit outcome differs from its deterministic decision");
        }
        const submission = {
          id: deterministicId("submission", this.manifest.runId, decision.action.taskId, actorId),
          taskId: decision.action.taskId,
          agentId: actorId,
          result: structuredClone(decision.action.result),
          submittedTick: event.tick,
          submittedSeq: event.seq,
          submittedEventId: event.eventId,
          accepted: false,
          qualityPpm: 0,
          latencyTicks: 0,
        };
        assertExact(event.data, { submission }, event, this.#fail.bind(this), "submit outcome");
        return;
      }
      case "connect": {
        if (event.type !== "link.created" || event.targetId !== decision.action.targetId) {
          this.#fail(event, "connect outcome differs from its deterministic decision");
        }
        const [left, right] = [actorId, decision.action.targetId].sort();
        const link = {
          id: deterministicId("link", this.manifest.runId, left!, right!),
          left: left!,
          right: right!,
          strengthPpm: PPM,
          createdTick: event.tick,
          lastUsedTick: event.tick,
        };
        assertExact(event.data, { link }, event, this.#fail.bind(this), "connect outcome");
        return;
      }
      case "send": {
        if (event.type !== "message.sent" || event.targetId !== decision.action.targetId) {
          this.#fail(event, "send outcome differs from its deterministic decision");
        }
        const link = this.#findLink(state, actorId, decision.action.targetId);
        if (link === undefined) this.#fail(event, "deterministic send has no active link");
        const message = {
          id: deterministicId(
            "message",
            this.manifest.runId,
            this.manifest.universeId,
            event.tick,
            actorId,
            decision.action.targetId,
            decision.localIndex,
          ),
          senderId: actorId,
          recipientId: decision.action.targetId,
          payload: structuredClone(decision.action.payload),
          sentTick: event.tick,
          sentSeq: event.seq,
          sentEventId: event.eventId,
          linkId: link.id,
          localIndex: decision.localIndex,
        };
        assertExact(event.data, { message }, event, this.#fail.bind(this), "send outcome");
        return;
      }
      case "verify": {
        const submission = state.submissions[decision.action.submissionId];
        if (submission === undefined) this.#fail(event, "verify outcome references an unknown submission");
        if (event.type !== "submission.verified" || event.targetId !== submission.agentId) {
          this.#fail(event, "verify outcome differs from its deterministic decision");
        }
        const verification = {
          id: deterministicId("verification", this.manifest.runId, submission.id, actorId),
          submissionId: submission.id,
          verifierId: actorId,
          computedResult: structuredClone(decision.action.computedResult),
          verdict: decision.action.verdict,
          matchesSubmission: hashValue(decision.action.computedResult) === hashValue(submission.result),
          createdTick: event.tick,
        };
        assertExact(event.data, { verification }, event, this.#fail.bind(this), "verify outcome");
        return;
      }
      case "disconnect": {
        const link = this.#findLink(state, actorId, decision.action.targetId);
        if (link === undefined) this.#fail(event, "deterministic disconnect has no active link");
        if (event.type !== "link.removed" || event.targetId !== decision.action.targetId) {
          this.#fail(event, "disconnect outcome differs from its deterministic decision");
        }
        assertExact(event.data, { linkId: link.id }, event, this.#fail.bind(this), "disconnect outcome");
        return;
      }
      case "store":
        if (event.type !== "memory.stored" || event.targetId !== undefined) {
          this.#fail(event, "store outcome differs from its deterministic decision");
        }
        assertExact(
          event.data,
          {
            agentId: actorId,
            key: decision.action.key,
            value: decision.action.value,
            action: "store",
          },
          event,
          this.#fail.bind(this),
          "store outcome",
        );
        return;
      case "retrieve": {
        // A retrieval publishes what the world holds, not what the event says
        // it holds: the value is read back out of the state the verifier has
        // projected, so a forged recall of a key is refused.
        const memory = state.agents[actorId]?.memory;
        if (memory === undefined || !Object.hasOwn(memory, decision.action.key)) {
          this.#fail(event, "retrieve outcome reads a memory key the world does not hold");
        }
        if (event.type !== "memory.retrieved" || event.targetId !== undefined) {
          this.#fail(event, "retrieve outcome differs from its deterministic decision");
        }
        assertExact(
          event.data,
          {
            agentId: actorId,
            key: decision.action.key,
            value: memory[decision.action.key]!,
            action: "retrieve",
          },
          event,
          this.#fail.bind(this),
          "retrieve outcome",
        );
        return;
      }
      case "transfer":
        if (event.type !== "resource.transferred" || event.targetId !== decision.action.targetId) {
          this.#fail(event, "transfer outcome differs from its deterministic decision");
        }
        assertExact(
          event.data,
          {
            fromId: actorId,
            toId: decision.action.targetId,
            resource: decision.action.resource,
            amount: decision.action.amount,
          },
          event,
          this.#fail.bind(this),
          "transfer outcome",
        );
        return;
      case "publishCapability": {
        if (event.type !== "capability.published" || event.targetId !== undefined) {
          this.#fail(event, "publishCapability outcome differs from its deterministic decision");
        }
        // Single embodiment: the published record is built by the same
        // `createCapabilityState` the world published it with, validation and
        // all, rather than re-derived here.
        const capability = capabilityPublicationOf(actorId, event.tick, decision.action.capability);
        if (typeof capability === "string") {
          this.#fail(event, `publishCapability outcome is not a valid publication: ${capability}`);
        }
        assertExact(event.data, { capability }, event, this.#fail.bind(this), "publishCapability outcome");
        return;
      }
      case "useCapability": {
        const capability = state.capabilities[decision.action.capabilityId];
        if (capability === undefined) this.#fail(event, "useCapability outcome names an unknown capability");
        if (event.type !== "capability.used" || event.targetId !== capability.ownerId) {
          this.#fail(event, "useCapability outcome differs from its deterministic decision");
        }
        const caller = state.agents[actorId];
        if (caller === undefined) this.#fail(event, "useCapability outcome has no calling agent");
        const invocation = {
          id: deterministicId(
            "capability-invocation",
            this.manifest.runId,
            this.manifest.universeId,
            event.tick,
            actorId,
            capability.id,
            decision.localIndex,
          ),
          capabilityId: capability.id,
          callerId: actorId,
          input: structuredClone(decision.action.input),
          createdTick: event.tick,
          localIndex: decision.localIndex,
          // The world's three branches, in the world's order: the bounded plan
          // is executed here through the same function, and affordability is
          // measured against the balance left after the action payment.
          ...outcomeOfInvocation(
            executedCapabilityOutput(capability, decision.action.input),
            this.#physics.canAfford(caller.resources, capability.cost),
            capability,
            actorId,
          ),
        };
        assertExact(event.data, { invocation }, event, this.#fail.bind(this), "useCapability outcome");
        return;
      }
      case "spawn":
      case "clone":
      case "merge":
      case "reserve":
      case "trade":
        // Priced, but no reducer performs them: the world pays for the attempt
        // and records the refusal (regenerated in `#expectedActionViolation`).
        // An outcome event for one of them claims a world transition this
        // engine has no implementation of, so it is refused outright rather
        // than checked against a shape that does not exist.
        this.#fail(
          event,
          `${decision.action.type} is unsupported by this engine and cannot produce an action outcome`,
        );
      case "observe":
      case "reason":
        this.#fail(event, `${decision.action.type} must not emit an action outcome`);
      default: {
        // Exhaustive: a new action type fails the build here rather than
        // reaching production as an unverified outcome.
        const unhandled: never = decision.action;
        this.#fail(event, `unsupported action ${(unhandled as WorldAction).type} in the manifest-bound policy`);
      }
    }
  }

  #expectedActionViolation(decision: PolicyDecision, state: WorldState): string | undefined {
    const action = decision.action;
    // An action this engine prices but cannot perform is refused before any
    // referential check: the world pays for the attempt and records exactly
    // this reason, which is regenerated here rather than trusted.
    if (isUnsupportedAction(action.type)) return unsupportedActionReason(action.type);
    switch (action.type) {
      case "connect":
      case "send":
        if (action.targetId === decision.actorId) return "Agent cannot target itself";
        if (!state.agents[action.targetId]?.active) return `Target ${action.targetId} is not active`;
        if (
          action.type === "send"
          && this.#findLink(state, decision.actorId, action.targetId) === undefined
        ) {
          return "Messages require an active link";
        }
        return undefined;
      case "execute":
      case "submit": {
        const task = state.tasks[action.taskId];
        return task === undefined || task.status !== "claimed" || task.claimedBy !== decision.actorId
          ? `Task ${action.taskId} is not claimed by ${decision.actorId}`
          : undefined;
      }
      case "verify": {
        // Mirrors the world's checks in their exact order, so a violation's
        // reason is regenerated rather than trusted.
        const submission = state.submissions[action.submissionId];
        if (submission === undefined) return `Unknown submission ${action.submissionId}`;
        if (submission.agentId === decision.actorId) return "Agents cannot verify their own submissions";
        const duplicate = Object.values(state.verifications).some((verification) => (
          verification.submissionId === submission.id && verification.verifierId === decision.actorId
        ));
        if (duplicate) return `Submission ${submission.id} is already verified by ${decision.actorId}`;
        const matchesSubmission = hashValue(action.computedResult) === hashValue(submission.result);
        return action.verdict === matchesSubmission
          ? undefined
          : "Verification verdict does not match the independently computed result";
      }
      case "disconnect":
        // `disconnect` does not check the target the way `connect`/`send` do:
        // a self-target or an inactive peer simply has no link.
        return this.#findLink(state, decision.actorId, action.targetId) === undefined
          ? "Agents are not connected"
          : undefined;
      case "retrieve": {
        const memory = state.agents[decision.actorId]?.memory;
        return memory !== undefined && Object.hasOwn(memory, action.key)
          ? undefined
          : `Unknown memory key ${action.key}`;
      }
      case "transfer": {
        // The world's checks in their exact order: target, then amount, then
        // the balance left after the action payment.
        if (action.targetId === decision.actorId) return "Agent cannot target itself";
        if (!state.agents[action.targetId]?.active) return `Target ${action.targetId} is not active`;
        if (!Number.isSafeInteger(action.amount) || action.amount <= 0) return "Transfer amount must be positive";
        const balance = state.agents[decision.actorId]?.resources[action.resource] ?? 0;
        return balance < action.amount ? `Insufficient ${action.resource}` : undefined;
      }
      case "publishCapability": {
        if (state.capabilities[action.capability.id] !== undefined) {
          return `Capability ${action.capability.id} already exists`;
        }
        // The publication is validated by the same constructor the world used;
        // `createdTick` plays no part in whether it is accepted.
        const published = capabilityPublicationOf(decision.actorId, state.tick, action.capability);
        return typeof published === "string" ? published : undefined;
      }
      case "useCapability":
        // Only an unknown capability refuses the call. A plan that throws or a
        // caller that cannot pay is a recorded, rejected invocation — an
        // outcome event, not a violation.
        return state.capabilities[action.capabilityId] === undefined
          ? `Unknown capability ${action.capabilityId}`
          : undefined;
      default:
        return undefined;
    }
  }

  #findLink(state: WorldState, left: string, right: string): WorldState["links"][string] | undefined {
    return Object.values(state.links).find((link) => (
      (link.left === left && link.right === right) || (link.left === right && link.right === left)
    ));
  }

  #verifyPayment(event: LabEvent, state: WorldState): void {
    if (this.#openPayment !== undefined) this.#settleSilentPayment(event);
    const decision = this.#takePayableDecision(event, state);
    const actorId = requiredActor(event);
    const action = requiredAction(event.data.action, event);
    if (decision.actorId !== actorId || decision.action.type !== action) {
      this.#fail(event, "action payment differs from the deterministic neutral-policy schedule");
    }
    const expectedCost = this.#physics.scaledCost(this.config.costs[action], state.physics);
    assertExact(event.data, { agentId: actorId, cost: expectedCost, action }, event, this.#fail.bind(this), "resource.spent data");
    if (event.targetId !== undefined || event.causationId !== undefined) this.#fail(event, "resource.spent cannot have target or causation");
    this.#openPayment = {
      id: event.eventId,
      tick: event.tick,
      actorId,
      action,
      decision,
      outcomeRequired: this.#decisionRequiresOutcome(decision, state),
    };
  }

  #verifyPaidOutcome(event: LabEvent, action: PrimitiveActionType, state: WorldState): void {
    if (event.causationId === undefined) this.#fail(event, `${event.type} is missing its action payment causationId`);
    const payment = this.#openPayment;
    if (payment === undefined || payment.id !== event.causationId) this.#fail(event, `${event.type} has an unknown, reused, or non-immediate payment`);
    if (payment.tick !== event.tick || payment.actorId !== event.actorId || payment.action !== action) {
      this.#fail(event, `${event.type} does not match its action payment`);
    }
    this.#verifyDecisionOutcome(event, payment.decision, state);
    this.#openPayment = undefined;
  }

  #settleSilentPayment(event: LabEvent): void {
    const payment = this.#openPayment!;
    if (payment.outcomeRequired) {
      this.#fail(event, `${payment.action} payment is missing its immediate outcome or violation`);
    }
    this.#openPayment = undefined;
  }

  #verifyViolationShape(event: LabEvent, uncaused: boolean): void {
    const actorId = requiredActor(event);
    const action = requiredAction(event.data.action, event);
    const reason = event.data.reason;
    if (typeof reason !== "string" || reason.length === 0) this.#fail(event, "violation reason must be non-empty");
    assertExact(
      event.data,
      { agentId: actorId, action, reason, count: 1 },
      event,
      this.#fail.bind(this),
      "violation data",
    );
    if (event.targetId !== undefined) this.#fail(event, "violation cannot have a target");
    if (uncaused && event.causationId !== undefined) this.#fail(event, "uncaused violation has a causationId");
  }

  #verifyMessageContinuation(event: LabEvent): void {
    const pending = this.#messageChain!;
    const expectedType = pending.stage === "delivery" ? "message.delivered" : "link.used";
    if (
      event.type !== expectedType
      || event.tick !== pending.tick
      || event.actorId !== pending.actorId
      || event.targetId !== pending.targetId
      || event.causationId !== pending.cause
    ) {
      this.#fail(event, `message chain requires immediate ${expectedType}`);
    }
    if (pending.stage === "delivery") {
      assertExact(
        event.data,
        { messageId: pending.messageId, linkId: pending.linkId },
        event,
        this.#fail.bind(this),
        "message delivery data",
      );
      pending.stage = "link";
      pending.cause = event.eventId;
    } else {
      assertExact(
        event.data,
        { linkId: pending.linkId, messageId: pending.messageId },
        event,
        this.#fail.bind(this),
        "link usage data",
      );
      this.#messageChain = undefined;
    }
  }

  #verifyEvaluation(event: LabEvent, state: WorldState): void {
    const pending = this.#submissions.shift();
    if (pending === undefined) this.#fail(event, "task.evaluated has no pending submission");
    const submission = state.submissions[pending.id];
    if (submission === undefined) this.#fail(event, `unknown pending submission ${pending.id}`);
    const task = state.tasks[submission.taskId];
    if (task === undefined) this.#fail(event, `unknown task ${submission.taskId}`);
    // Calibration work is regenerated against its hidden oracle; recorded
    // external work is graded by the verdict that must already be on record.
    const external = isExternalTask(task);
    let accepted: boolean;
    let qualityPpm: number;
    let expectedData: Record<string, unknown>;
    if (external) {
      if (this.#pendingVerdict !== submission.id) {
        this.#fail(event, "recorded external work is evaluated only after its recorded verdict");
      }
      qualityPpm = event.data.qualityPpm as number;
      if (!Number.isSafeInteger(qualityPpm) || qualityPpm < 0 || qualityPpm > PPM) {
        this.#fail(event, "a recorded grade must be an integer in [0, 1000000] ppm");
      }
      accepted = qualityPpm > 0;
      expectedData = {
        taskId: task.id,
        submissionId: submission.id,
        accepted,
        qualityPpm,
        latencyTicks: event.tick - task.createdTick,
        violations: 0,
        evaluatorId: this.manifest.evaluatorId,
        completedTick: event.tick,
      };
      this.#pendingVerdict = undefined;
    } else {
      if (this.#pendingVerdict !== undefined) {
        this.#fail(event, "calibration work is graded by its oracle, never by a recorded verdict");
      }
      const oracle = this.#oracles.get(task.id);
      if (oracle === undefined) this.#fail(event, `missing deterministic oracle for ${task.id}`);
      accepted = equalJson(oracle, submission.result);
      qualityPpm = accepted ? PPM : 0;
      expectedData = {
        taskId: task.id,
        submissionId: submission.id,
        accepted,
        qualityPpm,
        latencyTicks: event.tick - task.createdTick,
        violations: 0,
        completedTick: event.tick,
      };
    }
    if (event.actorId !== submission.agentId || event.targetId !== undefined || event.causationId !== pending.eventId) {
      this.#fail(event, "task.evaluated provenance differs from its submission");
    }
    assertExact(event.data, expectedData, event, this.#fail.bind(this), "task evaluation");
    this.#oracles.delete(task.id);
    const reward = qualityPpm === PPM
      ? this.config.acceptedTaskReward
      : proportionalReward(this.config.acceptedTaskReward, qualityPpm);
    if (accepted && this.#physics.canAfford(state.treasury, reward)) {
      this.#rewards = RESOURCE_KINDS.flatMap((resource) => {
        const amount = reward[resource];
        return amount === 0 ? [] : [{
          actorId: "@treasury" as const,
          targetId: submission.agentId,
          causationId: event.eventId,
          data: {
            fromId: "@treasury",
            toId: submission.agentId,
            resource,
            amount,
            reason: "accepted-task",
            taskId: task.id,
          },
        }];
      });
    }
  }

  #verifyReward(event: LabEvent): void {
    const expected = this.#rewards.shift()!;
    if (
      event.type !== "resource.transferred"
      || event.phase !== "evaluation"
      || event.actorId !== expected.actorId
      || event.targetId !== expected.targetId
      || event.causationId !== expected.causationId
    ) {
      this.#fail(event, "accepted-task reward sequence or provenance is invalid");
    }
    assertExact(event.data, expected.data, event, this.#fail.bind(this), "accepted-task reward");
  }

  #verifyMetrics(event: LabEvent, state: WorldState): void {
    const required = this.#currentTick % this.config.metricEvery === 0 || this.#currentTick === this.config.ticks;
    if (!required || this.#metricsSeen) this.#fail(event, "metrics.recorded is not scheduled exactly once for this tick");
    assertNoParticipants(event, this.#fail.bind(this));
    assertExact(
      event.data,
      { metrics: computeMetrics(state, this.#initialAgentTotals) },
      event,
      this.#fail.bind(this),
      "metrics snapshot",
    );
    this.#metricsSeen = true;
  }

  #verifyTickCompleted(event: LabEvent, state: WorldState): void {
    if (this.#tickCompleted) this.#fail(event, "duplicate tick.completed");
    const requiredMetrics = this.#currentTick % this.config.metricEvery === 0 || this.#currentTick === this.config.ticks;
    if (this.#metricsSeen !== requiredMetrics) this.#fail(event, "required metric schedule was not satisfied");
    if (
      this.#messageChain !== undefined
      || this.#submissions.length > 0
      || this.#rewards.length > 0
      || this.#thinkingExpected.length > 0
      || this.#pendingVerdict !== undefined
    ) {
      this.#fail(event, "tick.completed has unresolved causal work");
    }
    // The bounded world (phase L3c). The archive plan is a fixpoint, so a tick
    // that archived exactly what the rule names leaves nothing archivable
    // behind; anything still here is a record the run chose to keep.
    this.#ensureArchive(state);
    if (!isEmptyLiveArchivePlan(this.#archiveExpected ?? emptyLiveArchivePlan())) {
      this.#fail(event, "the upkeep left records the archive windows require it to archive");
    }
    assertNoParticipants(event, this.#fail.bind(this));
    assertExact(event.data, { tick: this.#currentTick }, event, this.#fail.bind(this), "tick.completed data");
    // Ensure task generation is finalized even when the tick has no task events.
    this.#finalizeSkippedPhases(PHASE_RANK.upkeep, event, state);
    if (this.#boundaryExpiryExpected !== undefined && this.#boundaryExpiryExpected.length > 0) {
      this.#fail(event, "epoch-boundary task expiry events are missing");
    }
    if (this.#exhaustionExpected !== undefined && this.#exhaustionExpected.length > 0) {
      this.#fail(event, "exhaustion retirement events are missing");
    }
    this.#tickCompleted = true;
  }

  #verifyRunCompleted(event: LabEvent): void {
    if (!this.#tickCompleted || this.#currentTick !== this.config.ticks || event.tick !== this.config.ticks) {
      this.#fail(event, "run.completed requires the configured final tick.completed");
    }
    assertNoParticipants(event, this.#fail.bind(this));
    assertExact(
      event.data,
      { ticks: this.config.ticks, events: event.seq },
      event,
      this.#fail.bind(this),
      "run.completed data",
    );
    this.#completed = true;
  }

  #assertEventPhase(event: LabEvent): void {
    const phases = (this.#live ? LIVE_EVENT_PHASES : EVENT_PHASES)[event.type];
    if (phases === undefined || !phases.includes(event.phase)) {
      this.#fail(event, `${event.type} is not valid in phase ${event.phase}`);
    }
  }

  #fail(event: LabEvent, reason: string): never {
    throw new ProtocolVerificationError(`Protocol event ${event.seq} (${event.type}): ${reason}`);
  }
}

export function assertReplayConfiguration(manifest: RunManifest, config: GenesisConfig): void {
  validateGenesisConfig(config);
  if (manifest.experimentId !== config.experimentId) throw new ProtocolVerificationError("Manifest experiment does not match config");
  if (manifest.seed !== config.seed) throw new ProtocolVerificationError("Manifest seed does not match config");
  if (manifest.configHash !== hashValue(config)) throw new ProtocolVerificationError("Manifest configHash does not match config");
  const expected = createRunManifest(config, manifest.universeId, {
    policyId: manifest.policyId,
    mode: manifest.mode,
    ...(manifest.cognitionId === undefined ? {} : { cognitionId: manifest.cognitionId }),
    ...(manifest.evaluatorId === undefined ? {} : { evaluatorId: manifest.evaluatorId }),
  });
  if (hashValue(manifest) !== hashValue(expected)) {
    throw new ProtocolVerificationError("Manifest identity or runId is not deterministic for this config");
  }
}

function assertExact(
  actual: unknown,
  expected: unknown,
  event: LabEvent,
  fail: (event: LabEvent, reason: string) => never,
  label: string,
): void {
  if (hashValue(actual) !== hashValue(expected)) fail(event, `${label} differs from deterministic protocol data`);
}

/**
 * The capability record a publication would produce, or the exact message the
 * world would have recorded as the violation instead.
 *
 * Both answers come from the one constructor the world publishes with, so the
 * verifier never carries a second copy of what a valid capability is.
 */
function capabilityPublicationOf(
  ownerId: string,
  tick: number,
  publication: Extract<WorldAction, { type: "publishCapability" }>["capability"],
): CapabilityState | string {
  try {
    return createCapabilityState(ownerId, tick, publication);
  } catch (error) {
    return errorMessage(error);
  }
}

/** The bounded plan's output, or `undefined` when the plan refuses the input. */
function executedCapabilityOutput(capability: CapabilityState, input: JsonValue): JsonObject | undefined {
  try {
    return executeCapabilityPlan(capability, input);
  } catch {
    return undefined;
  }
}

/**
 * The variable half of a capability invocation, in the world's own order:
 * a plan that refuses the input is rejected before affordability is consulted,
 * and only a call that both executes and can be paid for is accepted.
 */
function outcomeOfInvocation(
  output: JsonObject | undefined,
  affordable: boolean,
  capability: CapabilityState,
  callerId: string,
): JsonObject {
  if (output === undefined) {
    return { accepted: false, success: false, chargedCost: { ...ZERO_RESOURCES }, reason: "execution_failed" };
  }
  if (!affordable) {
    return { accepted: false, success: false, chargedCost: { ...ZERO_RESOURCES }, reason: "insufficient_resources" };
  }
  return {
    accepted: true,
    success: true,
    output,
    chargedCost: { ...capability.cost },
    paymentTo: capability.ownerId === callerId ? "@treasury" : capability.ownerId,
  };
}

function assertNoParticipants(
  event: LabEvent,
  fail: (event: LabEvent, reason: string) => never,
): void {
  if (event.actorId !== undefined || event.targetId !== undefined || event.causationId !== undefined) {
    fail(event, `${event.type} cannot have actor, target, or causation fields`);
  }
}

function requiredActor(event: LabEvent): string {
  if (event.actorId === undefined) throw new ProtocolVerificationError(`Protocol event ${event.seq} requires actorId`);
  return event.actorId;
}

function requiredTarget(event: LabEvent): string {
  if (event.targetId === undefined) throw new ProtocolVerificationError(`Protocol event ${event.seq} requires targetId`);
  return event.targetId;
}

function requiredAction(value: unknown, event: LabEvent): PrimitiveActionType {
  if (typeof value !== "string" || !Object.hasOwn(eventActionCostsSentinel, value)) {
    throw new ProtocolVerificationError(`Protocol event ${event.seq} has invalid action`);
  }
  return value as PrimitiveActionType;
}

const eventActionCostsSentinel: Record<PrimitiveActionType, true> = {
  observe: true, reason: true, send: true, connect: true, disconnect: true,
  store: true, retrieve: true, execute: true, verify: true, spawn: true,
  clone: true, merge: true, reserve: true, transfer: true, trade: true,
  publishCapability: true, useCapability: true, claimTask: true, submit: true,
};

function requiredNestedId(data: JsonObject, key: string): string {
  const nested = data[key];
  if (nested === null || typeof nested !== "object" || Array.isArray(nested)) {
    throw new ProtocolVerificationError(`${key} must be an object`);
  }
  const id = (nested as JsonObject).id;
  if (typeof id !== "string" || id.length === 0) throw new ProtocolVerificationError(`${key}.id must be a non-empty string`);
  return id;
}

function requiredNestedString(data: JsonObject, key: string, field: string): string {
  const nested = data[key];
  if (nested === null || typeof nested !== "object" || Array.isArray(nested)) {
    throw new ProtocolVerificationError(`${key} must be an object`);
  }
  const value = (nested as JsonObject)[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ProtocolVerificationError(`${key}.${field} must be a non-empty string`);
  }
  return value;
}

function safePpmMultiply(value: number, multiplierPpm: number): number {
  const result = (BigInt(value) * BigInt(multiplierPpm)) / BigInt(PPM);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProtocolVerificationError("Task load exceeds safe integer range");
  return Number(result);
}

/** The cohort a manifest policy id belongs to, e.g. `cohort-c-...` to `"C"`. */
function cohortOf(policyId: string): "A" | "B" | "C" {
  const letter = /^cohort-([abc])-/.exec(policyId)?.[1];
  if (letter === undefined) throw new ProtocolVerificationError(`Policy ${policyId} is not a cohort policy`);
  return letter.toUpperCase() as "A" | "B" | "C";
}

/**
 * Rebuild a record from its event without trusting the payload's shape.
 *
 * A cognitive cohort's decisions depend only on the actions, so everything
 * else is deliberately zeroed — the verifier must not be able to depend on a
 * field it does not check. A live epoch is different: the world charges for
 * the tokens the record reports, at the tier the record names, so both are
 * kept and both become part of what the debit is checked against.
 */
function decodeCognitionRecord(
  event: LabEvent,
  live: boolean,
  fail: (reason: string) => never,
): CognitionRecord {
  const data = event.data as Record<string, unknown>;
  const actions = data.actions;
  if (!Array.isArray(actions)) fail("cognition.recorded requires an actions array");
  if (typeof data.cohort !== "string") fail("cognition.recorded requires a cohort");
  if (typeof event.actorId !== "string") fail("cognition.recorded requires an actorId");
  const record: CognitionRecord = {
    tick: event.tick,
    agentId: event.actorId,
    cohort: data.cohort as "A" | "B" | "C",
    provider: String(data.provider ?? ""),
    model: String(data.model ?? ""),
    content: String(data.content ?? ""),
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    latencyMs: 0,
    actions: structuredClone(actions) as CognitionRecord["actions"],
  };
  if (!live) return record;
  const usage = data.usage as Record<string, unknown> | undefined;
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    fail("a live cognition.recorded requires a usage record");
  }
  for (const field of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    const value = usage![field];
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      fail(`a live cognition.recorded usage.${field} must be a non-negative safe integer`);
    }
    record.usage[field] = value as number;
  }
  const tier = data.tier;
  if (tier !== undefined && !LIVE_TIERS.includes(tier as LiveThinkTier)) {
    fail(`a live cognition.recorded names an unknown tier ${String(tier)}`);
  }
  if (tier !== undefined) record.tier = tier as LiveThinkTier;
  return record;
}

const LIVE_TIERS: readonly LiveThinkTier[] = Object.freeze(["fast", "standard", "deliberate"]);

/** One event the world owes immediately after a recorded thought. */
interface ExpectedThinkingEvent {
  type: "resource.spent" | "violation.recorded";
  actorId: string;
  causationId: string;
  data: JsonObject;
  overdraft?: boolean;
}

function multiplyResources(resources: ResourceVector, count: number): ResourceVector {
  const output = { ...resources };
  for (const resource of RESOURCE_KINDS) {
    const value = BigInt(resources[resource]) * BigInt(count);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProtocolVerificationError(`Initial ${resource} total exceeds safe integer range`);
    output[resource] = Number(value);
  }
  return output;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
