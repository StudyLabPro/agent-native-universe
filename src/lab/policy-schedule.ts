import { compareCodeUnits } from "./canonical.js";
import { createObservationFrame, observeWorldFromFrame } from "./environment.js";
import type { NeutralPolicyRandomSource } from "./neutral-policy.js";
import type {
  LabAgentState,
  NeutralPolicyCheckpoint,
  Observation,
  WorldAction,
  WorldState,
} from "./types.js";

export interface LogicalPolicy {
  readonly id: string;
  decide(observation: Observation, agent: LabAgentState, rng: NeutralPolicyRandomSource): WorldAction[];
  /**
   * Resumable policies expose the RNG-stream state that makes their decision
   * schedule reproducible after a restart. Absent on a policy whose decisions
   * cannot be reconstructed deterministically (a baseline with fixed, not
   * random, routing) — such a policy's world checkpoint records `policy: null`
   * and the world refuses to resume it rather than guess.
   */
  checkpoint?(): NeutralPolicyCheckpoint;
  restore?(checkpoint: NeutralPolicyCheckpoint, root: NeutralPolicyRandomSource): void;
}

export interface PolicyDecision {
  actorId: string;
  localIndex: number;
  action: WorldAction;
}

export interface DeferredPolicyViolation {
  actorId: string;
  reason: string;
}

export interface PolicyDecisionBatch {
  observations: Observation[];
  decisions: PolicyDecision[];
  violations: DeferredPolicyViolation[];
}

/**
 * Derive one policy decision batch from a single immutable world snapshot.
 *
 * The live engine and authoritative replay share this function so agent order,
 * observation boundaries, policy failures, and local action indexes cannot
 * drift into two subtly different protocol implementations.
 */
export function decidePolicyTick(
  snapshot: WorldState,
  tick: number,
  policy: LogicalPolicy,
  policyRng: NeutralPolicyRandomSource,
): PolicyDecisionBatch {
  const frame = createObservationFrame(snapshot, tick);
  const agentIds = [...frame.activeAgentIds].sort(compareCodeUnits);
  const policyAgents = new Map(agentIds.map((agentId) => [
    agentId,
    deepFreeze(structuredClone(snapshot.agents[agentId]!)),
  ]));
  const observations: Observation[] = [];
  const decisions: PolicyDecision[] = [];
  const violations: DeferredPolicyViolation[] = [];

  for (const agentId of agentIds) {
    const observation = observeWorldFromFrame(frame, agentId);
    observations.push(observation);
    try {
      const actions = policy.decide(
        deepFreeze(structuredClone(observation)),
        policyAgents.get(agentId)!,
        policyRng,
      );
      for (const [localIndex, action] of actions.entries()) {
        decisions.push({ actorId: agentId, localIndex, action: structuredClone(action) });
      }
    } catch (error) {
      violations.push({
        actorId: agentId,
        reason: `policy error: ${errorMessage(error)}`,
      });
    }
  }

  return { observations, decisions, violations };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
