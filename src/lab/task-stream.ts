import type { JsonObject, JsonValue } from "../core/types.js";
import { compareCodeUnits, hashValue } from "./canonical.js";
import { DeterministicRng } from "./rng.js";
import type {
  DeterministicRngCheckpoint,
  LabTaskState,
  TaskFamily,
  TaskStreamCheckpoint,
  TaskStreamConfig,
} from "./types.js";

/**
 * The RNG a task stream must be driven by, derived identically by the world
 * and by the protocol verifier.
 *
 * Without a `realizationSeed` the stream forks off the run's root RNG, so the
 * realization is bound to the run identity — the historical behaviour every
 * existing run hash depends on. With one, the stream is seeded from the
 * realization seed alone, so runs that differ in policy, costs or universe id
 * face byte-identical tasks and oracles; control-arm comparisons rely on it.
 */
export function taskStreamRng(config: TaskStreamConfig, rootRng: DeterministicRng): DeterministicRng {
  if (config.realizationSeed === undefined) return rootRng.fork("tasks");
  return new DeterministicRng(hashValue({
    domain: "agent-native-universe/lab/task-realization/v1",
    realizationSeed: config.realizationSeed,
  }));
}

export interface TaskRandomSource {
  nextInt(maxExclusive: number): number;
  checkpoint?(): DeterministicRngCheckpoint;
  restore?(checkpoint: DeterministicRngCheckpoint): void;
}

export interface GeneratedTask {
  task: LabTaskState;
  /** Kept outside the task and intended to be registered with IndependentEvaluator. */
  expected: JsonValue;
}

export class DeterministicTaskStream {
  readonly #config: TaskStreamConfig;
  #sequence = 0;

