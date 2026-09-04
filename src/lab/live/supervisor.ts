/**
 * The Genesis-Live supervisor (design §4.H, phase L3c).
 *
 * An open-ended universe runs unattended, and two failures make unattended
 * running dangerous rather than merely unproductive:
 *
 *  - **a provider outage.** Every consultation comes back `unavailable`, every
 *    agent idles through `LiveIdlePolicy`, and an epoch whose ticks are
 *    normally paced by real consultations runs at the speed of a replay
 *    instead. Tasks expire en masse, epochs, chain links and anchors pile up,
 *    and the universe burns through its history producing evidence of nothing.
 *    The outage guard stops the clock instead.
 *  - **a full disk.** Evidence is append-only; a write that fails halfway is
 *    the one thing this engine's durability story cannot repair cheaply. The
 *    disk guard stops before the last free bytes are spent, not after.
 *
 * ## Where the supervisor's observations sit relative to the world's evidence
 *
 * This is the phase's one real tension: the guards must observe things the
 * world may never observe — real free bytes, real provider health, real
 * elapsed milliseconds — and nothing non-deterministic may enter the chain.
 *
 * The boundary is drawn so that the supervisor's observations decide **when
 * the world is allowed to advance, and nothing else**:
 *
 *  - The supervisor never commits an event, never touches a checkpoint and is
 *    never consulted by the reducer, the world or the protocol verifier. It is
 *    not a recorded input; nothing it sees is written anywhere in the chain.
 *  - Its only actuator is the run's `AbortSignal`, and `LogicalUniverse.run`
 *    honours an abort by *finishing the current tick* and checkpointing at the
 *    tick boundary. A pause therefore never happens mid-tick.
 *  - It evaluates its guards **after** the tick's consultations have already
 *    resolved (it wraps `CognitionPort.propose` and decides on the way out),
 *    so the abort cannot withdraw an in-flight consultation and cannot change
 *    what the tick recorded. A paused-and-resumed epoch produces byte-identical
 *    evidence to an epoch that was never paused — which is a test, not a claim.
 *  - A pause commits nothing at all: no `task.expired`, no `tick.completed`,
 *    no `metrics.recorded`. Ticks are the world's only clock, and a paused
 *    world has no clock running.
 *
 * The inverse also holds: nothing in the chain tells you a pause happened.
 * That is deliberate. A pause is an operational fact about a process, and
 * operational facts belong in observability (`docs/GENESIS_LIVE.md` §K) — the
 * design's "no wall clock in evidence" rule, applied to the supervisor itself.
 *
 * Import discipline: nothing under `src/lab/live/` may import `src/core/*`
 * runtime code, `src/runtime/*` or `src/v2/*`.
 */
import { statfs } from "node:fs/promises";
import type { CognitionPort, CognitionRecord, CognitionRequest } from "../cognition.js";

/** Why the universe is paused. Operational state; never evidence. */
export type LivePauseReason = "provider_outage" | "low_disk";

export interface LivePause {
  reason: LivePauseReason;
  /** Human-readable detail for the log line and the operator's alert. */
  detail: string;
  /** Absolute tick the pause was decided on, when it was decided inside a tick. */
  tick?: number;
}

/**
 * The observations the guards make. Every one is injectable, because a guard
 * that can only be exercised by filling a real disk or breaking a real
 * provider is a guard nobody tests.
 */
