import {
  PPM,
  type Evaluation,
  type LabTaskState,
} from "./types.js";
import type { JsonValue } from "../core/types.js";

/**
 * One task's hidden oracle, still unresolved (neither expired nor evaluated)
 * at a durable tick boundary. Flows only between in-memory objects — the
 * protocol verifier's replay-reconstructed oracle map on resume, into the
 * live evaluator that regenerates from it — and is never written to a
 * checkpoint or any other artifact on disk: the redaction contract in
 * environment.ts keeps oracles out of observations and events, and a
 * persisted oracle would defeat that the moment a checkpoint were served.
 */
export interface PendingOracle {
  taskId: string;
  expected: JsonValue;
}

/**
 * A hidden-oracle evaluator. Expected values never enter WorldState or the
 * public task observation and cannot be replaced after registration.
 */
export class IndependentEvaluator {
  readonly #oracles = new Map<string, JsonValue>();

  registerOracle(taskId: string, expected: JsonValue): void {
    if (!taskId) throw new Error("Oracle task id must not be empty");
    if (this.#oracles.has(taskId)) throw new Error(`Oracle already registered for ${taskId}`);
    this.#oracles.set(taskId, structuredClone(expected));
  }

  evaluate(
    task: LabTaskState,
    submissionId: string,
    agentId: string,
    result: JsonValue,
    tick: number,
  ): Evaluation {
    if (!submissionId) throw new Error("Submission id must not be empty");
    if (!agentId) throw new Error("Agent id must not be empty");
    if (!Number.isSafeInteger(tick) || tick < task.createdTick) {
      throw new Error("Evaluation tick must be a safe integer at or after task creation");
    }
    const expected = this.#oracles.get(task.id);
    if (expected === undefined) throw new Error(`No oracle registered for ${task.id}`);

    const accepted = equalJson(expected, result);
    return {
      taskId: task.id,
      submissionId,
      accepted,
      qualityPpm: accepted ? PPM : 0,
      latencyTicks: tick - task.createdTick,
      violations: 0,
    };
  }
}

export function equalJson(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => equalJson(value, right[index]!));
  }
  if (typeof left === "object" && typeof right === "object") {
    const leftObject = left as Record<string, JsonValue>;
    const rightObject = right as Record<string, JsonValue>;
    const leftKeys = Object.keys(leftObject).sort();
    const rightKeys = Object.keys(rightObject).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key, index) => (
      key === rightKeys[index]
      && Object.hasOwn(rightObject, key)
      && equalJson(leftObject[key]!, rightObject[key]!)
    ));
  }
  return false;
}
