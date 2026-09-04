import type { JsonObject, JsonValue } from "../core/types.js";
import type { ParetoAnalysis } from "./pareto.js";

export const LAB_SCHEMA_VERSION = 1 as const;
export const PPM = 1_000_000;

/**
 * Every experiment identity the lab may write evidence under. The list is the
 * authority for `GenesisConfig.experimentId`, for the per-command allowlist of
 * the CLI and for the evidence directory `<dataRoot>/<experimentId>/`.
 *
 * - `genesis-1`: the deterministic scientific track (logical arms, cognitive
 *   cohorts, populations, baselines). Only this identity is science.
 * - `genesis-live`: the open-ended Genesis-Live universe (`mode: "live"`,
 *   engine `genesis-live-v1.0.0`). Never an arm, never a baseline.
 * - `genesis-live-canary`: the engineering First Light canary — the genesis-1
 *   cohort path (`--cohort B|C`) run under its own identity so that its
 *   evidence can never be aggregated with the scientific track.
 */
export const LAB_EXPERIMENT_IDS = Object.freeze([
  "genesis-1",
  "genesis-live",
  "genesis-live-canary",
] as const);
export type LabExperimentId = (typeof LAB_EXPERIMENT_IDS)[number];
/** The only experiment identity whose evidence is scientific. */
export const LAB_SCIENCE_EXPERIMENT_ID: LabExperimentId = "genesis-1";
export const LAB_LIVE_EXPERIMENT_ID: LabExperimentId = "genesis-live";
export const LAB_LIVE_CANARY_EXPERIMENT_ID: LabExperimentId = "genesis-live-canary";

export function isLabExperimentId(value: unknown): value is LabExperimentId {
  return typeof value === "string" && (LAB_EXPERIMENT_IDS as readonly string[]).includes(value);
}

/**
 * `logical` runs regenerate their own decision stream from the seed.
 * `cognitive` runs cannot: a model answered, so replay reads the recorded
 * answers back instead of re-deriving them.
 * `live` runs are Genesis-Live epochs: every non-seed input (model answers,
 * external tasks, verdicts, operator physics) enters the chain as a recorded
 * input. Only the `genesis-live` experiment may use this mode.
 */
export type LabRunMode = "logical" | "cognitive" | "live";

export type PrimitiveActionType =
  | "observe"
  | "reason"
  | "send"
  | "connect"
  | "disconnect"
  | "store"
  | "retrieve"
  | "execute"
  | "verify"
  | "spawn"
  | "clone"
  | "merge"
  | "reserve"
  | "transfer"
  | "trade"
  | "publishCapability"
  | "useCapability"
  | "claimTask"
  | "submit";

export type ResourceKind =
  | "credits"
  | "llmTokens"
  | "computeMs"
  | "storageBytes"
  | "bandwidthBytes";

export interface ResourceVector {
  credits: number;
  llmTokens: number;
  computeMs: number;
  storageBytes: number;
  bandwidthBytes: number;
}

export type TaskFamily =
  | "arithmetic"
  | "json_transform"
  | "memory_recall"
  | "correlation"
  | "verification"
  | "multi_step"
  | "concurrency"
  | "state_recovery";

/**
 * Live-only task family for tasks that enter the world from a recorded
 * external source. It is deliberately NOT a `TaskFamily`: the frozen list of
 * eight families in `config.ts`/`metrics.ts` is part of the scientific
 * measurement (specialization is computed over exactly those eight), and the
 * literal must never appear in a non-live world state.
 */
export type LiveTaskFamily = TaskFamily | "external";

export type TaskStatus = "available" | "claimed" | "submitted" | "completed" | "expired";

export interface TaskStreamConfig {
  families: TaskFamily[];
  tasksPerTick: number;
  deadlineTicks: number;
  maxBacklog: number;
  /**
   * When present, the task stream is seeded from this value alone instead of
   * from the run identity, so runs that differ only in policy or costs face
   * the identical realization of tasks and oracles. Control-arm comparisons
   * pin it; absent, the stream stays bound to the run as before.
   */
  realizationSeed?: string;
}

