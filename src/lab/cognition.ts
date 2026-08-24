/**
 * Cognition cohorts for the Universe Lab.
 *
 * The logical engine decides synchronously and reproducibly: given a seed, the
 * neutral policy regenerates its own decision stream, which is what makes exact
 * replay and protocol verification possible. A language model cannot be
 * regenerated that way — asking it twice is not guaranteed to return the same
 * answer, and re-running inference during replay would make evidence depend on
 * a remote service.
 *
 * So cognition is split in two phases:
 *
 *   1. asynchronously, before the decision phase, a {@link CognitionPort} is
 *      consulted and every answer is committed verbatim as an event;
 *   2. synchronously, {@link CohortPolicy} consumes those recorded answers.
 *
 * Replay never calls a model. It feeds the recorded answers back through the
 * same synchronous path, so the consequences of an inference are reproducible
 * even though the inference itself is not.
 *
 * Cohorts exist so that emergence can be attributed. If self-organization only
 * appears under one expensive model, that is a property of the model, not of
 * the substrate — which is precisely what a single-cohort experiment cannot
 * distinguish.
 */

import type { NeutralPolicy } from "./neutral-policy.js";
import type { NeutralPolicyRandomSource } from "./neutral-policy.js";
import type { LogicalPolicy } from "./policy-schedule.js";
import type { JsonObject, JsonValue } from "../core/types.js";
import type {
  LabAgentState,
  Observation,
  ResourceKind,
  WorldAction,
} from "./types.js";

/**
 * A — deterministic neutral policy, no model in the loop. The control arm.
 * B — a local model.
 * C — an external model.
 */
export type CohortId = "A" | "B" | "C";

export const COHORT_IDS: readonly CohortId[] = ["A", "B", "C"];

export interface CognitionUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface CognitionRequest {
  tick: number;
  agentId: string;
  observation: Observation;
  agent: LabAgentState;
}

/**
 * One consultation, recorded in full. This is the replay input: everything the
 * synchronous phase needs is here, so a replay never has to ask a model again.
 */
export interface CognitionRecord {
  tick: number;
  agentId: string;
  cohort: CohortId;
  provider: string;
  model: string;
  /** The provider's answer, verbatim and unparsed. */
  content: string;
  usage: CognitionUsage;
  latencyMs: number;
  /** Actions that survived validation. Empty when the answer was unusable. */
  actions: WorldAction[];
  /** Why the answer was discarded, when it was. */
  rejected?: string;
}

export interface CognitionPort {
  readonly id: string;
  readonly cohort: CohortId;
  /**
   * Consulted once per tick with every active agent. Returning fewer records
   * than requests is allowed: agents without a record fall back to the neutral
   * policy, so a model outage degrades the run instead of freezing it.
   */
  propose(requests: readonly CognitionRequest[], signal?: AbortSignal): Promise<CognitionRecord[]>;
}

/** Minimal completion surface, structurally compatible with `LlmCompletionPort`. */
export interface CompletionLike {
  complete(
    request: {
      messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
      temperature?: number;
      maxTokens?: number;
      responseFormat?: "text" | "json";
      metadata?: JsonObject;
    },
    policy?: { require?: string[]; prefer?: string[]; maxEstimatedCost?: number },
    signal?: AbortSignal,
  ): Promise<{
    provider: string;
    model: string;
    content: string;
    usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    latencyMs: number;
  }>;
}

/* ------------------------------------------------------------------ */
/* Cohort A — the control arm                                          */
/* ------------------------------------------------------------------ */

/**
 * Consults nothing. Every agent falls through to the neutral policy, so a
 * cohort A run is byte-identical to a run of the logical engine.
 */
export class NeutralCognition implements CognitionPort {
  readonly id = "cognition-neutral-v1";
  readonly cohort: CohortId = "A";

