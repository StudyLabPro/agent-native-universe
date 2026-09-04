/**
 * The bounded world of a Genesis-Live universe (design §4.G, phase L3c).
 *
 * A universe with no end must not have a state with no end. Two mechanisms
 * bound it, and they are the same rule applied at two moments:
 *
 *  - **inside an epoch**, the upkeep of every tick commits
 *    `submission.archived`, `task.archived` and `message.archived` for the
 *    records that have settled and aged past the windows of
 *    `config.live.archive`;
 *  - **at a boundary**, `compactWorldState` applies the same windows once more
 *    to the parent's final state, and the rule it applied is recorded in
 *    `genesisFrom.compaction` — inside `configHash`, therefore inside the
 *    child's `runId`.
 *
 * Both call one implementation (`archivableRecords` in `src/lab/epoch-rules.ts`),
 * because the world and the protocol verifier must reach the same conclusion
 * and a second copy of the rule is exactly the drift the single-embodiment
 * invariant forbids. This module owns only the *choice* of rule for an epoch
 * and the validation of the caller's request.
 *
 * What archival is not: deletion. An archived record leaves the working set of
 * the live world and stays in the append-only evidence of the epoch that
 * created it, byte for byte. `verifyLiveChain` replays every epoch from
 * genesis, so the complete history of every task, submission and message is
 * always reconstructible; what is bounded is the state a running process has
 * to hold and hash, not the record of what happened.
 *
 * Known remaining growth surfaces, stated rather than hidden: retired agents
 * (with their memory) and `capabilityInvocations` are never archived. Neither
 * has a window in `config.live.archive`, so neither is bounded by this phase;
 * they grow only when agents spawn or publish and use capabilities, which the
 * archive windows deliberately do not decide for them.
 */
import type { GenesisConfig, LiveArchiveConfig, LiveCompaction } from "../types.js";

/** The identity compaction: the child inherits exactly the parent's final state. */
export const LIVE_COMPACTION_NONE: LiveCompaction = Object.freeze({ kind: "none" });

/**
 * How a universe bounds itself.
 *
 * `compaction` decides the boundary rule only; the per-tick archival is the
 * physics of the universe (`config.live.archive`) and is not optional, because
 * it is part of `configHash` and therefore of every epoch's identity.
 */
export interface LiveArchiveOptions {
  /**
   * `"windows"` (the default) compacts an inherited genesis with the
   * universe's own archive windows. `"none"` inherits the parent's final state
   * verbatim — sound, but it lets a genesis carry records the running world
   * would already have archived, so it exists for chains that must reproduce a
   * pre-L3c parent rather than as a way to run a universe indefinitely.
   */
  compaction?: "windows" | "none";
}

export function assertLiveArchiveOptions(value: unknown): LiveArchiveOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("archive must be an object of archive options");
  }
  const options = value as LiveArchiveOptions;
  if (options.compaction !== undefined && options.compaction !== "windows" && options.compaction !== "none") {
    throw new Error(`Unknown archive compaction ${String(options.compaction)}; expected windows or none`);
  }
  for (const key of Object.keys(options)) {
    if (key !== "compaction") throw new Error(`archive contains unknown field ${key}`);
  }
  return options;
}

/** The archive windows of a live universe's physics. */
export function liveArchiveConfigOf(config: GenesisConfig): LiveArchiveConfig {
  const archive = config.live?.archive;
  if (archive === undefined) throw new Error("A live universe config requires live.archive windows");
  return archive;
}

/**
 * The compaction rule an epoch of this universe records in its `genesisFrom`.
 *
 * The windows are copied into the rule rather than referenced, so an audit of
 * the chain re-derives an inherited genesis from the link and the parent's
 * replayed state alone, without having to trust that the child's config still
 * carries the windows its parent was compacted with.
 */
export function liveCompactionRule(
  config: GenesisConfig,
  options: LiveArchiveOptions | undefined,
): LiveCompaction {
  if (options?.compaction === "none") return { ...LIVE_COMPACTION_NONE };
  return { kind: "windows", archive: { ...liveArchiveConfigOf(config) } };
}