export type PressureSpec =
  | { tick: number; type: "resource_price_multiplier"; resource: ResourceKind; multiplierPpm: number }
  | { tick: number; type: "bandwidth_capacity_multiplier"; multiplierPpm: number }
  | { tick: number; type: "retire_agent_fraction"; fractionPpm: number }
  | { tick: number; type: "task_load_multiplier"; multiplierPpm: number };

export type LiveThinkTier = "fast" | "standard" | "deliberate";
export const LIVE_THINK_TIERS = Object.freeze(["fast", "standard", "deliberate"] as const);

/** World price of one thinking tier: `llmTokens` charged per metered token, in ppm. */
export interface LiveTierPhysics {
  pricePpm: number;
}

export interface LiveExhaustionConfig {
  /** An agent below this `llmTokens` balance can no longer think. */
  minThinkTokens: number;
  /** Consecutive ticks of starvation (without a claimed task) before retirement. */
  graceTicks: number;
}

/** Archive windows, in ticks, after which settled records leave the live state. */
export interface LiveArchiveConfig {
  taskTicks: number;
  messageTicks: number;
  submissionTicks: number;
}

/**
 * Genesis of an inherited epoch: the parent epoch's final state, pinned by
 * hash so the child's `configHash` — and therefore its `runId` — is a pure
 * function of what the parent left on disk.
 */
export interface LiveGenesisFrom {
  runId: string;
  tick: number;
  seq: number;
  eventHash: string;
  stateHash: string;
  runtimeHash: string;
  genesisStateHash: string;
}

/**
 * Genesis-Live physics. Present exactly when `experimentId` is `genesis-live`;
 * it is part of the config and therefore of `configHash` and `runId`.
 * Model names are never here: the model layer is the cognition port's
 * identity (`cognitionId`), and the control plane only sets prices.
 */
export interface LiveConfig {
  /** Ticks per epoch; `ticks` of epoch k equals `genesisFrom.tick + epochTicks`. */
  epochTicks: number;
  tiers: Record<LiveThinkTier, LiveTierPhysics>;
  exhaustion: LiveExhaustionConfig;
  archive: LiveArchiveConfig;
  /** Fsync the event log at every `tick.completed` (only tick boundaries are durable). */
  fsyncEveryTick: boolean;
  genesisFrom?: LiveGenesisFrom;
}

export interface GenesisConfig {
  schemaVersion: typeof LAB_SCHEMA_VERSION;
  experimentId: LabExperimentId;
  seed: string;
  ticks: number;
  agents: number;
  metricEvery: number;
  checkpointEvery: number;
  initialResources: ResourceVector;
  treasuryResources: ResourceVector;
  acceptedTaskReward: ResourceVector;
  costs: Record<PrimitiveActionType, ResourceVector>;
  taskStream: TaskStreamConfig;
  pressures: PressureSpec[];
  /** Genesis-Live physics; validated and permitted only for `genesis-live`. */
  live?: LiveConfig;
}

export interface RunManifest {
  schemaVersion: typeof LAB_SCHEMA_VERSION;
  experimentId: string;
  engineVersion: string;
  /** See {@link LabRunMode}. */
  mode: LabRunMode;
  policyId: string;
  taskGeneratorId: string;
  /**
   * Identity of the cognition port consulted (model, endpoint, consultation
   * budget). Present exactly when mode is `cognitive`, and hashed into the
   * runId so runs of different models can never share evidence.
   */
  cognitionId?: string;
  runId: string;
  universeId: string;
  seed: string;
  configHash: string;
}

export interface AgentLearningState {
  attempts: Partial<Record<TaskFamily, number>>;
  successes: Partial<Record<TaskFamily, number>>;
  utilityPpm: Partial<Record<TaskFamily, number>>;
}

