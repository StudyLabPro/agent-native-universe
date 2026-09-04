import { PPM, type LabEventDraft, type PressureSpec, type ResourceKind, type WorldState } from "./types.js";

const RESOURCE_KINDS: readonly string[] = Object.freeze([
  "credits", "llmTokens", "computeMs", "storageBytes", "bandwidthBytes",
]);

const PRESSURE_FIELDS: Readonly<Record<PressureSpec["type"], readonly string[]>> = Object.freeze({
  resource_price_multiplier: ["tick", "type", "resource", "multiplierPpm"],
  bandwidth_capacity_multiplier: ["tick", "type", "multiplierPpm"],
  task_load_multiplier: ["tick", "type", "multiplierPpm"],
  retire_agent_fraction: ["tick", "type", "fractionPpm"],
});

export interface ParsePressureSpecOptions {
  /** Force the tick, for a source that binds a record to the tick it applies on. */
  tick?: number;
  /** Fields tolerated beyond the spec's own, e.g. an event payload's `retiredAgentIds`. */
  allowedExtra?: readonly string[];
}

/**
 * The shape of one pressure, validated once.
 *
 * Three places need to agree on it: the configured schedule of a bounded run,
 * the recorded physics inbox of a live epoch, and the protocol verifier, which
 * reads a recorded `pressure.applied` back out of the chain and recomputes what
 * it did. A second copy of these rules is exactly how a recorded input starts
 * meaning something different from what it meant when it was applied.
 */
export function parsePressureSpec(
  value: Record<string, unknown>,
  options: ParsePressureSpecOptions = {},
): PressureSpec {
  const type = value.type;
  if (typeof type !== "string" || !(PRESSURE_TYPES as readonly string[]).includes(type)) {
    throw new Error(`Unknown pressure type ${String(type)}`);
  }
  const kind = type as PressureSpec["type"];
  for (const key of Object.keys(value)) {
    if (!PRESSURE_FIELDS[kind].includes(key) && !(options.allowedExtra ?? []).includes(key)) {
      throw new Error(`A ${kind} pressure contains unknown field ${key}`);
    }
  }
  const tick = options.tick ?? value.tick;
  nonNegativeSafeInteger(tick as number, `${kind}.tick`);
  if (options.tick !== undefined && value.tick !== undefined && value.tick !== options.tick) {
    throw new Error(`A ${kind} pressure applies on its own tick`);
  }
  if (kind === "retire_agent_fraction") {
    const fractionPpm = value.fractionPpm;
    nonNegativeSafeInteger(fractionPpm as number, `${kind}.fractionPpm`);
    if ((fractionPpm as number) > PPM) throw new Error("retire_agent_fraction must be at most 1,000,000 ppm");
    return { tick: tick as number, type: kind, fractionPpm: fractionPpm as number };
  }
  const multiplierPpm = value.multiplierPpm;
  nonNegativeSafeInteger(multiplierPpm as number, `${kind}.multiplierPpm`);
  if (kind === "resource_price_multiplier") {
    const resource = value.resource;
    if (typeof resource !== "string" || !RESOURCE_KINDS.includes(resource)) {
      throw new Error(`A ${kind} pressure names an unknown resource ${String(resource)}`);
    }
    return {
      tick: tick as number,
      type: kind,
      resource: resource as ResourceKind,
      multiplierPpm: multiplierPpm as number,
    };
  }
  return { tick: tick as number, type: kind, multiplierPpm: multiplierPpm as number };
}

export interface PressureRandomSource {
  nextInt(maxExclusive: number): number;
}

export interface PressureResult {
  events: LabEventDraft[];
  retiredAgentIds: string[];
}

const PRESSURE_TYPES = [
  "resource_price_multiplier",
  "bandwidth_capacity_multiplier",
  "retire_agent_fraction",
  "task_load_multiplier",
] as const;

/** Applies the four logical (in-world) Genesis pressures exactly once. */
export class PressureEngine {
  readonly #pressures: readonly PressureSpec[];
  readonly #applied = new Set<number>();
  readonly #empty: boolean;

