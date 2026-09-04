import type { JsonObject, JsonValue } from "../core/types.js";
import { compareCodeUnits } from "./canonical.js";
import { learningFamilyOf } from "./epoch-rules.js";
import { LAB_POLICY_ID } from "./manifest.js";
import {
  PPM,
  type DeterministicRngCheckpoint,
  type LabAgentState,
  type NeutralPolicyCheckpoint,
  type Observation,
  type TaskObservation,
  type WorldAction,
} from "./types.js";

export interface NeutralPolicyRandomSource {
  nextInt(maxExclusive: number): number;
  fork(label: string | number): NeutralPolicyRandomSource;
  checkpoint?(): DeterministicRngCheckpoint;
  restore?(checkpoint: DeterministicRngCheckpoint): void;
}

export interface NeutralPolicyOptions {
  explorationPpm?: number;
}

/**
 * One role-free policy shared by every agent.
 *
 * Family choice is an epsilon-greedy bandit driven only by each agent's own
 * observed learning history. The RNG is forked once per agent and retained,
 * so decisions are reproducible and independent of inter-agent call order.
 */
export class NeutralPolicy {
  readonly id = LAB_POLICY_ID;
  readonly #explorationPpm: number;
  readonly #streams = new Map<string, NeutralPolicyRandomSource>();

  constructor(options: NeutralPolicyOptions = {}) {
    const explorationPpm = options.explorationPpm ?? 150_000;
    if (!Number.isSafeInteger(explorationPpm) || explorationPpm < 0 || explorationPpm > PPM) {
      throw new Error("explorationPpm must be an integer in [0, 1,000,000]");
    }
    this.#explorationPpm = explorationPpm;
  }

  decide(
    observation: Observation,
    agent: LabAgentState,
    rng: NeutralPolicyRandomSource,
  ): WorldAction[] {
    if (observation.agentId !== agent.id) throw new Error("Observation belongs to another agent");
    if (!agent.active) return [];
    const stream = this.#stream(agent.id, rng);
    const viable = observation.tasks.filter((task) => task.deadlineTick >= observation.tick);
    const claimed = viable.filter((task) => task.status === "claimed" && task.claimedBy === agent.id);
    if (claimed.length > 0) {
      const task = chooseTask(claimed, agent, stream, this.#explorationPpm);
      const resultKey = NeutralPolicy.resultMemoryKey(task.id);
      if (Object.hasOwn(agent.memory, resultKey)) {
        return [{ type: "submit", taskId: task.id, result: structuredClone(agent.memory[resultKey]!) }];
      }
      return [{ type: "execute", taskId: task.id, result: solveTask(task) }];
    }

    const available = viable.filter((task) => task.status === "available");
    if (available.length > 0) {
      // Decentralized demand backpressure: with K visible tasks and N agents,
      // each idle agent claims with probability min(1, K/N). This avoids a
      // centrally assigned winner while preventing every agent from paying for
      // the same immutable-snapshot race. Unclaimed work naturally raises K
      // on the following tick and therefore raises willingness to claim.
      const population = observation.visibleAgents.length + 1;
      const claimPpm = Math.min(PPM, Math.floor((available.length * PPM) / population));
      if (draw(stream, PPM) < claimPpm) {
        const task = chooseTask(available, agent, stream, this.#explorationPpm);
        return [{ type: "claimTask", taskId: task.id }];
      }
    }

    const exploration = exploreTopology(observation, stream);
    return exploration ? [exploration] : [];
  }

  static resultMemoryKey(taskId: string): string {
    return `task-result:${taskId}`;
  }

  checkpoint(): NeutralPolicyCheckpoint {
    const streams = [...this.#streams.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([agentId, stream]) => {
        if (stream.checkpoint === undefined) {
          throw new Error(`Policy RNG stream ${agentId} is not checkpointable`);
        }
        return { agentId, rng: stream.checkpoint() };
      });
    return {
      policyId: this.id,
      explorationPpm: this.#explorationPpm,
      streams,
    };
  }

  restore(checkpoint: NeutralPolicyCheckpoint, root: NeutralPolicyRandomSource): void {
    if (checkpoint.policyId !== this.id || checkpoint.explorationPpm !== this.#explorationPpm) {
      throw new Error("Neutral policy checkpoint configuration mismatch");
    }
    const restored = new Map<string, NeutralPolicyRandomSource>();
    for (const entry of checkpoint.streams) {
      if (typeof entry.agentId !== "string" || entry.agentId.length === 0 || restored.has(entry.agentId)) {
        throw new Error("Neutral policy checkpoint has an invalid or duplicate agent stream");
      }
      const stream = root.fork(`neutral-policy/agent/${entry.agentId}`);
      if (stream.restore === undefined) {
        throw new Error(`Policy RNG stream ${entry.agentId} is not restorable`);
      }
      stream.restore(entry.rng);
      restored.set(entry.agentId, stream);
    }
    this.#streams.clear();
    for (const [agentId, stream] of restored) this.#streams.set(agentId, stream);
  }

  #stream(agentId: string, root: NeutralPolicyRandomSource): NeutralPolicyRandomSource {
    const existing = this.#streams.get(agentId);
    if (existing) return existing;
    const created = root.fork(`neutral-policy/agent/${agentId}`);
    this.#streams.set(agentId, created);
    return created;
  }
}