export interface LabAgentState {
  id: string;
  active: boolean;
  generation: number;
  lineage: string[];
  resources: ResourceVector;
  inbox: string[];
  memory: Record<string, JsonValue>;
  learning: AgentLearningState;
  actionCounts: Partial<Record<PrimitiveActionType, number>>;
  taskCounts: Partial<Record<TaskFamily, number>>;
  violations: number;
  createdTick: number;
  retiredTick?: number;
}

export interface LabLinkState {
  id: string;
  left: string;
  right: string;
  strengthPpm: number;
  createdTick: number;
  lastUsedTick: number;
}

export interface LabTaskState {
  id: string;
  family: TaskFamily;
  input: JsonValue;
  createdTick: number;
  deadlineTick: number;
  status: TaskStatus;
  claimedBy?: string;
  submittedBy?: string;
  completedTick?: number;
  /** Event that completed the task; retained so rewards/attestations have a verifiable parent. */
  evaluationEventId?: string;
}

export interface SubmissionState {
  id: string;
  taskId: string;
  agentId: string;
  result: JsonValue;
  submittedTick: number;
  submittedSeq: number;
  submittedEventId: string;
  accepted: boolean;
  qualityPpm: number;
  latencyTicks: number;
}

export interface MessageState {
  id: string;
  senderId: string;
  recipientId: string;
  payload: JsonObject;
  sentTick: number;
  sentSeq: number;
  sentEventId: string;
  linkId: string;
  localIndex: number;
  deliveredTick?: number;
  deliveredSeq?: number;
  deliveredEventId?: string;
  linkUsedEventId?: string;
}

/** A public attestation. It is deliberately separate from evaluator truth. */
export interface VerificationState {
  id: string;
  submissionId: string;
  verifierId: string;
  computedResult: JsonValue;
  verdict: boolean;
  matchesSubmission: boolean;
  createdTick: number;
}

export type CapabilityPlanStep =
  | { op: "copy"; from: string; to: string }
  | { op: "sum"; inputs: string[]; output: string }
  | { op: "concat"; inputs: string[]; output: string; separator: string }
  | { op: "literal"; output: string; value: JsonValue };

export interface CapabilityState {
  id: string;
  ownerId: string;
  version: number;
  inputs: string[];
  outputs: string[];
  primitivePlan: PrimitiveActionType[];
  executionPlan: CapabilityPlanStep[];
  tests: JsonValue[];
  cost: ResourceVector;
  createdTick: number;
  usageCount: number;
  successCount: number;
}

export interface CapabilityInvocationState {
  id: string;
  capabilityId: string;
  callerId: string;
  input: JsonValue;
  accepted: boolean;
  success: boolean;
  chargedCost: ResourceVector;
  createdTick: number;
  localIndex: number;
  output?: JsonValue;
  paymentTo?: string;
  reason?: string;
}

export interface PhysicsState {
  resourcePricePpm: Record<ResourceKind, number>;
  bandwidthCapacityPpm: number;
  taskLoadPpm: number;
}

export interface WorldState {
  schemaVersion: typeof LAB_SCHEMA_VERSION;
  runId: string;
  universeId: string;
  configHash: string;
  seed: string;
  tick: number;
  started: boolean;
  agents: Record<string, LabAgentState>;
  links: Record<string, LabLinkState>;
  tasks: Record<string, LabTaskState>;
  submissions: Record<string, SubmissionState>;
  submissionOrder: string[];
  verifications: Record<string, VerificationState>;
  messages: Record<string, MessageState>;
  capabilities: Record<string, CapabilityState>;
  capabilityInvocations: Record<string, CapabilityInvocationState>;
  physics: PhysicsState;
  treasury: ResourceVector;
  resourceSpent: ResourceVector;
  metrics: MetricsSnapshot[];
  completed: boolean;
  /**
   * stateHash discipline (Genesis-Live): `stateHash = hashValue(state)` and
   * checkpoints are verified against it, so any field present in a non-live
   * state would silently change every scientific hash without an engine bump.
   * The two fields below are therefore optional and are set ONLY by the live
   * genesis of a `mode: "live"` manifest; `initialWorldState` of a logical or
   * cognitive manifest never emits them, and the CI guard proves it.
   */
  mode?: "live";
  counters?: LiveWorldCounters;
}