  constructor(pressures: readonly PressureSpec[]) {
    // Either the complete logical schedule, or none at all: a live universe
    // takes its physics from recorded operator input rather than from a
    // configured schedule (`validateGenesisConfig` permits the empty list only
    // for `genesis-live`), and a partial logical schedule stays an error.
    if (pressures.length !== PRESSURE_TYPES.length && pressures.length !== 0) {
      throw new Error(`PressureEngine requires exactly ${PRESSURE_TYPES.length} logical pressures`);
    }
    this.#empty = pressures.length === 0;
    const counts = new Map<string, number>();
    for (const pressure of pressures) {
      nonNegativeSafeInteger(pressure.tick, `${pressure.type}.tick`);
      const value = pressure.type === "retire_agent_fraction" ? pressure.fractionPpm : pressure.multiplierPpm;
      nonNegativeSafeInteger(value, `${pressure.type}.value`);
      if (pressure.type === "retire_agent_fraction" && pressure.fractionPpm > PPM) {
        throw new Error("retire_agent_fraction must be at most 1,000,000 ppm");
      }
      counts.set(pressure.type, (counts.get(pressure.type) ?? 0) + 1);
    }
    for (const type of PRESSURE_TYPES) {
      if (!this.#empty && counts.get(type) !== 1) {
        throw new Error(`PressureEngine requires exactly one ${type} pressure`);
      }
    }
    this.#pressures = pressures.map((pressure) => structuredClone(pressure));
  }

  forTick(tick: number, state: WorldState, rng: PressureRandomSource): PressureResult {
    nonNegativeSafeInteger(tick, "pressure tick");
    const events: LabEventDraft[] = [];
    const retiredAgentIds: string[] = [];

    for (const [index, pressure] of this.#pressures.entries()) {
      if (pressure.tick !== tick || this.#applied.has(index)) continue;
      this.#applied.add(index);
      const effect = pressureEffect(tick, pressure, state, rng, retiredAgentIds);
      events.push(effect.event);
      retiredAgentIds.push(...effect.retiredAgentIds);
    }

    return { events, retiredAgentIds };
  }
}

export interface SinglePressureEffect {
  event: LabEventDraft;
  /** Agents this pressure alone retires, in id order. */
  retiredAgentIds: string[];
}

/**
 * The effect of ONE pressure spec, as a pure function of the tick, the state
 * and the random source.
 *
 * The configured schedule of a bounded run and the recorded operator physics
 * of a live epoch (`physics/inbox.jsonl`, phase L3b) are two ways of choosing
 * WHICH pressures apply; what a pressure DOES is this function and nothing
 * else, so the world, the pressure engine and the protocol verifier cannot
 * drift apart. `alreadyRetired` reproduces the historical shape of the
 * `retire_agent_fraction` payload, which restates every id retired in the tick
 * so far.
 */
export function pressureEffect(
  tick: number,
  pressure: PressureSpec,
  state: WorldState,
  rng: PressureRandomSource,
  alreadyRetired: readonly string[] = [],
): SinglePressureEffect {
  switch (pressure.type) {
    case "resource_price_multiplier":
      return {
        event: pressureEvent(tick, {
          type: pressure.type,
          resource: pressure.resource,
          multiplierPpm: pressure.multiplierPpm,
        }),
        retiredAgentIds: [],
      };
    case "bandwidth_capacity_multiplier":
    case "task_load_multiplier":
      return {
        event: pressureEvent(tick, {
          type: pressure.type,
          multiplierPpm: pressure.multiplierPpm,
        }),
        retiredAgentIds: [],
      };
    case "retire_agent_fraction": {
      const activeIds = Object.values(state.agents)
        .filter((agent) => agent.active)
        .map((agent) => agent.id)
        .sort();
      const retireCount = Number(
        (BigInt(activeIds.length) * BigInt(pressure.fractionPpm)) / BigInt(PPM),
      );
      const retiredAgentIds = shuffle(activeIds, rng).slice(0, retireCount).sort();
      return {
        event: pressureEvent(tick, {
          type: pressure.type,
          fractionPpm: pressure.fractionPpm,
          retiredAgentIds: [...alreadyRetired, ...retiredAgentIds],
        }),
        retiredAgentIds,
      };
    }
  }
}

function pressureEvent(tick: number, data: LabEventDraft["data"]): LabEventDraft {
  return {
    tick,
    phase: "pressure",
    type: "pressure.applied",
    data,
  };
}

function shuffle<T>(values: readonly T[], rng: PressureRandomSource): T[] {
  const output = [...values];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const selected = rng.nextInt(index + 1);
    if (!Number.isSafeInteger(selected) || selected < 0 || selected > index) {
      throw new Error(`RNG returned ${selected} outside [0, ${index + 1})`);
    }
    [output[index], output[selected]] = [output[selected]!, output[index]!];
  }
  return output;
}

function nonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
}
