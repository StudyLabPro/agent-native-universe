/**
 * The live epoch rules, as pure functions.
 *
 * Genesis-Live is the fourth identity of this engine, not a second runtime:
 * the world (`world.ts`) and the protocol verifier (`protocol-verifier.ts`)
 * must reach the same conclusions from the same inputs, so every rule that
 * differs between a bounded logical run and a live epoch lives here once and
 * is called from both. A rule duplicated in two places is exactly the drift
 * the design refuses.
 *
 * This module deliberately sits in `src/lab/` and not in `src/lab/live/`: the
 * verifier is reachable from `genesis.ts`, and the science guard forbids the
 * scientific instruments from reaching anything under `src/lab/live/`.
 */
import { compareCodeUnits } from "./canonical.js";
import type {
  GenesisConfig,
  LiveCompaction,
  LiveGenesisFrom,
  LiveInheritedGenesis,
  LiveTaskFamily,
  RunManifest,
  WorldState,
} from "./types.js";

/** True for a manifest whose evidence is a Genesis-Live epoch. */
export function isLiveMode(manifest: Pick<RunManifest, "mode">): boolean {
  return manifest.mode === "live";
}

/** The parent epoch this one continues, or `undefined` for epoch 0. */
export function liveGenesisFrom(
  manifest: Pick<RunManifest, "mode">,
  config: GenesisConfig,
): LiveGenesisFrom | undefined {
  return isLiveMode(manifest) ? config.live?.genesisFrom : undefined;
}

/**
 * Absolute tick of a run's genesis: `0` for every bounded run and for live
 * epoch 0, the parent's final tick for an inherited epoch. Ticks never restart
 * across a live chain, so deadlines, latencies and the reducer's monotonic
 * time rule keep working across the boundary.
 */
export function genesisTickOf(manifest: Pick<RunManifest, "mode">, config: GenesisConfig): number {
  return liveGenesisFrom(manifest, config)?.tick ?? 0;
}

/** The `inherited` block of an inherited epoch's `run.started`. */
export function inheritedGenesisOf(genesisFrom: LiveGenesisFrom): LiveInheritedGenesis {
  return {
    parentRunId: genesisFrom.runId,
    parentEventHash: genesisFrom.eventHash,
    parentStateHash: genesisFrom.stateHash,
    genesisStateHash: genesisFrom.genesisStateHash,
    startTick: genesisFrom.tick,
  };
}

/**
 * How many calibration tasks a tick may generate.
 *
 * A calibration task carries a hidden oracle that exists only in the running
 * evaluator's memory, so it must never be open when the epoch ends. Generation
 * therefore stops `deadlineTicks + 1` ticks before the final tick: the last
 * task generated still expires by deadline *inside* the epoch. The final
 * upkeep sweeps whatever is somehow still open
 * (`task.expired{reason:"epoch_boundary"}`).
 *
 * Outside live mode this is the identity function, so the scientific track
 * generates exactly what it always did.
 */
export function calibrationTaskCount(
  manifest: Pick<RunManifest, "mode">,
  config: GenesisConfig,
  tick: number,
  count: number,
): number {
  if (!isLiveMode(manifest)) return count;
  return tick > lastCalibrationTick(config) ? 0 : count;
}

/** The last tick of a live epoch on which a calibration task may be created. */
export function lastCalibrationTick(config: GenesisConfig): number {
  return config.ticks - config.taskStream.deadlineTicks - 1;
}

/**
 * Ids of the tasks the final upkeep of a live epoch expires, in id order.
 * External tasks (phase L3b) have no oracle and are left to cross the
 * boundary; everything else that is still available or claimed is closed.
 */
export function epochBoundaryExpiries(
  manifest: Pick<RunManifest, "mode">,
  config: GenesisConfig,
  tick: number,
  state: WorldState,
): string[] {
  if (!isLiveMode(manifest) || tick !== config.ticks) return [];
  return Object.values(state.tasks)
    .filter((task) => (
      (task.status === "available" || task.status === "claimed")
      && (task.family as LiveTaskFamily) !== "external"
    ))
    .map((task) => task.id)
    .sort(compareCodeUnits);
}

/**
 * Derive the genesis state of epoch `k+1` from the final state of epoch `k`.
 *
 * The rule is part of `config.live.genesisFrom.compaction`, so it is inside
 * `configHash` and therefore inside the child's `runId`: a child can never
 * inherit a differently-derived world than its identity claims. `none` is the
 * identity rule this build implements; bounded-world compaction (archive
 * windows, phase L3c) adds further kinds and is refused fail-closed until it
 * exists, rather than silently degrading to `none`.
 */
export function compactWorldState(state: WorldState, rule: LiveCompaction): WorldState {
  if (rule.kind !== "none") {
    throw new Error(`Unsupported live compaction rule ${String((rule as { kind: string }).kind)}`);
  }
  return structuredClone(state);
}