function exploreTopology(
  observation: Observation,
  stream: NeutralPolicyRandomSource,
): WorldAction | undefined {
  const connectable = observation.visibleAgents
    .filter((id) => id !== observation.agentId && !observation.neighbors.includes(id))
    .sort(compareCodeUnits);
  const neighbors = [...observation.neighbors].sort(compareCodeUnits);
  const population = observation.visibleAgents.length + 1;

  // An isolated agent actively seeks one relationship. Further expansion is
  // deliberately sparse and population-scaled, avoiding a baked-in hub or a
  // graph that mechanically saturates into a clique on long runs.
  const expansionPpm = neighbors.length === 0
    ? PPM
    : Math.max(1, Math.floor(PPM / (population * 20)));
  if (connectable.length > 0 && draw(stream, PPM) < expansionPpm) {
    return { type: "connect", targetId: connectable[draw(stream, connectable.length)]! };
  }

  // Messages are observable low-level probes, not assigned coordination
  // roles. Bandwidth pressure and finite balances make them physically costly.
  if (neighbors.length > 0 && draw(stream, PPM) < 25_000) {
    return {
      type: "send",
      targetId: neighbors[draw(stream, neighbors.length)]!,
      payload: { tick: observation.tick, signal: "available" },
    };
  }
  // The decision cycle already supplied an observation. Abstaining is a real
  // local choice and must not charge a second synthetic observe action.
  return undefined;
}

/** Deterministic cognition over public task input; it never reads evaluator oracles. */
export function solveTask(task: TaskObservation): JsonValue {
  const input = objectValue(task.input, `${task.family} input`);
  switch (task.family) {
    // Live-only recorded work. It has no hidden oracle and no closed-form
    // answer, so the deterministic solver refuses it instead of inventing one;
    // external tasks are graded by a recorded verdict (phase L3b).
    case "external":
      throw new Error("External tasks have no deterministic solution");
    case "arithmetic": {
      const left = integerValue(input.left, "arithmetic.left");
      const right = integerValue(input.right, "arithmetic.right");
      if (input.operation === "add") return left + right;
      if (input.operation === "subtract") return left - right;
      if (input.operation === "multiply") return left * right;
      throw new Error("Unknown arithmetic operation");
    }
    case "json_transform": {
      if (input.operation !== "project_values") throw new Error("Unknown JSON transform operation");
      const source = objectValue(input.source, "json_transform.source");
      const order = arrayValue(input.order, "json_transform.order").map((key) => stringValue(key, "projection key"));
      return order.map((key) => {
        if (!Object.hasOwn(source, key)) throw new Error(`Projection source has no ${key}`);
        return structuredClone(source[key]!);
      });
    }
    case "memory_recall": {
      const query = stringValue(input.query, "memory_recall.query");
      const observations = arrayValue(input.observations, "memory_recall.observations");
      for (const observation of observations) {
        const item = objectValue(observation, "memory observation");
        if (item.key === query) return structuredClone(item.value ?? null);
      }
      return null;
    }
    case "correlation": {
      const left = arrayValue(input.left, "correlation.left");
      const right = arrayValue(input.right, "correlation.right");
      if (left.length !== right.length) throw new Error("Correlation vectors have different lengths");
      return left.reduce<number>((matches, value, index) => matches + (value === right[index] ? 1 : 0), 0);
    }
    case "verification": {
      if (input.predicate !== "sum_equals") throw new Error("Unknown verification predicate");
      return integerValue(input.left, "verification.left") + integerValue(input.right, "verification.right")
        === integerValue(input.claimed, "verification.claimed");
    }
    case "multi_step": {
      let value = integerValue(input.start, "multi_step.start");
      for (const rawStep of arrayValue(input.steps, "multi_step.steps")) {
        const step = objectValue(rawStep, "multi-step operation");
        const operand = integerValue(step.value, "multi-step operand");
        if (step.operation === "add") value += operand;
        else if (step.operation === "subtract") value -= operand;
        else if (step.operation === "multiply") value *= operand;
        else throw new Error("Unknown multi-step operation");
        if (!Number.isSafeInteger(value)) throw new Error("Multi-step result exceeds safe-integer range");
      }
      return value;
    }
    case "concurrency": {
      if (input.operation !== "deterministic_schedule") throw new Error("Unknown concurrency operation");
      const jobs = arrayValue(input.jobs, "concurrency.jobs").map((rawJob) => {
        const job = objectValue(rawJob, "job");
        return {
          id: stringValue(job.id, "job.id"),
          priority: integerValue(job.priority, "job.priority"),
          duration: integerValue(job.duration, "job.duration"),
        };
      });
      return jobs
        .sort((left, right) => (
          right.priority - left.priority
          || left.duration - right.duration
          || compareCodeUnits(left.id, right.id)
        ))
        .map((job) => job.id);
    }
    case "state_recovery": {
      if (input.operation !== "replay_deltas") throw new Error("Unknown recovery operation");
      const checkpoint = objectValue(input.checkpoint, "state_recovery.checkpoint");
      const journal = arrayValue(input.journal, "state_recovery.journal").map((delta) => integerValue(delta, "journal delta"));
      const counter = journal.reduce((value, delta) => value + delta, integerValue(checkpoint.counter, "checkpoint.counter"));
      const revision = integerValue(checkpoint.revision, "checkpoint.revision") + journal.length;
      if (!Number.isSafeInteger(counter) || !Number.isSafeInteger(revision)) {
        throw new Error("Recovered state exceeds safe-integer range");
      }
      return { counter, revision };
    }
  }
}

