import type { FileHandle } from "node:fs/promises";
import { hashValue } from "./canonical.js";
import { iterateEventFile, iterateEventHandle } from "./event-stream.js";
import {
  initialEventChainVerification,
  initialEventHash,
  verifyNextEvent,
} from "./events.js";
import type { PendingOracle } from "./evaluator.js";
import { assertLabManifestImplementation } from "./manifest.js";
import { LabProtocolVerifier, type LiveProjectionOptions } from "./protocol-verifier.js";
import { applyWorldEventMutable, initialWorldState } from "./reducer.js";
import type {
  CheckpointRuntimeState,
  GenesisConfig,
  LabEvent,
  RunManifest,
  WorldState,
} from "./types.js";

/**
 * Projection options. `live` is supplied only by the Genesis-Live engine and
 * is what makes a `mode: "live"` manifest projectable at all: without it the
 * manifest gate refuses live evidence exactly as it always has, so no
 * scientific reader can project a live epoch by accident.
 */
export interface ReplayProjectionOptions {
  live?: LiveProjectionOptions;
}

export interface ReplayResult {
  state: WorldState;
  digest: string;
  stateHash: string;
  finalEventHash: string;
  eventsApplied: number;
  lastSeq: number;
  lastTick: number;
  /** Present only when the projection covers the verified end of the stream. */
  runtime?: CheckpointRuntimeState;
  /**
   * Oracles still open at the verified end of the stream. Present only for a
   * recoverable (incomplete-boundary) replay — the one case a resume needs
   * them — never for a complete run or an `--until-tick` projection.
   */
  pendingOracles?: PendingOracle[];
}

/** Replay verifies the complete deterministic protocol before returning its projection. */
export class ReplayEngine {
  static replay(
    events: readonly LabEvent[],
    manifest: RunManifest,
    config: GenesisConfig,
    untilTick?: number,
    options: ReplayProjectionOptions = {},
  ): ReplayResult {
    assertLabManifestImplementation(manifest, { live: options.live !== undefined });
    validateUntilTick(untilTick);
    const protocol = new LabProtocolVerifier(manifest, config, options);
    let verification = initialEventChainVerification(manifest);
    const state = initialWorldState(manifest, options.live?.genesisState);
    let outputState: WorldState | undefined;
    let eventsApplied = 0;
    let finalEventHash = initialEventHash(manifest);
    let lastSeq = 0;

    for (const event of events) {
      verification = verifyNextEvent(event, manifest, verification);
      if (untilTick !== undefined && event.tick > untilTick && outputState === undefined) {
        outputState = structuredClone(state);
      }
      protocol.verifyNext(event, state);
      applyWorldEventMutable(state, event);
      if (untilTick === undefined || event.tick <= untilTick) {
        eventsApplied += 1;
        finalEventHash = event.hash;
        lastSeq = event.seq;
      }
    }
    protocol.finish();

    const projected = outputState ?? state;
    const digest = hashValue(projected);
    return {
      state: projected,
      digest,
      stateHash: digest,
      finalEventHash,
      eventsApplied,
      lastSeq,
      lastTick: projected.tick,
      ...(untilTick === undefined ? { runtime: protocol.checkpointRuntime() } : {}),
    };
  }

  static async replayFile(
    path: string,
    manifest: RunManifest,
    config: GenesisConfig,
    untilTick?: number,
    options: ReplayProjectionOptions = {},
  ): Promise<ReplayResult> {
    return replayEventStream(iterateEventFile(path), manifest, config, untilTick, false, options);
  }

  /** Verify a complete run or an incomplete stream ending exactly at a durable tick boundary. */
  static async replayRecoverableFile(
    path: string,
    manifest: RunManifest,
    config: GenesisConfig,
    options: ReplayProjectionOptions = {},
  ): Promise<ReplayResult> {
    return replayEventStream(iterateEventFile(path), manifest, config, undefined, true, options);
  }

  /** Replay from an fd-held evidence snapshot without resolving the pathname again. */
  static async replayHandle(
    handle: FileHandle,
    manifest: RunManifest,
    config: GenesisConfig,
    untilTick?: number,
    options: ReplayProjectionOptions = {},
  ): Promise<ReplayResult> {
    return replayEventStream(iterateEventHandle(handle), manifest, config, untilTick, false, options);
  }
}

async function replayEventStream(
  events: AsyncIterable<LabEvent>,
  manifest: RunManifest,
  config: GenesisConfig,
  untilTick?: number,
  allowIncompleteBoundary = false,
  options: ReplayProjectionOptions = {},
): Promise<ReplayResult> {
  assertLabManifestImplementation(manifest, { live: options.live !== undefined });
  validateUntilTick(untilTick);
  const protocol = new LabProtocolVerifier(manifest, config, options);
  let verification = initialEventChainVerification(manifest);
  const state = initialWorldState(manifest, options.live?.genesisState);
  let outputState: WorldState | undefined;
  let eventsApplied = 0;
  let finalEventHash = initialEventHash(manifest);
  let lastSeq = 0;

  for await (const event of events) {
    verification = verifyNextEvent(event, manifest, verification);
    if (untilTick !== undefined && event.tick > untilTick && outputState === undefined) {
      outputState = structuredClone(state);
    }
    protocol.verifyNext(event, state);
    applyWorldEventMutable(state, event);
    if (untilTick === undefined || event.tick <= untilTick) {
      eventsApplied += 1;
      finalEventHash = event.hash;
      lastSeq = event.seq;
    }
  }
  protocol.finish({ allowIncompleteBoundary });

  const projected = outputState ?? state;
  const digest = hashValue(projected);
  return {
    state: projected,
    digest,
    stateHash: digest,
    finalEventHash,
    eventsApplied,
    lastSeq,
    lastTick: projected.tick,
    ...(untilTick === undefined ? { runtime: protocol.checkpointRuntime() } : {}),
    ...(allowIncompleteBoundary ? { pendingOracles: protocol.pendingOracles() } : {}),
  };
}

export function replayEvents(
  events: readonly LabEvent[],
  manifest: RunManifest,
  config: GenesisConfig,
  untilTick?: number,
  options: ReplayProjectionOptions = {},
): ReplayResult {
  return ReplayEngine.replay(events, manifest, config, untilTick, options);
}

function validateUntilTick(untilTick: number | undefined): void {
  if (untilTick !== undefined && (!Number.isSafeInteger(untilTick) || untilTick < 0)) {
    throw new RangeError("untilTick must be a non-negative safe integer");
  }
}