/** Bounded-world counters kept only in live states (see `WorldState.mode`). */
export interface LiveWorldCounters {
  tasksCreated: number;
  tasksCompleted: number;
  submissions: number;
  acceptedTasks: number;
  externalTasks: number;
}

export interface TaskObservation {
  id: string;
  family: TaskFamily;
  input: JsonValue;
  createdTick: number;
  deadlineTick: number;
  status: TaskStatus;
  claimedBy?: string;
}

export interface SubmissionObservation {
  id: string;
  taskId: string;
  agentId: string;
  result: JsonValue;
  submittedTick: number;
  task: TaskObservation;
}

export interface MessageObservation {
  id: string;
  senderId: string;
  recipientId: string;
  payload: JsonObject;
  sentTick: number;
  deliveredTick: number;
  redactedPaths: string[];
}

export interface Observation {
  tick: number;
  agentId: string;
  resources: ResourceVector;
  tasks: TaskObservation[];
  submissions: SubmissionObservation[];
  inbox: MessageObservation[];
  visibleAgents: string[];
  neighbors: string[];
  capabilities: Array<Pick<CapabilityState, "id" | "ownerId" | "inputs" | "outputs" | "tests" | "cost">>;
  physics: PhysicsState;
}

export type WorldAction =
  | { type: "observe" }
  | { type: "reason"; subject: string }
  | { type: "claimTask"; taskId: string }
  | { type: "execute"; taskId: string; result: JsonValue }
  | { type: "submit"; taskId: string; result: JsonValue }
  | { type: "verify"; submissionId: string; computedResult: JsonValue; verdict: boolean }
  | { type: "send"; targetId: string; payload: JsonObject }
  | { type: "connect"; targetId: string }
  | { type: "disconnect"; targetId: string }
  | { type: "store"; key: string; value: JsonValue }
  | { type: "retrieve"; key: string }
  | {
      type: "publishCapability";
      capability: Pick<CapabilityState, "id" | "inputs" | "outputs" | "primitivePlan" | "executionPlan" | "tests" | "cost">;
    }
  | { type: "useCapability"; capabilityId: string; input: JsonValue }
  | { type: "transfer"; targetId: string; resource: ResourceKind; amount: number }
  | { type: "reserve"; resource: ResourceKind; amount: number }
  | { type: "trade"; resource: ResourceKind; amount: number; credits: number }
  | { type: "spawn" }
  | { type: "clone" }
  | { type: "merge"; targetId: string };

export interface ActionResult {
  accepted: boolean;
  action: PrimitiveActionType;
  data: JsonObject;
  cost: ResourceVector;
  violation?: string;
}

export interface Evaluation {
  taskId: string;
  submissionId: string;
  accepted: boolean;
  qualityPpm: number;
  latencyTicks: number;
  violations: number;
}

export interface MetricsSnapshot {
  schemaVersion: typeof LAB_SCHEMA_VERSION;
  tick: number;
  tasksCreated: number;
  tasksCompleted: number;
  taskSuccessRatePpm: number;
  meanQualityPpm: number;
  p50LatencyTicks: number;
  p95LatencyTicks: number;
  creditsPerAcceptedTaskPpm: number;
  computePerAcceptedTaskPpm: number;
  bandwidthPerAcceptedTaskPpm: number;
  activeAgents: number;
  activeLinks: number;
  densityPpm: number;
  connectedComponents: number;
  degreeCentralizationPpm: number;
  resourceGiniPpm: number;
  meanSpecializationPpm: number;
  linkTurnover: number;
  violations: number;
}