function chooseTask(
  tasks: readonly TaskObservation[],
  agent: LabAgentState,
  rng: NeutralPolicyRandomSource,
  explorationPpm: number,
): TaskObservation {
  const ordered = [...tasks].sort((left, right) => compareCodeUnits(left.id, right.id));
  if (ordered.length === 1) return ordered[0]!;
  if (draw(rng, PPM) < explorationPpm) return ordered[draw(rng, ordered.length)]!;

  let bestScore = -1n;
  let best: TaskObservation[] = [];
  for (const task of ordered) {
    // External work is never scored by the bandit: it has no learning key.
    const family = learningFamilyOf(task.family);
    const attempts = family === undefined ? 0 : agent.learning.attempts[family] ?? 0;
    const successes = family === undefined ? 0 : agent.learning.successes[family] ?? 0;
    const learnedUtility = family === undefined ? undefined : agent.learning.utilityPpm[family];
    nonNegativeSafeInteger(attempts, "bandit attempts");
    nonNegativeSafeInteger(successes, "bandit successes");
    if (successes > attempts) throw new Error(`Successes exceed attempts for ${task.family}`);
    if (learnedUtility !== undefined) nonNegativeSafeInteger(learnedUtility, "bandit utility");
    const empirical = learnedUtility === undefined
      ? attempts === 0
        ? 0
        : Number((BigInt(successes) * BigInt(PPM)) / BigInt(attempts))
      : learnedUtility;
    const explorationBonus = Number(BigInt(PPM) / BigInt(attempts + 1));
    const score = BigInt(empirical) + BigInt(explorationBonus);
    if (score > bestScore) {
      bestScore = score;
      best = [task];
    } else if (score === bestScore) {
      best.push(task);
    }
  }
  return best[draw(rng, best.length)]!;
}

function draw(rng: NeutralPolicyRandomSource, maxExclusive: number): number {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) throw new Error("Random bound must be positive");
  const value = rng.nextInt(maxExclusive);
  if (!Number.isSafeInteger(value) || value < 0 || value >= maxExclusive) {
    throw new Error(`RNG returned ${value} outside [0, ${maxExclusive})`);
  }
  return value;
}

function nonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
}

function objectValue(value: JsonValue | undefined, label: string): JsonObject {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function arrayValue(value: JsonValue | undefined, label: string): JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function stringValue(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function integerValue(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`);
  return value;
}
