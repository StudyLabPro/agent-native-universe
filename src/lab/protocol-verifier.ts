import type { JsonObject, JsonValue } from "../core/types.js";
import { createGenesisAgents } from "./agent-factory.js";
import { hashValue } from "./canonical.js";
import { validateGenesisConfig } from "./config.js";
import { equalJson } from "./evaluator.js";
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
import { PressureEngine } from "./pressure-engine.js";
import { RESOURCE_KINDS, ResourcePhysics } from "./resource-physics.js";
import { DeterministicRng } from "./rng.js";
import { DeterministicTaskStream, type GeneratedTask } from "./task-stream.js";
import {
  PPM,
  type CheckpointRuntimeState,
  type GenesisConfig,
  type LabEvent,
  type LabEventType,
  type PrimitiveActionType,
  type ResourceVector,
  type RunManifest,
  type TickPhase,
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
  #cognitionRecords: CognitionRecord[] = [];
  readonly #policyRng: DeterministicRng;
  readonly #resolutionRng: DeterministicRng;
  readonly #tasks: DeterministicTaskStream;
  readonly #initialAgentTotals: ResourceVector;
  readonly #oracles = new Map<string, JsonValue>();
  readonly #submissions: PendingSubmission[] = [];

  #started = false;
  #genesisAgentIndex = 0;
  #currentTick = 0;
  #lastPhaseRank = -1;
  #tickCompleted = false;
  #metricsSeen = false;
  #completed = false;
  #pressureExpected: ExpectedPressureEvent[] = [];
  #expiryExpected: string[] = [];
  #generatedExpected: GeneratedTask[] | undefined;
  #generatedIndex = 0;
  #rewards: ExpectedReward[] = [];
  #messageChain: MessageChain | undefined;
  #openPayment: PaymentAnchor | undefined;
  #policyDecisions: PolicyDecision[] | undefined;
  #policyViolations: DeferredPolicyViolation[] | undefined;

  constructor(manifest: RunManifest, config: GenesisConfig) {
    assertReplayConfiguration(manifest, config);
    this.manifest = structuredClone(manifest);
    this.config = structuredClone(config);
    this.#genesisAgents = createGenesisAgents(config);
    const rootRng = new DeterministicRng(hashValue({
      domain: "agent-native-universe/lab/logical-universe/v1",
      runId: manifest.runId,
      universeId: manifest.universeId,
      seed: config.seed,
    }));
    this.#tasks = new DeterministicTaskStream(config.taskStream, rootRng.fork("tasks"));
    this.#pressure = new PressureEngine(config.pressures);
    this.#pressureRng = rootRng.fork("pressure");
    this.#policyRng = rootRng.fork("policy");
    this.#resolutionRng = rootRng.fork("resolution");
    this.#initialAgentTotals = multiplyResources(config.initialResources, config.agents);
    this.#cognitive = manifest.mode === "cognitive";
    this.#policy = this.#cognitive
      ? new CohortPolicy(cohortOf(manifest.policyId), this.#neutral)
      : manifest.policyId === LAB_POLICY_ID
        ? this.#neutral
        : createLogicalPolicyById(manifest.policyId);
  }

  verifyNext(event: LabEvent, state: WorldState): void {
    if (this.#completed) this.#fail(event, "event follows run.completed");
    this.#assertEventPhase(event);

    if (event.tick === 0 || !this.#started || this.#genesisAgentIndex < this.#genesisAgents.length) {
      if (this.#verifyGenesis(event)) return;
    }
    if (event.tick === 0) this.#fail(event, "tick 0 is reserved for genesis");
    if (!this.#started || this.#genesisAgentIndex !== this.#genesisAgents.length) {
      this.#fail(event, "tick 1 cannot start before the complete genesis population");
    }

    this.#enterTick(event, state);
    const rank = PHASE_RANK[event.phase];
    this.#finalizeSkippedPhases(rank, event, state);
    if (rank < this.#lastPhaseRank) this.#fail(event, "phase moves backwards within a tick");
    this.#lastPhaseRank = rank;

    if (event.type === "cognition.recorded") {
      // Recorded cognition is an input to the decision phase, not an outcome of
      // it: accept it here and let it steer the schedule regenerated below.
      if (!this.#cognitive) this.#fail(event, "cognition.recorded requires a cognitive manifest");
      if (this.#policyDecisions !== undefined) {
        this.#fail(event, "cognition must be recorded before the decision phase of its tick");
      }
      this.#cognitionRecords.push(decodeCognitionRecord(event, (reason) => this.#fail(event, reason)));
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
      case "agent.retired":
        this.#verifyPressure(event);
        break;
      case "task.expired":
        this.#verifyExpiry(event);
        break;
      case "task.created":
        this.#verifyGeneratedTask(event, state);
        break;
      case "resource.spent":
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
    if (!this.#started || this.#genesisAgentIndex !== this.#genesisAgents.length) {
      throw new ProtocolVerificationError("Cannot checkpoint before complete genesis");
    }
    if (this.#currentTick !== 0 && !this.#tickCompleted) {
      throw new ProtocolVerificationError("Cannot checkpoint inside an incomplete tick");
    }
    return {
      taskStream: this.#tasks.checkpoint(),
      policy: this.#policy instanceof NeutralPolicy ? this.#policy.checkpoint() : null,
    };
  }

  #verifyGenesis(event: LabEvent): boolean {
    if (event.tick !== 0 || event.phase !== "genesis") return false;
    if (!this.#started) {
      if (event.seq !== 1 || event.type !== "run.started") this.#fail(event, "run.started must be event 1");
      assertNoParticipants(event, this.#fail.bind(this));
      assertExact(event.data, { treasury: this.config.treasuryResources }, event, this.#fail.bind(this), "run.started data");
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
    if (this.#currentTick === 0) {
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
    this.#metricsSeen = false;
    this.#generatedExpected = undefined;
    this.#generatedIndex = 0;
    this.#openPayment = undefined;
    this.#policyDecisions = undefined;
    this.#policyViolations = undefined;
    this.#cognitionRecords = [];
    const pressure = this.#pressure.forTick(tick, state, this.#pressureRng.fork(tick));
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
    if (rank >= PHASE_RANK.resolution) this.#ensurePolicySchedule(state);
    if (rank > PHASE_RANK.resolution) this.#finalizeResolution(event, state);
  }

  #verifyPressure(event: LabEvent): void {
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

  #verifyExpiry(event: LabEvent): void {
    const expectedId = this.#expiryExpected.shift();
    if (expectedId === undefined) this.#fail(event, "unexpected task.expired event");
    assertNoParticipants(event, this.#fail.bind(this));
    assertExact(event.data, { taskId: expectedId }, event, this.#fail.bind(this), "task expiry data");
    this.#oracles.delete(expectedId);
  }

  #ensureGenerated(state: WorldState): void {
    if (this.#generatedExpected !== undefined) return;
    const backlog = Object.values(state.tasks)
      .filter((task) => task.status !== "completed" && task.status !== "expired").length;
    const capacity = Math.max(0, this.config.taskStream.maxBacklog - backlog);
    const scaled = safePpmMultiply(this.config.taskStream.tasksPerTick, state.physics.taskLoadPpm);
    this.#generatedExpected = this.#tasks.generate(this.#currentTick, Math.min(capacity, scaled));
  }

  #verifyGeneratedTask(event: LabEvent, state: WorldState): void {
    if (this.#expiryExpected.length > 0) this.#fail(event, "task.created precedes required expiry events");
    this.#ensureGenerated(state);
    const expected = this.#generatedExpected![this.#generatedIndex];
    if (expected === undefined) this.#fail(event, "unexpected deterministic task");
    assertNoParticipants(event, this.#fail.bind(this));
    assertExact(event.data, { task: expected.task }, event, this.#fail.bind(this), "generated task");
    this.#oracles.set(expected.task.id, structuredClone(expected.expected));
    this.#generatedIndex += 1;
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
      case "observe":
      case "reason":
        this.#fail(event, `${decision.action.type} must not emit an action outcome`);
      default:
        this.#fail(event, `unsupported action ${decision.action.type} in the manifest-bound policy`);
    }
  }

  #expectedActionViolation(decision: PolicyDecision, state: WorldState): string | undefined {
    const action = decision.action;
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
    const oracle = this.#oracles.get(task.id);
    if (oracle === undefined) this.#fail(event, `missing deterministic oracle for ${task.id}`);
    const accepted = equalJson(oracle, submission.result);
    const expectedData = {
      taskId: task.id,
      submissionId: submission.id,
      accepted,
      qualityPpm: accepted ? PPM : 0,
      latencyTicks: event.tick - task.createdTick,
      violations: 0,
      completedTick: event.tick,
    };
    if (event.actorId !== submission.agentId || event.targetId !== undefined || event.causationId !== pending.eventId) {
      this.#fail(event, "task.evaluated provenance differs from its submission");
    }
    assertExact(event.data, expectedData, event, this.#fail.bind(this), "task evaluation");
    this.#oracles.delete(task.id);
    if (accepted && this.#physics.canAfford(state.treasury, this.config.acceptedTaskReward)) {
      this.#rewards = RESOURCE_KINDS.flatMap((resource) => {
        const amount = this.config.acceptedTaskReward[resource];
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
    if (this.#messageChain !== undefined || this.#submissions.length > 0 || this.#rewards.length > 0) {
      this.#fail(event, "tick.completed has unresolved causal work");
    }
    assertNoParticipants(event, this.#fail.bind(this));
    assertExact(event.data, { tick: this.#currentTick }, event, this.#fail.bind(this), "tick.completed data");
    // Ensure task generation is finalized even when the tick has no task events.
    this.#finalizeSkippedPhases(PHASE_RANK.upkeep, event, state);
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
    const phases = EVENT_PHASES[event.type];
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

/** Rebuild a record from its event without trusting the payload's shape. */
function decodeCognitionRecord(event: LabEvent, fail: (reason: string) => never): CognitionRecord {
  const data = event.data as Record<string, unknown>;
  const actions = data.actions;
  if (!Array.isArray(actions)) fail("cognition.recorded requires an actions array");
  if (typeof data.cohort !== "string") fail("cognition.recorded requires a cohort");
  if (typeof event.actorId !== "string") fail("cognition.recorded requires an actorId");
  return {
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