export type LabEventType =
  | "run.started"
  | "agent.created"
  | "agent.retired"
  | "task.created"
  | "task.claimed"
  | "task.submitted"
  | "task.evaluated"
  | "submission.verified"
  | "task.expired"
  | "link.created"
  | "link.removed"
  | "link.used"
  | "resource.spent"
  | "resource.transferred"
  | "memory.stored"
  | "memory.retrieved"
  | "message.sent"
  | "message.delivered"
  | "capability.published"
  | "capability.used"
  | "agent.learning.updated"
  | "cognition.recorded"
  | "pressure.applied"
  | "violation.recorded"
  | "metrics.recorded"
  | "tick.completed"
  | "run.completed";

export interface LabEventDraft {
  tick: number;
  phase: TickPhase;
  type: LabEventType;
  data: JsonObject;
  actorId?: string;
  targetId?: string;
  causationId?: string;
}

export interface LabEvent extends LabEventDraft {
  schemaVersion: typeof LAB_SCHEMA_VERSION;
  runId: string;
  universeId: string;
  seq: number;
  eventId: string;
  previousHash: string;
  hash: string;
}

export type TickPhase =
  | "genesis"
  | "pressure"
  | "task_generation"
  | "observation"
  | "decision"
  | "resolution"
  | "evaluation"
  | "upkeep"
  | "metrics"
  | "checkpoint"
  | "completion";

export interface DeterministicRngCheckpoint {
  algorithm: "xoshiro256**";
  streamSeed: string;
  state: [string, string, string, string];
}

export interface TaskStreamCheckpoint {
  sequence: number;
  rng: DeterministicRngCheckpoint;
}

export interface NeutralPolicyCheckpoint {
  policyId: string;
  explorationPpm: number;
  streams: Array<{
    agentId: string;
    rng: DeterministicRngCheckpoint;
  }>;
}

export interface CheckpointRuntimeState {
  taskStream: TaskStreamCheckpoint;
  /** Null means the selected custom policy did not expose resumable state. */
  policy: NeutralPolicyCheckpoint | null;
}

export interface Checkpoint {
  schemaVersion: typeof LAB_SCHEMA_VERSION;
  runId: string;
  universeId: string;
  tick: number;
  seq: number;
  eventHash: string;
  stateHash: string;
  state: WorldState;
  /** Added compatibly: legacy checkpoints remain verifiable but are not resumable. */
  runtime?: CheckpointRuntimeState;
  runtimeHash?: string;
}

export interface RunSummary {
  schemaVersion: typeof LAB_SCHEMA_VERSION;
  runId: string;
  universeId: string;
  seed: string;
  ticks: number;
  events: number;
  finalStateHash: string;
  finalEventHash: string;
  latestMetrics: MetricsSnapshot;
}

/**
 * Deterministic final commitment for one completed evidence run.
 *
 * The commitment becomes tamper-evident only after the `commitment` value is
 * copied to an independent append-only system. It deliberately contains no
 * wall-clock time, host identity, filesystem path, credential, or signature.
 */
export interface RunEvidenceAttestation {
  format: "anu-lab-evidence-attestation";
  version: 1;
  hashAlgorithm: "sha256";
  labSchemaVersion: typeof LAB_SCHEMA_VERSION;
  subject: {
    experimentId: string;
    runId: string;
    universeId: string;
    engineVersion: string;
    policyId: string;
    taskGeneratorId: string;
  };
  scope: {
    kind: "final";
    tick: number;
    seq: number;
  };
  evidence: {
    manifestHash: string;
    configHash: string;
    eventHash: string;
    stateHash: string;
    summaryHash: string;
    metricsHash: string;
  };
  commitment: string;
}

export interface PopulationSummary {
  schemaVersion: typeof LAB_SCHEMA_VERSION;
  experimentId: string;
  baseSeed: string;
  universes: RunSummary[];
  /**
   * Multi-objective comparison of the universes. Absent on summaries written
   * before the analysis existed, so older evidence stays readable.
   */
  pareto?: ParetoAnalysis;
}

export const ZERO_RESOURCES: Readonly<ResourceVector> = Object.freeze({
  credits: 0,
  llmTokens: 0,
  computeMs: 0,
  storageBytes: 0,
  bandwidthBytes: 0,
});