export interface LiveSupervisorObservations {
  /** Free bytes available to the evidence root. Defaults to `statfs`. */
  freeBytes?(path: string): Promise<number>;
  /**
   * Is thinking possible again? Typically the gateway's `/readyz`. Absent, a
   * provider outage is waited out by time alone.
   */
  probe?(signal?: AbortSignal): Promise<boolean>;
  /** Wait between probes. Defaults to a real timer. */
  wait?(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface LiveSupervisorOptions extends LiveSupervisorObservations {
  /**
   * Consecutive ticks in which every consultation failed (or every agent was
   * too poor to be consulted) before the universe pauses. `0` disables the
   * outage guard.
   */
  outageTicks?: number;
  /**
   * Free bytes below which the universe pauses. `0` disables the disk guard.
   */
  minFreeBytes?: number;
  /** Milliseconds between recovery probes. */
  probeIntervalMs?: number;
  /** How many probe rounds a pause may last before the supervisor gives up. */
  maxProbeRounds?: number;
  onPause?(pause: LivePause): void | Promise<void>;
  onResume?(pause: LivePause): void | Promise<void>;
}

export const LIVE_DEFAULT_OUTAGE_TICKS = 3;
export const LIVE_DEFAULT_PROBE_INTERVAL_MS = 30_000;
/** 20 GiB, the design's floor for an evidence volume. */
export const LIVE_DEFAULT_MIN_FREE_BYTES = 20 * 1024 * 1024 * 1024;

export class LiveSupervisorGaveUpError extends Error {
  readonly pause: LivePause;

  constructor(pause: LivePause, rounds: number) {
    super(`Genesis-Live stayed paused (${pause.reason}: ${pause.detail}) after ${rounds} recovery probes`);
    this.name = "LiveSupervisorGaveUpError";
    this.pause = pause;
  }
}

function assertNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

export function assertLiveSupervisorOptions(value: unknown): LiveSupervisorOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("supervisor must be an object of supervisor options");
  }
  const options = value as LiveSupervisorOptions;
  if (options.outageTicks !== undefined) assertNonNegativeInteger(options.outageTicks, "supervisor.outageTicks");
  if (options.minFreeBytes !== undefined) assertNonNegativeInteger(options.minFreeBytes, "supervisor.minFreeBytes");
  if (options.probeIntervalMs !== undefined) {
    assertPositiveInteger(options.probeIntervalMs, "supervisor.probeIntervalMs");
  }
  if (options.maxProbeRounds !== undefined) assertPositiveInteger(options.maxProbeRounds, "supervisor.maxProbeRounds");
  for (const key of Object.keys(options)) {
    if (![
      "outageTicks", "minFreeBytes", "probeIntervalMs", "maxProbeRounds",
      "freeBytes", "probe", "wait", "onPause", "onResume",
    ].includes(key)) {
      throw new Error(`supervisor contains unknown field ${key}`);
    }
  }
  return options;
}

async function defaultFreeBytes(path: string): Promise<number> {
  const stats = await statfs(path);
  const free = BigInt(stats.bavail) * BigInt(stats.bsize);
  return free > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(free);
}

function defaultWait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Drives one live universe's guards.
 *
 * One supervisor instance belongs to one universe and survives across epochs,
 * because the outage clock is a property of the provider, not of an epoch.
 */
export class LiveSupervisor {
  readonly #options: LiveSupervisorOptions;
  readonly #dataRoot: string;
  readonly #outageTicks: number;
  readonly #minFreeBytes: number;
  readonly #probeIntervalMs: number;
  readonly #maxProbeRounds: number;
  readonly #freeBytes: (path: string) => Promise<number>;
  readonly #wait: (ms: number, signal?: AbortSignal) => Promise<void>;

  #failingTicks = 0;
  #tripped: LivePause | undefined;
  #controller: AbortController | undefined;
  #forwardParentAbort: (() => void) | undefined;
  #parent: AbortSignal | undefined;

  constructor(dataRoot: string, options: LiveSupervisorOptions = {}) {
    this.#dataRoot = dataRoot;
    this.#options = assertLiveSupervisorOptions(options);
    this.#outageTicks = options.outageTicks ?? LIVE_DEFAULT_OUTAGE_TICKS;
    this.#minFreeBytes = options.minFreeBytes ?? 0;
    this.#probeIntervalMs = options.probeIntervalMs ?? LIVE_DEFAULT_PROBE_INTERVAL_MS;
    this.#maxProbeRounds = options.maxProbeRounds ?? Number.MAX_SAFE_INTEGER;
    this.#freeBytes = options.freeBytes ?? defaultFreeBytes;
    this.#wait = options.wait ?? defaultWait;
  }

  /** The pause that stopped the universe, while it is stopped. */
  get pause(): LivePause | undefined {
    return this.#tripped;
  }

