import {
  LAB_SCHEMA_VERSION,
  PPM,
  type LabAgentState,
  type MetricsSnapshot,
  type ResourceVector,
  type TaskFamily,
  type WorldState,
} from "./types.js";
import { compareCodeUnits } from "./canonical.js";
import { RESOURCE_KINDS, assertResourceVector } from "./resource-physics.js";

const TASK_FAMILIES: readonly TaskFamily[] = Object.freeze([
  "arithmetic",
  "json_transform",
  "memory_recall",
  "correlation",
  "verification",
  "multi_step",
  "concurrency",
  "state_recovery",
]);

/**
 * Computes integer fixed-point metrics. Rational values are represented in
 * parts per million and truncated toward zero, making results bit-exact.
 * `initialTotals`, when supplied, is the genesis total held by agents (the
 * treasury is intentionally excluded) and enables per-accepted-task costs.
 */
export function computeMetrics(state: WorldState, initialTotals?: ResourceVector): MetricsSnapshot {
  nonNegativeSafeInteger(state.tick, "metrics tick");
  if (initialTotals) assertResourceVector(initialTotals, "initialTotals");

  const agents = Object.values(state.agents);
  const activeAgents = agents.filter((agent) => agent.active).sort((left, right) => compareCodeUnits(left.id, right.id));
  const activeIds = new Set(activeAgents.map((agent) => agent.id));
  const activeLinks = Object.values(state.links).filter((link) => activeIds.has(link.left) && activeIds.has(link.right));
  const tasks = Object.values(state.tasks);
  const submissions = Object.values(state.submissions);
  const acceptedTaskIds = new Set(submissions.filter((submission) => submission.accepted).map((submission) => submission.taskId));
  const acceptedLatencies = submissions
    .filter((submission) => submission.accepted)
    .map((submission) => submission.latencyTicks)
    .sort((left, right) => left - right);

  const graph = graphMetrics(activeAgents.map((agent) => agent.id), activeLinks.map((link) => [link.left, link.right]));
  // A bounded live world archives settled records out of the maps, so its
  // lifetime totals live in `state.counters` instead of in the map lengths.
  // Absent counters (every logical and cognitive state) keep the historical
  // length-based arithmetic byte-for-byte.
  const counters = state.counters;
  const tasksCreated = counters?.tasksCreated ?? tasks.length;
  const tasksCompleted = counters?.tasksCompleted ?? tasks.filter((task) => task.status === "completed").length;
  const qualityTotal = submissions.reduce((sum, submission) => sum + BigInt(submission.qualityPpm), 0n);
  const meanQualityPpm = submissions.length === 0
    ? 0
    : safeBigIntToNumber(qualityTotal / BigInt(submissions.length), "mean quality");
  const acceptedTasks = counters?.acceptedTasks ?? acceptedTaskIds.size;
  const previous = state.metrics.at(-1);
  const previousTick = previous?.tick ?? -1;
  const createdSincePrevious = activeLinks.filter((link) => (
    link.createdTick > previousTick && link.createdTick <= state.tick
  )).length;
  const inferredRemoved = previous
    ? Math.max(0, previous.activeLinks + createdSincePrevious - activeLinks.length)
    : 0;

  return {
    schemaVersion: LAB_SCHEMA_VERSION,
    tick: state.tick,
    tasksCreated,
    tasksCompleted,
    taskSuccessRatePpm: ppmRatio(acceptedTasks, tasksCreated),
    meanQualityPpm,
    p50LatencyTicks: percentileNearestRank(acceptedLatencies, 50),
    p95LatencyTicks: percentileNearestRank(acceptedLatencies, 95),
    creditsPerAcceptedTaskPpm: perAcceptedTask(
      state.resourceSpent?.credits ?? spent(initialTotals?.credits, sumAgentResources(agents).credits),
      acceptedTasks,
    ),
    computePerAcceptedTaskPpm: perAcceptedTask(
      state.resourceSpent?.computeMs ?? spent(initialTotals?.computeMs, sumAgentResources(agents).computeMs),
      acceptedTasks,
    ),
    bandwidthPerAcceptedTaskPpm: perAcceptedTask(
      state.resourceSpent?.bandwidthBytes ?? spent(initialTotals?.bandwidthBytes, sumAgentResources(agents).bandwidthBytes),
      acceptedTasks,
    ),
    activeAgents: activeAgents.length,
    activeLinks: activeLinks.length,
    densityPpm: graph.densityPpm,
    connectedComponents: graph.connectedComponents,
    degreeCentralizationPpm: graph.degreeCentralizationPpm,
    resourceGiniPpm: meanResourceGini(activeAgents),
    meanSpecializationPpm: meanSpecialization(activeAgents),
    linkTurnover: createdSincePrevious + inferredRemoved,
    violations: agents.reduce((total, agent) => safeCountAdd(total, agent.violations, "violations"), 0),
  };
}

export function giniPpm(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  for (const value of sorted) nonNegativeSafeInteger(value, "Gini value");
  const total = sorted.reduce((sum, value) => sum + BigInt(value), 0n);
  if (total === 0n) return 0;
  const count = BigInt(sorted.length);
  let weighted = 0n;
  for (const [index, value] of sorted.entries()) {
    const coefficient = 2n * BigInt(index + 1) - count - 1n;
    weighted += coefficient * BigInt(value);
  }
  return safeBigIntToNumber((weighted * BigInt(PPM)) / (count * total), "Gini coefficient");
}

