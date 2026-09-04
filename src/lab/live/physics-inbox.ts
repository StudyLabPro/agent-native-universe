/**
 * Recorded operator physics (design §4.F, phase L3b).
 *
 * `physics/inbox.jsonl` is the entire control surface of a live universe. A
 * record raises the price of a resource, changes the bandwidth capacity or the
 * task load, or retires a share of the population — and nothing else. Which
 * agents a `retire_agent_fraction` takes is still drawn from `pressureRng`, so
 * even the share the operator sets cannot be aimed.
 *
 * A record that names an individual agent is REFUSED here, before it can reach
 * the world. That refusal is the owner's fourth invariant made mechanical: the
 * control plane sets physics, never who does what.
 */
import type { LivePressureSource } from "../live-ports.js";
import { parsePressureSpec } from "../pressure-engine.js";
import type { PressureSpec } from "../types.js";
import {
  RecordedInputError,
  assertNotAddressed,
  readInbox,
} from "./recorded-inbox.js";

/** Identity of the file-backed physics inbox. */
export const LIVE_PHYSICS_SOURCE_ID = "physics-inbox-v1";
/** The inbox path, relative to the universe root. */
export const LIVE_PHYSICS_INBOX_SEGMENTS: readonly string[] = Object.freeze(["physics", "inbox.jsonl"]);

/**
 * One line of `physics/inbox.jsonl`, turned into the pressure the world applies.
 *
 * The refusal of an addressed record happens HERE, at the boundary, before the
 * shape is even considered — the message has to name the invariant, not merely
 * report an unknown field. The shape itself is `parsePressureSpec`, the one
 * place a pressure's shape is defined.
 */
export function parsePressureRecord(record: Record<string, unknown>): PressureSpec {
  assertNotAddressed(record, "A physics record");
  try {
    return parsePressureSpec(record);
  } catch (error) {
    throw new RecordedInputError(
      `A physics record is not admissible: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parsePressureRecords(
  records: readonly Record<string, unknown>[],
): PressureSpec[] {
  return records.map((record) => parsePressureRecord(record));
}

/** An in-memory physics source — the shape a test or a driver supplies. */
export class RecordedPressureSource implements LivePressureSource {
  readonly id: string;
  readonly #pressures: readonly PressureSpec[];

  constructor(records: readonly Record<string, unknown>[], id = LIVE_PHYSICS_SOURCE_ID) {
    this.id = id;
    this.#pressures = parsePressureRecords(records);
  }

  async next(tick: number): Promise<PressureSpec[]> {
    return forTick(this.#pressures, tick);
  }
}

/** `physics/inbox.jsonl`, re-read every tick; a record applies on its own tick. */
export class FilePressureSource implements LivePressureSource {
  readonly id: string;
  readonly #path: string;

  constructor(path: string, id = LIVE_PHYSICS_SOURCE_ID) {
    this.#path = path;
    this.id = id;
  }

  async next(tick: number): Promise<PressureSpec[]> {
    const records = await readInbox(this.#path, "The physics inbox");
    return forTick(parsePressureRecords(records), tick);
  }
}

function forTick(pressures: readonly PressureSpec[], tick: number): PressureSpec[] {
  return pressures.filter((pressure) => pressure.tick === tick).map((pressure) => structuredClone(pressure));
}
