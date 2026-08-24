import type { JsonObject, JsonValue } from "../core/types.js";

export const LAB_SCHEMA_VERSION = 1 as const;
export const PPM = 1_000_000;

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

export type TaskStatus = "available" | "claimed" | "submitted" | "completed" | "expired";

export interface TaskStreamConfig {
  families: TaskFamily[];
  tasksPerTick: number;
  deadlineTicks: number;
  maxBacklog: number;
}

export type PressureSpec =
  | { tick: number; type: "resource_price_multiplier"; resource: ResourceKind; multiplierPpm: number }
  | { tick: number; type: "bandwidth_capacity_multiplier"; multiplierPpm: number }
  | { tick: number; type: "retire_agent_fraction"; fractionPpm: number }
  | { tick: number; type: "task_load_multiplier"; multiplierPpm: number };

export interface GenesisConfig {
  schemaVersion: typeof LAB_SCHEMA_VERSION;
  experimentId: "genesis-1";
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
}

export interface RunManifest {
  schemaVersion: typeof LAB_SCHEMA_VERSION;
  experimentId: string;
  engineVersion: string;
  /**
   * `logical` runs regenerate their own decision stream from the seed.
   * `cognitive` runs cannot: a model answered, so replay reads the recorded
   * answers back instead of re-deriving them.
   */
  mode: "logical" | "cognitive";
  policyId: string;
  taskGeneratorId: string;
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
}

export const ZERO_RESOURCES: Readonly<ResourceVector> = Object.freeze({
  credits: 0,
  llmTokens: 0,
  computeMs: 0,
  storageBytes: 0,
  bandwidthBytes: 0,
});
