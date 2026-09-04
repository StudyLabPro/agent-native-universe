/**
 * The action rules the world and the protocol verifier must agree on, as pure
 * values.
 *
 * `epoch-rules.ts` holds every rule that differs between a bounded run and a
 * live epoch. This module holds the one rule that differs between the action
 * vocabulary the engine *prices* and the vocabulary it can actually *perform* —
 * a distinction no phase of the laboratory has ever removed, and one both sides
 * of the protocol have to reach independently:
 *
 *  - `world.ts` charges for the attempt and records the refusal;
 *  - `protocol-verifier.ts` regenerates that same refusal, so evidence cannot
 *    claim the world performed something this engine cannot do.
 *
 * Stating it once is what keeps those two conclusions from drifting.
 */
import type { PrimitiveActionType } from "./types.js";

/**
 * Actions the cost table prices but no reducer implements.
 *
 * They are part of the vocabulary on purpose: an agent may attempt one, pays
 * for the attempt, and the refusal is recorded as a violation rather than
 * silently swallowed. Implementing them (with resource conservation) is
 * background work of a later phase — see `docs/UNIVERSE_LAB.md` — and the day
 * one of them gains a reducer branch it leaves this set, at which point the
 * verifier's refusal below turns into a deterministic-outcome check.
 */
export const UNSUPPORTED_ACTIONS: ReadonlySet<PrimitiveActionType> = new Set<PrimitiveActionType>([
  "spawn", "clone", "merge", "reserve", "trade",
]);

export function isUnsupportedAction(action: PrimitiveActionType): boolean {
  return UNSUPPORTED_ACTIONS.has(action);
}

/** The exact violation reason the world records for an unsupported attempt. */
export function unsupportedActionReason(action: PrimitiveActionType): string {
  return `${action} is unsupported in logical v1`;
}