export function specializationPpm(agent: LabAgentState): number {
  const counts = TASK_FAMILIES.map((family) => agent.taskCounts[family] ?? 0);
  for (const count of counts) nonNegativeSafeInteger(count, "task count");
  const total = counts.reduce((sum, count) => sum + BigInt(count), 0n);
  if (total === 0n) return 0;
  const families = BigInt(TASK_FAMILIES.length);
  const sumSquares = counts.reduce((sum, count) => sum + BigInt(count) ** 2n, 0n);
  const totalSquared = total ** 2n;
  const numerator = families * sumSquares - totalSquared;
  const denominator = (families - 1n) * totalSquared;
  return safeBigIntToNumber((numerator * BigInt(PPM)) / denominator, "specialization coefficient");
}

interface GraphMetrics {
  densityPpm: number;
  connectedComponents: number;
  degreeCentralizationPpm: number;
}

function graphMetrics(agentIds: readonly string[], edges: readonly (readonly [string, string])[]): GraphMetrics {
  if (agentIds.length === 0) return { densityPpm: 0, connectedComponents: 0, degreeCentralizationPpm: 0 };
  const adjacency = new Map(agentIds.map((id) => [id, new Set<string>()]));
  const uniqueEdges = new Set<string>();
  for (const [left, right] of edges) {
    if (left === right || !adjacency.has(left) || !adjacency.has(right)) continue;
    const pair = left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
    if (uniqueEdges.has(pair)) continue;
    uniqueEdges.add(pair);
    adjacency.get(left)!.add(right);
    adjacency.get(right)!.add(left);
  }

  const count = agentIds.length;
  const densityDenominator = count < 2 ? 0 : count * (count - 1);
  const densityPpm = densityDenominator === 0 ? 0 : ppmRatio(uniqueEdges.size * 2, densityDenominator);
  const degrees = agentIds.map((id) => adjacency.get(id)!.size);
  const maximum = Math.max(...degrees);
  const centralizationNumerator = degrees.reduce((sum, degree) => sum + maximum - degree, 0);
  const centralizationDenominator = count < 3 ? 0 : (count - 1) * (count - 2);

  const visited = new Set<string>();
  let connectedComponents = 0;
  for (const start of agentIds) {
    if (visited.has(start)) continue;
    connectedComponents += 1;
    const pending = [start];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const neighbor of adjacency.get(current)!) if (!visited.has(neighbor)) pending.push(neighbor);
    }
  }
  return {
    densityPpm,
    connectedComponents,
    degreeCentralizationPpm: centralizationDenominator === 0
      ? 0
      : ppmRatio(centralizationNumerator, centralizationDenominator),
  };
}

function meanResourceGini(agents: readonly LabAgentState[]): number {
  if (agents.length === 0) return 0;
  const total = RESOURCE_KINDS.reduce(
    (sum, resource) => sum + BigInt(giniPpm(agents.map((agent) => agent.resources[resource]))),
    0n,
  );
  return safeBigIntToNumber(total / BigInt(RESOURCE_KINDS.length), "mean resource Gini");
}

function meanSpecialization(agents: readonly LabAgentState[]): number {
  if (agents.length === 0) return 0;
  const total = agents.reduce((sum, agent) => sum + BigInt(specializationPpm(agent)), 0n);
  return safeBigIntToNumber(total / BigInt(agents.length), "mean specialization");
}

function sumAgentResources(agents: readonly LabAgentState[]): ResourceVector {
  const totals: Record<(typeof RESOURCE_KINDS)[number], bigint> = {
    credits: 0n,
    llmTokens: 0n,
    computeMs: 0n,
    storageBytes: 0n,
    bandwidthBytes: 0n,
  };
  for (const agent of agents) {
    assertResourceVector(agent.resources, `agent ${agent.id}`);
    for (const resource of RESOURCE_KINDS) totals[resource] += BigInt(agent.resources[resource]);
  }
  return {
    credits: safeBigIntToNumber(totals.credits, "total credits"),
    llmTokens: safeBigIntToNumber(totals.llmTokens, "total model tokens"),
    computeMs: safeBigIntToNumber(totals.computeMs, "total compute"),
    storageBytes: safeBigIntToNumber(totals.storageBytes, "total storage"),
    bandwidthBytes: safeBigIntToNumber(totals.bandwidthBytes, "total bandwidth"),
  };
}

function percentileNearestRank(sorted: readonly number[], percentile: number): number {
  if (sorted.length === 0) return 0;
  for (const value of sorted) nonNegativeSafeInteger(value, "latency");
  const rank = Math.ceil((percentile * sorted.length) / 100);
  return sorted[Math.max(0, rank - 1)]!;
}

function spent(initial: number | undefined, current: number): number {
  if (initial === undefined || current >= initial) return 0;
  return initial - current;
}

function perAcceptedTask(amount: number, acceptedTasks: number): number {
  if (acceptedTasks === 0) return 0;
  return safeBigIntToNumber(
    (BigInt(amount) * BigInt(PPM)) / BigInt(acceptedTasks),
    "resource per accepted task",
  );
}

function ppmRatio(numerator: number, denominator: number): number {
  nonNegativeSafeInteger(numerator, "ratio numerator");
  nonNegativeSafeInteger(denominator, "ratio denominator");
  if (denominator === 0) return 0;
  return safeBigIntToNumber(
    (BigInt(numerator) * BigInt(PPM)) / BigInt(denominator),
    "fixed-point ratio",
  );
}

function safeCountAdd(left: number, right: number, label: string): number {
  nonNegativeSafeInteger(left, label);
  nonNegativeSafeInteger(right, label);
  return safeBigIntToNumber(BigInt(left) + BigInt(right), label);
}

function safeBigIntToNumber(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds the non-negative safe-integer range`);
  }
  return Number(value);
}

function nonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
}