  constructor(config: TaskStreamConfig, readonly rng: TaskRandomSource) {
    if (config.families.length === 0) throw new Error("Task stream requires at least one family");
    if (!Number.isSafeInteger(config.tasksPerTick) || config.tasksPerTick < 0) {
      throw new Error("tasksPerTick must be a non-negative safe integer");
    }
    positiveSafeInteger(config.deadlineTicks, "deadlineTicks");
    positiveSafeInteger(config.maxBacklog, "maxBacklog");
    this.#config = {
      ...config,
      families: [...config.families],
    };
  }

  generate(tick: number, count = this.#config.tasksPerTick): GeneratedTask[] {
    nonNegativeSafeInteger(tick, "task tick");
    nonNegativeSafeInteger(count, "task count");
    if (count > this.#config.maxBacklog) {
      throw new Error(`task count ${count} exceeds maxBacklog ${this.#config.maxBacklog}`);
    }
    const deadlineTick = safeAdd(tick, this.#config.deadlineTicks, "task deadline");
    const generated: GeneratedTask[] = [];
    for (let index = 0; index < count; index += 1) {
      const family = this.#config.families[draw(this.rng, this.#config.families.length)]!;
      const oracle = generateOracle(family, this.rng, tick);
      const sequence = this.#sequence;
      this.#sequence += 1;
      const id = `task:${String(tick).padStart(8, "0")}:${String(sequence).padStart(10, "0")}`;
      generated.push({
        task: {
          id,
          family,
          input: oracle.input,
          createdTick: tick,
          deadlineTick,
          status: "available",
        },
        expected: oracle.expected,
      });
    }
    return generated;
  }

  checkpoint(): TaskStreamCheckpoint {
    if (this.rng.checkpoint === undefined) {
      throw new Error("Task RNG does not expose deterministic checkpoint state");
    }
    return { sequence: this.#sequence, rng: this.rng.checkpoint() };
  }

  restore(checkpoint: TaskStreamCheckpoint): void {
    nonNegativeSafeInteger(checkpoint.sequence, "task checkpoint sequence");
    if (this.rng.restore === undefined) {
      throw new Error("Task RNG does not support deterministic restoration");
    }
    this.rng.restore(checkpoint.rng);
    this.#sequence = checkpoint.sequence;
  }
}

interface OracleCase {
  input: JsonValue;
  expected: JsonValue;
}

function generateOracle(family: TaskFamily, rng: TaskRandomSource, tick: number): OracleCase {
  switch (family) {
    case "arithmetic":
      return arithmeticCase(rng);
    case "json_transform":
      return jsonTransformCase(rng);
    case "memory_recall":
      return memoryRecallCase(rng);
    case "correlation":
      return correlationCase(rng);
    case "verification":
      return verificationCase(rng);
    case "multi_step":
      return multiStepCase(rng);
    case "concurrency":
      return concurrencyCase(rng);
    case "state_recovery":
      return stateRecoveryCase(rng, tick);
  }
}

function arithmeticCase(rng: TaskRandomSource): OracleCase {
  const left = signed(rng, 100);
  const right = signed(rng, 100);
  const operation = (["add", "subtract", "multiply"] as const)[draw(rng, 3)]!;
  const expected = operation === "add" ? left + right : operation === "subtract" ? left - right : left * right;
  return { input: { operation, left, right }, expected };
}

function jsonTransformCase(rng: TaskRandomSource): OracleCase {
  const source: JsonObject = {
    alpha: signed(rng, 50),
    beta: signed(rng, 50),
    gamma: signed(rng, 50),
  };
  const rotation = draw(rng, 3);
  const keys = ["alpha", "beta", "gamma"];
  const order = [...keys.slice(rotation), ...keys.slice(0, rotation)];
  const expected = order.map((key) => source[key]!);
  return { input: { operation: "project_values", source, order }, expected };
}

function memoryRecallCase(rng: TaskRandomSource): OracleCase {
  const observations = Array.from({ length: 4 }, (_, index) => ({
    key: `item-${index}`,
    value: signed(rng, 1_000),
  }));
  const queryIndex = draw(rng, observations.length);
  return {
    input: { observations, query: observations[queryIndex]!.key },
    expected: observations[queryIndex]!.value,
  };
}

function correlationCase(rng: TaskRandomSource): OracleCase {
  const left = Array.from({ length: 6 }, () => draw(rng, 10));
  const mask = Array.from({ length: left.length }, () => draw(rng, 2));
  const right = left.map((value, index) => (mask[index] === 1 ? value : draw(rng, 10)));
  const matches = left.reduce((count, value, index) => count + (value === right[index] ? 1 : 0), 0);
  return { input: { operation: "count_aligned_matches", left, right }, expected: matches };
}

function verificationCase(rng: TaskRandomSource): OracleCase {
  const left = signed(rng, 100);
  const right = signed(rng, 100);
  const trueSum = left + right;
  const claimed = draw(rng, 2) === 0 ? trueSum : trueSum + 1 + draw(rng, 5);
  return {
    input: { predicate: "sum_equals", left, right, claimed },
    expected: claimed === trueSum,
  };
}

function multiStepCase(rng: TaskRandomSource): OracleCase {
  const start = signed(rng, 20);
  const add = signed(rng, 10);
  const multiplier = 1 + draw(rng, 5);
  const subtract = signed(rng, 10);
  const steps: JsonValue[] = [
    { operation: "add", value: add },
    { operation: "multiply", value: multiplier },
    { operation: "subtract", value: subtract },
  ];
  return {
    input: { start, steps },
    expected: (start + add) * multiplier - subtract,
  };
}

function concurrencyCase(rng: TaskRandomSource): OracleCase {
  const jobs = Array.from({ length: 5 }, (_, index) => ({
    id: `job-${index}`,
    priority: draw(rng, 4),
    duration: 1 + draw(rng, 20),
  }));
  const expected = [...jobs]
    .sort((left, right) => (
      right.priority - left.priority
      || left.duration - right.duration
      || compareCodeUnits(left.id, right.id)
    ))
    .map((job) => job.id);
  return { input: { operation: "deterministic_schedule", jobs }, expected };
}

function stateRecoveryCase(rng: TaskRandomSource, tick: number): OracleCase {
  const checkpoint = {
    counter: signed(rng, 100),
    revision: tick,
  };
  const journal = Array.from({ length: 4 }, () => signed(rng, 10));
  const recovered = journal.reduce((value, delta) => value + delta, checkpoint.counter);
  return {
    input: { operation: "replay_deltas", checkpoint, journal },
    expected: { counter: recovered, revision: checkpoint.revision + journal.length },
  };
}

function draw(rng: TaskRandomSource, maxExclusive: number): number {
  positiveSafeInteger(maxExclusive, "random bound");
  const value = rng.nextInt(maxExclusive);
  if (!Number.isSafeInteger(value) || value < 0 || value >= maxExclusive) {
    throw new Error(`RNG returned ${value} outside [0, ${maxExclusive})`);
  }
  return value;
}

function signed(rng: TaskRandomSource, magnitude: number): number {
  return draw(rng, magnitude * 2 + 1) - magnitude;
}

function safeAdd(left: number, right: number, label: string): number {
  const value = BigInt(left) + BigInt(right);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds safe-integer range`);
  return Number(value);
}

function positiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
}

function nonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
}
