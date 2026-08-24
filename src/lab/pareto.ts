/**
 * Multi-objective comparison of universes.
 *
 * A population does not have a winner. Collapsing quality, cost, latency and
 * resilience into one score silently encodes a preference we have no grounds
 * for: an architecture that is cheap and fragile is not worse than one that is
 * expensive and robust, it is a different trade. Ranking by a weighted sum
 * would therefore manufacture the very conclusion the experiment is meant to
 * discover.
 *
 * So universes are compared by Pareto dominance and selected by
 * non-dominated rank with a diversity tie-break, the way NSGA-II does it.
 * Every objective is read from the fixed-point metrics, and every computation
 * here is integer arithmetic, so the same population always yields the same
 * frontier.
 */

import { LAB_SCHEMA_VERSION, type MetricsSnapshot, type RunSummary } from "./types.js";

export type ObjectiveDirection = "maximize" | "minimize";

export interface Objective {
  readonly key: string;
  readonly direction: ObjectiveDirection;
  /** Reads a fixed-point value out of a run's final metrics. */
  readonly read: (metrics: MetricsSnapshot) => number;
}

/**
 * The default trade space.
 *
 * Deliberately not weighted and deliberately not exhaustive: these are the
 * dimensions a run already measures honestly. Structural properties such as
 * specialization are excluded on purpose — they describe what a universe
 * became, not how well it did, and treating them as objectives would reward
 * organization for its own sake.
 */
export const DEFAULT_OBJECTIVES: readonly Objective[] = Object.freeze([
  { key: "taskSuccessRatePpm", direction: "maximize", read: (m) => m.taskSuccessRatePpm },
  { key: "meanQualityPpm", direction: "maximize", read: (m) => m.meanQualityPpm },
  { key: "creditsPerAcceptedTaskPpm", direction: "minimize", read: (m) => m.creditsPerAcceptedTaskPpm },
  { key: "p95LatencyTicks", direction: "minimize", read: (m) => m.p95LatencyTicks },
  { key: "violations", direction: "minimize", read: (m) => m.violations },
  { key: "activeAgents", direction: "maximize", read: (m) => m.activeAgents },
]);

export interface ParetoPoint {
  universeId: string;
  runId: string;
  /** Objective values in the order of the objective list, already oriented so
   * that larger is always better. */
  values: number[];
}

export interface ParetoEntry extends ParetoPoint {
  /** 0 is the frontier; 1 is the frontier of what remains, and so on. */
  rank: number;
  /**
   * How isolated the point is within its rank, in ppm. Boundary points score
   * `Number.MAX_SAFE_INTEGER` so the extremes of a frontier are never the first
   * thing a selection discards.
   */
  crowdingPpm: number;
}

export interface ParetoAnalysis {
  schemaVersion: typeof LAB_SCHEMA_VERSION;
  objectives: Array<{ key: string; direction: ObjectiveDirection }>;
  entries: ParetoEntry[];
  /** Universe ids on rank 0, in ascending id order. */
  frontier: string[];
}

/** Orients every objective so that a larger number is always better. */
export function toParetoPoints(
  runs: readonly RunSummary[],
  objectives: readonly Objective[] = DEFAULT_OBJECTIVES,
): ParetoPoint[] {
  return runs.map((run) => ({
    universeId: run.universeId,
    runId: run.runId,
    values: objectives.map((objective) => {
      const value = objective.read(run.latestMetrics);
      if (!Number.isFinite(value)) throw new TypeError(`Objective ${objective.key} is not finite`);
      return objective.direction === "maximize" ? value : -value;
    }),
  }));
}

/**
 * True when `left` is at least as good everywhere and strictly better
 * somewhere. Equal points never dominate each other, so identical universes
 * share a rank instead of one arbitrarily outranking the other.
 */
export function dominates(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) throw new TypeError("Pareto points must share a dimensionality");
  let strictlyBetter = false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (a < b) return false;
    if (a > b) strictlyBetter = true;
  }
  return strictlyBetter;
}

/** The non-dominated set, in ascending universe id order. */
export function paretoFrontier(points: readonly ParetoPoint[]): ParetoPoint[] {
  return points
    .filter((candidate) => !points.some((other) => other !== candidate && dominates(other.values, candidate.values)))
    .sort((left, right) => compare(left.universeId, right.universeId));
}