  async propose(): Promise<CognitionRecord[]> {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Cohorts B and C — a model in the loop                               */
/* ------------------------------------------------------------------ */

export interface LlmCognitionOptions {
  cohort: Exclude<CohortId, "A">;
  completion: CompletionLike;
  /** Agents consulted per tick, lowest id first. Keeps a large run affordable. */
  agentsPerTick?: number;
  maxTokens?: number;
  /** Consultations issued at once. */
  concurrency?: number;
  timeoutMs?: number;
}

export class LlmCognition implements CognitionPort {
  readonly id: string;
  readonly cohort: Exclude<CohortId, "A">;
  readonly #completion: CompletionLike;
  readonly #agentsPerTick: number;
  readonly #maxTokens: number;
  readonly #concurrency: number;
  readonly #timeoutMs: number;

  constructor(options: LlmCognitionOptions) {
    this.cohort = options.cohort;
    this.id = `cognition-llm-${options.cohort.toLowerCase()}-v1`;
    this.#completion = options.completion;
    this.#agentsPerTick = requirePositive(options.agentsPerTick ?? 4, "agentsPerTick");
    this.#maxTokens = requirePositive(options.maxTokens ?? 2_048, "maxTokens");
    this.#concurrency = requirePositive(options.concurrency ?? 4, "concurrency");
    this.#timeoutMs = requirePositive(options.timeoutMs ?? 120_000, "timeoutMs");
  }

  async propose(requests: readonly CognitionRequest[], signal?: AbortSignal): Promise<CognitionRecord[]> {
    // Deterministic selection: which agents get consulted must not depend on
    // the order the caller happened to build the list in.
    const ordered = [...requests].sort((left, right) => compare(left.agentId, right.agentId));
    const selected = ordered.slice(0, this.#agentsPerTick);
    const records: CognitionRecord[] = [];
    for (let index = 0; index < selected.length; index += this.#concurrency) {
      const slice = selected.slice(index, index + this.#concurrency);
      const settled = await Promise.all(slice.map((request) => this.#consult(request, signal)));
      for (const record of settled) if (record) records.push(record);
    }
    // Stable output order keeps the event stream comparable across runs.
    return records.sort((left, right) => compare(left.agentId, right.agentId));
  }

  async #consult(request: CognitionRequest, signal?: AbortSignal): Promise<CognitionRecord | undefined> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.#completion.complete(
        {
          messages: [
            { role: "system", content: COGNITION_SYSTEM_PROMPT },
            { role: "user", content: JSON.stringify(cognitionContext(request)) },
          ],
          responseFormat: "json",
          maxTokens: this.#maxTokens,
          temperature: 0,
          metadata: { purpose: "universe-lab-cognition", cohort: this.cohort },
        },
        { require: ["chat", "json"] },
        combined,
      );
      const parsed = parseCognitiveActions(response.content, request);
      return {
        tick: request.tick,
        agentId: request.agentId,
        cohort: this.cohort,
        provider: response.provider,
        model: response.model,
        content: response.content,
        usage: response.usage,
        latencyMs: response.latencyMs,
        actions: parsed.actions,
        ...(parsed.rejected === undefined ? {} : { rejected: parsed.rejected }),
      };
    } catch (error) {
      // A provider failure is evidence, not a crash: record it and let the
      // agent fall back to the neutral policy for this tick.
      return {
        tick: request.tick,
        agentId: request.agentId,
        cohort: this.cohort,
        provider: "unavailable",
        model: "unavailable",
        content: "",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        latencyMs: 0,
        actions: [],
        rejected: `provider failure: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
      };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Replay                                                              */
/* ------------------------------------------------------------------ */

/** Serves cognition already on record. Never contacts a provider. */
export class RecordedCognition implements CognitionPort {
  readonly id = "cognition-recorded-v1";
  readonly cohort: CohortId;
  readonly #byTick = new Map<number, CognitionRecord[]>();

  constructor(cohort: CohortId, records: readonly CognitionRecord[]) {
    this.cohort = cohort;
    for (const record of records) {
      const bucket = this.#byTick.get(record.tick);
      if (bucket) bucket.push(record);
      else this.#byTick.set(record.tick, [record]);
    }
  }

  async propose(requests: readonly CognitionRequest[]): Promise<CognitionRecord[]> {
    const tick = requests[0]?.tick;
    if (tick === undefined) return [];
    const present = new Set(requests.map((request) => request.agentId));
    return (this.#byTick.get(tick) ?? []).filter((record) => present.has(record.agentId));
  }
}

/* ------------------------------------------------------------------ */
/* The synchronous half                                                */
/* ------------------------------------------------------------------ */

/**
 * Applies recorded cognition where it exists and defers to the neutral policy
 * everywhere else. The fallback is what keeps a cohort comparable to its
 * control: an agent the model ignored still behaves, rather than stalling.
 */
export class CohortPolicy implements LogicalPolicy {
  readonly id: string;
  readonly #fallback: NeutralPolicy;
  #current = new Map<string, WorldAction[]>();

  constructor(cohort: CohortId, fallback: NeutralPolicy) {
    this.id = `cohort-${cohort.toLowerCase()}-${fallback.id}`;
    this.#fallback = fallback;
  }

  /** Installs the records for the tick that is about to be decided. */
  load(records: readonly CognitionRecord[]): void {
    this.#current = new Map();
    for (const record of records) {
      if (record.actions.length > 0) this.#current.set(record.agentId, record.actions);
    }
  }

  decide(
    observation: Observation,
    agent: LabAgentState,
    rng: NeutralPolicyRandomSource,
  ): WorldAction[] {
    const recorded = this.#current.get(agent.id);
    if (recorded === undefined) return this.#fallback.decide(observation, agent, rng);
    // Clone: the world must never hand a policy's own array to the reducer.
    return structuredClone(recorded);
  }
}

/* ------------------------------------------------------------------ */
/* Prompt and validation                                               */
/* ------------------------------------------------------------------ */

/**
 * Deliberately role-neutral. It names primitives and nothing else: no
 * developer, manager, validator, router or service vocabulary, so that any
 * division of labour the population reaches is its own and not a echo of the
 * words we handed it.
 */
export const COGNITION_SYSTEM_PROMPT = [
  "You are the decision process of one bounded agent in a resource-limited world.",
  "You see only your own observation and your own state. Other agents are pursuing the same objective with the same primitives.",
  "Return one valid JSON object only, of the form {\"actions\":[...]} with at most 4 actions.",
  "Every action must be one of these exact shapes:",
  '{"type":"observe"}',
  '{"type":"reason","subject":string}',
  '{"type":"claimTask","taskId":string}',
  '{"type":"execute","taskId":string,"result":any}',
  '{"type":"submit","taskId":string,"result":any}',
  '{"type":"verify","submissionId":string,"computedResult":any,"verdict":boolean}',
  '{"type":"send","targetId":string,"payload":object}',
  '{"type":"connect","targetId":string}',
  '{"type":"disconnect","targetId":string}',
  '{"type":"store","key":string,"value":any}',
  '{"type":"retrieve","key":string}',
  '{"type":"useCapability","capabilityId":string,"input":any}',
  '{"type":"transfer","targetId":string,"resource":string,"amount":integer}',
  '{"type":"reserve","resource":string,"amount":integer}',
  '{"type":"trade","resource":string,"amount":integer,"credits":integer}',
  '{"type":"spawn"} {"type":"clone"} {"type":"merge","targetId":string}',
  "Every action costs resources. Acting without means ends you.",
  "Do not invent action types. Do not claim a task was solved correctly; only an external evaluator decides that.",
].join("\n");

const RESOURCE_KINDS = new Set<string>([
  "credits",
  "llm_tokens",
  "compute_ms",
  "storage_bytes",
  "bandwidth_bytes",
]);

/** Actions a model is allowed to request. `publishCapability` is excluded: its
 * payload is a program, and accepting one from free-form text would let a model
 * write directly into the capability registry. */
const MAX_ACTIONS_PER_TICK = 4;

export interface ParsedCognition {
  actions: WorldAction[];
  rejected?: string;
}

/**
 * Strictly validates a model answer into world actions.
 *
 * Anything unrecognized is discarded rather than repaired: a silently coerced
 * action would make the evidence describe something the model never asked for.
 */
export function parseCognitiveActions(content: string, request: CognitionRequest): ParsedCognition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { actions: [], rejected: "answer was not valid JSON" };
  }
  if (!isObject(parsed)) return { actions: [], rejected: "answer was not a JSON object" };
  const raw = (parsed as JsonObject).actions;
  if (!Array.isArray(raw)) return { actions: [], rejected: "answer had no actions array" };

  const actions: WorldAction[] = [];
  const problems: string[] = [];
  for (const candidate of raw.slice(0, MAX_ACTIONS_PER_TICK)) {
    const action = validateAction(candidate, request);
    if (typeof action === "string") problems.push(action);
    else actions.push(action);
  }
  if (actions.length === 0) {
    return { actions: [], rejected: problems[0] ?? "answer contained no usable action" };
  }
  return problems.length === 0 ? { actions } : { actions, rejected: problems.join("; ").slice(0, 300) };
}

function validateAction(candidate: unknown, request: CognitionRequest): WorldAction | string {
  if (!isObject(candidate)) return "action was not an object";
  const type = candidate.type;
  if (typeof type !== "string") return "action had no string type";
  switch (type) {
    case "observe":
    case "spawn":
    case "clone":
      return { type } as WorldAction;
    case "reason": {
      const subject = str(candidate.subject);
      return subject === undefined ? "reason requires a subject" : { type: "reason", subject };
    }
    case "claimTask": {
      const taskId = str(candidate.taskId);
      return taskId === undefined ? "claimTask requires a taskId" : { type: "claimTask", taskId };
    }
    case "execute":
    case "submit": {
      const taskId = str(candidate.taskId);
      if (taskId === undefined) return `${type} requires a taskId`;
      if (!("result" in candidate)) return `${type} requires a result`;
      return { type, taskId, result: candidate.result as JsonValue };
    }
    case "verify": {
      const submissionId = str(candidate.submissionId);
      if (submissionId === undefined) return "verify requires a submissionId";
      if (typeof candidate.verdict !== "boolean") return "verify requires a boolean verdict";
      if (!("computedResult" in candidate)) return "verify requires a computedResult";
      return {
        type: "verify",
        submissionId,
        computedResult: candidate.computedResult as JsonValue,
        verdict: candidate.verdict,
      };
    }
    case "send": {
      const targetId = peer(candidate.targetId, request);
      if (targetId === undefined) return "send requires a known targetId";
      if (!isObject(candidate.payload)) return "send requires an object payload";
      return { type: "send", targetId, payload: candidate.payload as JsonObject };
    }
    case "connect":
    case "disconnect": {
      const targetId = peer(candidate.targetId, request);
      return targetId === undefined ? `${type} requires a known targetId` : { type, targetId };
    }
    case "merge": {
      const targetId = peer(candidate.targetId, request);
      return targetId === undefined ? "merge requires a known targetId" : { type: "merge", targetId };
    }
    case "store": {
      const key = str(candidate.key);
      if (key === undefined) return "store requires a key";
      if (!("value" in candidate)) return "store requires a value";
      return { type: "store", key, value: candidate.value as JsonValue };
    }
    case "retrieve": {
      const key = str(candidate.key);
      return key === undefined ? "retrieve requires a key" : { type: "retrieve", key };
    }
    case "useCapability": {
      const capabilityId = str(candidate.capabilityId);
      if (capabilityId === undefined) return "useCapability requires a capabilityId";
      if (!("input" in candidate)) return "useCapability requires an input";
      return { type: "useCapability", capabilityId, input: candidate.input as JsonValue };
    }
    case "reserve": {
      const resource = resourceKind(candidate.resource);
      const amount = count(candidate.amount);
      if (resource === undefined) return "reserve requires a known resource";
      return amount === undefined ? "reserve requires a positive integer amount" : { type: "reserve", resource, amount };
    }
    case "transfer": {
      const targetId = peer(candidate.targetId, request);
      const resource = resourceKind(candidate.resource);
      const amount = count(candidate.amount);
      if (targetId === undefined) return "transfer requires a known targetId";
      if (resource === undefined) return "transfer requires a known resource";
      return amount === undefined
        ? "transfer requires a positive integer amount"
        : { type: "transfer", targetId, resource, amount };
    }
    case "trade": {
      const resource = resourceKind(candidate.resource);
      const amount = count(candidate.amount);
      const credits = count(candidate.credits);
      if (resource === undefined) return "trade requires a known resource";
      if (amount === undefined) return "trade requires a positive integer amount";
      return credits === undefined ? "trade requires positive integer credits" : { type: "trade", resource, amount, credits };
    }
    case "publishCapability":
      return "publishCapability may not be requested through free-form cognition";
    default:
      return `unknown action type ${type.slice(0, 40)}`;
  }
}

/** The slice of the world a model is allowed to reason over. */
function cognitionContext(request: CognitionRequest): JsonObject {
  const { observation, agent } = request;
  return {
    tick: request.tick,
    agentId: request.agentId,
    resources: agent.resources as unknown as JsonValue,
    memoryKeys: Object.keys(agent.memory).slice(0, 32),
    observation: observation as unknown as JsonValue,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function resourceKind(value: unknown): ResourceKind | undefined {
  return typeof value === "string" && RESOURCE_KINDS.has(value) ? (value as ResourceKind) : undefined;
}

/**
 * A target must be someone the agent can actually see. Without this a model
 * could name an agent it merely imagined and quietly widen the graph.
 */
function peer(value: unknown, request: CognitionRequest): string | undefined {
  const id = str(value);
  if (id === undefined || id === request.agentId) return undefined;
  const visible = request.observation.visibleAgents;
  if (!Array.isArray(visible)) return undefined;
  return visible.includes(id) ? id : undefined;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requirePositive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
