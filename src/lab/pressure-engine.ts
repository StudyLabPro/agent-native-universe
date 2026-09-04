import { PPM, type LabEventDraft, type PressureSpec, type WorldState } from "./types.js";

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
      switch (pressure.type) {
        case "resource_price_multiplier":
          events.push(pressureEvent(tick, {
            type: pressure.type,
            resource: pressure.resource,
            multiplierPpm: pressure.multiplierPpm,
          }));
          break;
        case "bandwidth_capacity_multiplier":
          events.push(pressureEvent(tick, {
            type: pressure.type,
            multiplierPpm: pressure.multiplierPpm,
          }));
          break;
        case "task_load_multiplier":
          events.push(pressureEvent(tick, {
            type: pressure.type,
            multiplierPpm: pressure.multiplierPpm,
          }));
          break;
        case "retire_agent_fraction": {
          const activeIds = Object.values(state.agents)
            .filter((agent) => agent.active)
            .map((agent) => agent.id)
            .sort();
          const retireCount = Number(
            (BigInt(activeIds.length) * BigInt(pressure.fractionPpm)) / BigInt(PPM),
          );
          retiredAgentIds.push(...shuffle(activeIds, rng).slice(0, retireCount).sort());
          events.push(pressureEvent(tick, {
            type: pressure.type,
            fractionPpm: pressure.fractionPpm,
            retiredAgentIds: [...retiredAgentIds],
          }));
          break;
        }
      }
    }

    return { events, retiredAgentIds };
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
