/**
 * Genesis-Live identity helpers.
 *
 * This module is the only code under `src/lab/live/` in phase L0. It exists to
 * pin the identities the design fixes — experiment id, engine version, policy
 * literal, task source, universe ids and the data root — in one place, and to
 * build the manifest of a live epoch through the very same `createRunManifest`
 * the scientific track uses (single embodiment: no second manifest builder).
 *
 * Import discipline (enforced by `.github/scripts/check-live-isolation.mjs`):
 * nothing under `src/lab/live/` may import `src/core/*` runtime code,
 * `src/runtime/*` or `src/v2/*`.
 */
import {
  LAB_LIVE_ENGINE_VERSION,
  LAB_LIVE_POLICY_ID,
  LAB_LIVE_TASK_SOURCE_ID,
  createRunManifest,
} from "../manifest.js";
import {
  LAB_LIVE_CANARY_EXPERIMENT_ID,
  LAB_LIVE_EXPERIMENT_ID,
  type GenesisConfig,
  type RunManifest,
} from "../types.js";

/** Evidence root segment of the live universe: `<dataRoot>/genesis-live/`. */
export const LIVE_DATA_ROOT_SEGMENT = LAB_LIVE_EXPERIMENT_ID;
/** The single live universe. */
export const LIVE_UNIVERSE_ID = "U0001";
/** Canary universes start here and never collide with population ids U0001…U0900. */
export const LIVE_CANARY_FIRST_UNIVERSE_NUMBER = 901;

export interface LiveEpochManifestOptions {
  /** Identity of the live cognition port (tiers, prompt, gateway identity, content budget). */
  cognitionId: string;
  /** Identity of the port that grades recorded external work (phase L3b). */
  evaluatorId: string;
}

/**
 * Manifest of one Genesis-Live epoch. Epoch chaining is not a manifest field:
 * `config.live.genesisFrom` pins the parent's final hashes and is part of the
 * `configHash`, so the child's `runId` is a pure function of the parent's
 * disk state (design §4.B).
 */
export function createLiveEpochManifest(
  config: GenesisConfig,
  universeId: string,
  options: LiveEpochManifestOptions,
): RunManifest {
  if (config.experimentId !== LAB_LIVE_EXPERIMENT_ID) {
    throw new Error(`A live epoch manifest requires experiment ${LAB_LIVE_EXPERIMENT_ID}; got ${config.experimentId}`);
  }
  const manifest = createRunManifest(config, universeId, {
    mode: "live",
    policyId: LAB_LIVE_POLICY_ID,
    cognitionId: options.cognitionId,
    evaluatorId: options.evaluatorId,
  });
  if (
    manifest.engineVersion !== LAB_LIVE_ENGINE_VERSION
    || manifest.taskGeneratorId !== LAB_LIVE_TASK_SOURCE_ID
    || manifest.mode !== "live"
  ) {
    throw new Error("Live epoch manifest identity is inconsistent");
  }
  return manifest;
}

export function isLiveManifest(manifest: Pick<RunManifest, "mode" | "experimentId">): boolean {
  return manifest.mode === "live" && manifest.experimentId === LAB_LIVE_EXPERIMENT_ID;
}

/** Canary universes are numbered from U0901 so they can never be mistaken for a population member. */
export function assertCanaryUniverseId(universeId: string): void {
  const match = /^U([0-9]{4,8})$/.exec(universeId);
  if (match === null || Number(match[1]) < LIVE_CANARY_FIRST_UNIVERSE_NUMBER) {
    throw new Error(
      `Experiment ${LAB_LIVE_CANARY_EXPERIMENT_ID} uses universe ids from U${String(LIVE_CANARY_FIRST_UNIVERSE_NUMBER).padStart(4, "0")} upwards; got ${universeId}`,
    );
  }
}