/** Full non-dominated sorting: rank 0 is the frontier, rank 1 the next layer. */
export function paretoRanks(points: readonly ParetoPoint[]): Map<string, number> {
  const ranks = new Map<string, number>();
  let remaining = [...points];
  let rank = 0;
  while (remaining.length > 0) {
    const layer = paretoFrontier(remaining);
    // Defensive: a cycle is impossible with a strict partial order, but an
    // empty layer would loop forever if one ever appeared.
    if (layer.length === 0) {
      for (const point of remaining) ranks.set(point.universeId, rank);
      break;
    }
    for (const point of layer) ranks.set(point.universeId, rank);
    const promoted = new Set(layer.map((point) => point.universeId));
    remaining = remaining.filter((point) => !promoted.has(point.universeId));
    rank += 1;
  }
  return ranks;
}

/**
 * Crowding distance within one rank, scaled to ppm.
 *
 * Selecting purely by rank collapses a population onto whichever corner of the
 * trade space happens to be easiest, so diversity has to be an explicit part
 * of survival rather than a hoped-for side effect.
 */
export function crowdingDistances(layer: readonly ParetoPoint[]): Map<string, number> {
  const distances = new Map<string, number>(layer.map((point) => [point.universeId, 0]));
  if (layer.length <= 2) {
    for (const point of layer) distances.set(point.universeId, Number.MAX_SAFE_INTEGER);
    return distances;
  }
  const dimensions = layer[0]!.values.length;
  for (let axis = 0; axis < dimensions; axis += 1) {
    const sorted = [...layer].sort((left, right) => {
      const delta = left.values[axis]! - right.values[axis]!;
      return delta !== 0 ? delta : compare(left.universeId, right.universeId);
    });
    const lowest = sorted[0]!;
    const highest = sorted[sorted.length - 1]!;
    distances.set(lowest.universeId, Number.MAX_SAFE_INTEGER);
    distances.set(highest.universeId, Number.MAX_SAFE_INTEGER);
    const span = highest.values[axis]! - lowest.values[axis]!;
    // A flat axis separates nobody; dividing by it would only inject noise.
    if (span === 0) continue;
    for (let index = 1; index < sorted.length - 1; index += 1) {
      const point = sorted[index]!;
      const current = distances.get(point.universeId)!;
      if (current === Number.MAX_SAFE_INTEGER) continue;
      const gap = sorted[index + 1]!.values[axis]! - sorted[index - 1]!.values[axis]!;
      distances.set(point.universeId, current + Math.floor((gap * 1_000_000) / span));
    }
  }
  return distances;
}

export function analysePopulation(
  runs: readonly RunSummary[],
  objectives: readonly Objective[] = DEFAULT_OBJECTIVES,
): ParetoAnalysis {
  const points = toParetoPoints(runs, objectives);
  const ranks = paretoRanks(points);
  const byRank = new Map<number, ParetoPoint[]>();
  for (const point of points) {
    const rank = ranks.get(point.universeId)!;
    const bucket = byRank.get(rank);
    if (bucket) bucket.push(point);
    else byRank.set(rank, [point]);
  }
  const crowding = new Map<string, number>();
  for (const layer of byRank.values()) {
    for (const [id, distance] of crowdingDistances(layer)) crowding.set(id, distance);
  }
  const entries: ParetoEntry[] = points
    .map((point) => ({
      ...point,
      rank: ranks.get(point.universeId)!,
      crowdingPpm: crowding.get(point.universeId) ?? 0,
    }))
    .sort((left, right) => left.rank - right.rank || compare(left.universeId, right.universeId));
  return {
    schemaVersion: LAB_SCHEMA_VERSION,
    objectives: objectives.map((objective) => ({ key: objective.key, direction: objective.direction })),
    entries,
    frontier: entries.filter((entry) => entry.rank === 0).map((entry) => entry.universeId),
  };
}

/**
 * Pick survivors for the next generation: better rank first, and within a rank
 * the more isolated point first, so the frontier keeps its extremes.
 */
export function selectSurvivors(analysis: ParetoAnalysis, count: number): string[] {
  if (!Number.isSafeInteger(count) || count < 1) throw new TypeError("Survivor count must be a positive integer");
  return [...analysis.entries]
    .sort((left, right) =>
      left.rank - right.rank
      || right.crowdingPpm - left.crowdingPpm
      || compare(left.universeId, right.universeId))
    .slice(0, count)
    .map((entry) => entry.universeId);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