  /**
   * Block until the universe may (re)start an epoch.
   *
   * Called before any evidence of the epoch is written, so a universe that
   * starts under a full disk writes nothing at all rather than writing a
   * manifest it cannot follow with events.
   */
  async awaitClearance(signal?: AbortSignal): Promise<void> {
    let pause = this.#tripped ?? await this.#diskPause();
    if (pause === undefined) return;
    await this.#options.onPause?.(pause);
    const aborted = (): boolean => signal !== undefined && signal.aborted;
    let rounds = 0;
    while (!aborted()) {
      rounds += 1;
      if (rounds > this.#maxProbeRounds) throw new LiveSupervisorGaveUpError(pause, rounds - 1);
      await this.#wait(this.#probeIntervalMs, signal);
      if (aborted()) break;
      const disk = await this.#diskPause();
      if (disk !== undefined) {
        pause = disk;
        continue;
      }
      if (pause.reason === "provider_outage" && this.#options.probe !== undefined) {
        if (!(await this.#options.probe(signal))) continue;
      }
      break;
    }
    await this.#options.onResume?.(pause);
    this.#tripped = undefined;
    this.#failingTicks = 0;
  }

  /**
   * A signal for one attempt at an epoch: the caller's signal, plus this
   * supervisor's own abort. A fresh controller per attempt, because an abort
   * is not reusable and a resumed epoch must not start already aborted.
   */
  attach(parent?: AbortSignal): AbortSignal {
    this.detach();
    const controller = new AbortController();
    this.#controller = controller;
    this.#parent = parent;
    if (parent !== undefined) {
      if (parent.aborted) controller.abort();
      else {
        const forward = (): void => controller.abort();
        this.#forwardParentAbort = forward;
        parent.addEventListener("abort", forward, { once: true });
      }
    }
    return controller.signal;
  }

  detach(): void {
    if (this.#parent !== undefined && this.#forwardParentAbort !== undefined) {
      this.#parent.removeEventListener("abort", this.#forwardParentAbort);
    }
    this.#controller = undefined;
    this.#parent = undefined;
    this.#forwardParentAbort = undefined;
  }

  /**
   * Wrap a cognition port so that every tick is observed.
   *
   * The guards are evaluated on the way *out* of `propose`, after the tick's
   * consultations have already resolved: the abort therefore reaches
   * `LogicalUniverse.run` only at the end of the tick, and the tick's recorded
   * answers are exactly what they would have been without a supervisor.
   */
  instrument(port: CognitionPort): CognitionPort {
    const supervisor = this;
    return {
      id: port.id,
      cohort: port.cohort,
      async propose(requests: readonly CognitionRequest[], signal?: AbortSignal): Promise<CognitionRecord[]> {
        const records = await port.propose(requests, signal);
        await supervisor.#observeTick(requests, records);
        return records;
      },
    };
  }

  /** Health of one tick, then the two guards. Never throws into the world. */
  async #observeTick(
    requests: readonly CognitionRequest[],
    records: readonly CognitionRecord[],
  ): Promise<void> {
    if (this.#tripped !== undefined) return;
    const tick = requests[0]?.tick;
    const consulted = records.filter((record) => record.provider !== "unavailable").length;
    if (this.#outageTicks > 0 && requests.length > 0) {
      if (consulted === 0) this.#failingTicks += 1;
      else this.#failingTicks = 0;
      if (this.#failingTicks >= this.#outageTicks) {
        this.#trip({
          reason: "provider_outage",
          detail: `${this.#failingTicks} consecutive ticks without a consulted answer`,
          ...(tick === undefined ? {} : { tick }),
        });
        return;
      }
    }
    const disk = await this.#diskPause(tick);
    if (disk !== undefined) this.#trip(disk);
  }

  async #diskPause(tick?: number): Promise<LivePause | undefined> {
    if (this.#minFreeBytes <= 0) return undefined;
    let free: number;
    try {
      free = await this.#freeBytes(this.#dataRoot);
    } catch (error) {
      // An evidence root whose free space cannot be read is not a reason to
      // keep writing to it.
      return {
        reason: "low_disk",
        detail: `free space of ${this.#dataRoot} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        ...(tick === undefined ? {} : { tick }),
      };
    }
    if (free >= this.#minFreeBytes) return undefined;
    return {
      reason: "low_disk",
      detail: `${free} free bytes below the ${this.#minFreeBytes}-byte floor`,
      ...(tick === undefined ? {} : { tick }),
    };
  }

  #trip(pause: LivePause): void {
    this.#tripped = pause;
    this.#controller?.abort();
  }
}
