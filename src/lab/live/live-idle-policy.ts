/**
 * The live fallback policy (design §3 invariant 2; §4.C "sound resume", L2).
 *
 * `CohortPolicy` (`../cognition.ts`) applies whatever a model actually
 * answered for the tick and falls back to an inner `LogicalPolicy` for every
 * agent the model did not steer. On the scientific track that fallback is
 * `NeutralPolicy`: an unsteered cohort B/C agent gets the reproducible
 * control's answer, which is honest there — cohort evidence measures a model
 * against a control that keeps working when the model does not answer.
 *
 * A live epoch has no such control to fall back to. If an unsteered live
 * agent quietly received a code-computed "correct" answer instead, the site
 * would be showing manufactured behaviour under a "real thinking" badge —
 * exactly the dishonesty invariant 2 exists to rule out. `LiveIdlePolicy` is
 * the fallback that keeps that promise: an agent with no recorded answer for
 * the tick does nothing. Wire it in as
 * `CohortPolicy('C', new LiveIdlePolicy())`: its unsteered agents are then
 * genuinely idle, never silently automated.
 *
 * `checkpoint()`/`restore()` satisfy the exact `NeutralPolicyCheckpoint`
 * shape L2 established as the resume contract for any resumable
 * `LogicalPolicy`, with an empty RNG-stream list — there is no randomness to
 * preserve, but the shape must still be the one `CheckpointRuntimeState.policy`
 * already types, so a live epoch resumes through the identical checkpoint
 * path `CohortPolicy`/`NeutralPolicy` already use rather than a second
 * checkpoint format.
 *
 * Import discipline (enforced by `.github/scripts/check-live-isolation.mjs`):
 * nothing under `src/lab/live/` may import `src/core/*` runtime code,
 * `src/runtime/*` or `src/v2/*`.
 *
 * Not registered in `baselines.ts`'s `createLogicalPolicyById`: that same CI
 * guard forbids `src/lab/{baselines,population,pareto,genesis}.ts` from
 * reaching anything under `src/lab/live/` — even through a type-only import —
 * so adding this policy to that registry would make the guard itself fail.
 * Its identity is gated by exactly the mechanism L0 built for it instead
 * (`LAB_LIVE_POLICY_ID`/`LAB_LIVE_POLICY_PATTERN` in `manifest.ts`, already
 * enforced unconditionally by `createRunManifest` and
 * `assertLabManifestImplementation` — a live manifest requires this policy id
 * and every other manifest forbids it); `createLiveIdlePolicy` below repeats
 * that same check at the point of construction, so a caller cannot build one
 * for a non-live run even before a manifest is assembled. L3, which builds
 * the live epoch loop, should call `createLiveIdlePolicy("live")` (or
 * `new LiveIdlePolicy()` directly — both are equally safe once a manifest has
 * already been validated) from a file that is itself allowed to import
 * `src/lab/live/*` (i.e. not `baselines.ts` or `genesis.ts` as currently
 * written); see the phase report for the exact wiring this leaves open.
 */
import { LAB_LIVE_POLICY_ID, LAB_LIVE_POLICY_PATTERN } from "../manifest.js";
import type { NeutralPolicyRandomSource } from "../neutral-policy.js";
import type { LogicalPolicy } from "../policy-schedule.js";
import type {
  LabAgentState,
  LabRunMode,
  NeutralPolicyCheckpoint,
  Observation,
  WorldAction,
} from "../types.js";

/**
 * Never falls through to a computed answer: `decide()` is unconditionally
 * `[]`. This is the `CohortPolicy` fallback for live epochs, so returning
 * anything else here would be exactly the code-solved-answer leak invariant 2
 * forbids.
 */
export class LiveIdlePolicy implements LogicalPolicy {
  readonly id: string = LAB_LIVE_POLICY_ID;

  decide(_observation: Observation, _agent: LabAgentState, _rng: NeutralPolicyRandomSource): WorldAction[] {
    return [];
  }

  /**
   * Trivial but conformant: same shape `NeutralPolicy` produces, with no RNG
   * streams because there is nothing stochastic to resume.
   */
  checkpoint(): NeutralPolicyCheckpoint {
    return { policyId: this.id, explorationPpm: 0, streams: [] };
  }

  restore(checkpoint: NeutralPolicyCheckpoint, _root: NeutralPolicyRandomSource): void {
    if (checkpoint.policyId !== this.id) {
      throw new Error(`Live idle policy checkpoint belongs to ${checkpoint.policyId}, not ${this.id}`);
    }
    if (checkpoint.streams.length > 0) {
      throw new Error("Live idle policy checkpoint must not carry RNG streams");
    }
  }
}

/**
 * The single allowed construction path. `LiveIdlePolicy` could be `new`ed
 * directly by anything that already validated its manifest, but every other
 * live identity in this codebase is gated at the point of construction
 * (`createRunManifest`, `assertLabManifestImplementation`) rather than left to
 * be caught only once a manifest exists — this mirrors that pattern instead
 * of inventing a parallel one.
 */
export function createLiveIdlePolicy(mode: LabRunMode): LiveIdlePolicy {
  if (mode !== "live") {
    throw new Error(`${LAB_LIVE_POLICY_ID} is reserved for mode live; got ${mode}`);
  }
  return new LiveIdlePolicy();
}

/** `true` for exactly the one policy id a live manifest may carry. */
export function isLiveIdlePolicyId(policyId: string): boolean {
  return LAB_LIVE_POLICY_PATTERN.test(policyId);
}
