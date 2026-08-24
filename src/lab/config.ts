import { readFile } from "node:fs/promises";
import {
  LAB_SCHEMA_VERSION,
  PPM,
  type GenesisConfig,
  type PrimitiveActionType,
  type ResourceVector,
  type TaskFamily,
} from "./types.js";

const PRIMITIVE_ACTIONS: readonly PrimitiveActionType[] = [
  "observe", "reason", "send", "connect", "disconnect", "store", "retrieve", "execute",
  "verify", "spawn", "clone", "merge", "reserve", "transfer", "trade", "publishCapability",
  "useCapability", "claimTask", "submit",
];

const TASK_FAMILIES: readonly TaskFamily[] = [
  "arithmetic", "json_transform", "memory_recall", "correlation", "verification", "multi_step",
  "concurrency", "state_recovery",
];

const PRESSURE_TYPES = new Set([
  "resource_price_multiplier",
  "bandwidth_capacity_multiplier",
  "retire_agent_fraction",
  "task_load_multiplier",
]);

const RESOURCE_KINDS: readonly (keyof ResourceVector)[] = [
  "credits", "llmTokens", "computeMs", "storageBytes", "bandwidthBytes",
];

const rv = (
  credits = 0,
  llmTokens = 0,
  computeMs = 0,
  storageBytes = 0,
  bandwidthBytes = 0,
): ResourceVector => ({ credits, llmTokens, computeMs, storageBytes, bandwidthBytes });

export const DEFAULT_ACTION_COSTS: Record<PrimitiveActionType, ResourceVector> = {
  observe: rv(1, 0, 1, 0, 64),
  reason: rv(2, 0, 4, 0, 0),
  send: rv(1, 0, 1, 0, 256),
  connect: rv(3, 0, 2, 0, 128),
  disconnect: rv(1, 0, 1, 0, 64),
  store: rv(1, 0, 1, 256, 0),
  retrieve: rv(1, 0, 1, 0, 0),
  execute: rv(3, 0, 12, 0, 0),
  verify: rv(2, 0, 6, 0, 64),
  spawn: rv(1_000, 0, 1_000, 4_096, 0),
  clone: rv(750, 0, 750, 4_096, 0),
  merge: rv(500, 0, 500, 2_048, 128),
  reserve: rv(1, 0, 1, 0, 0),
  transfer: rv(1, 0, 1, 0, 64),
  trade: rv(2, 0, 2, 0, 128),
  publishCapability: rv(8, 0, 20, 1_024, 256),
  useCapability: rv(3, 0, 8, 0, 128),
  claimTask: rv(1, 0, 1, 0, 64),
  submit: rv(1, 0, 1, 0, 256),
};

export const DEFAULT_GENESIS_CONFIG: GenesisConfig = {
  schemaVersion: LAB_SCHEMA_VERSION,
  experimentId: "genesis-1",
  seed: "genesis-1-default",
  ticks: 500,
  agents: 16,
  metricEvery: 25,
  checkpointEvery: 100,
  initialResources: rv(1_000, 100_000, 100_000, 1_000_000, 1_000_000),
  treasuryResources: rv(84_000, 8_400_000, 48_400_000, 9_984_000_000, 9_984_000_000),
  acceptedTaskReward: rv(5),
  costs: structuredClone(DEFAULT_ACTION_COSTS),
  taskStream: {
    families: [
      "arithmetic",
      "json_transform",
      "memory_recall",
      "correlation",
      "verification",
      "multi_step",
      "concurrency",
      "state_recovery",
    ],
    tasksPerTick: 1,
    deadlineTicks: 25,
    maxBacklog: 256,
  },
  pressures: [
    { tick: 100, type: "resource_price_multiplier", resource: "credits", multiplierPpm: 2 * PPM },
    { tick: 200, type: "bandwidth_capacity_multiplier", multiplierPpm: Math.floor(PPM / 2) },
    { tick: 300, type: "retire_agent_fraction", fractionPpm: 200_000 },
    { tick: 400, type: "task_load_multiplier", multiplierPpm: 4 * PPM },
  ],
};

export async function loadGenesisConfig(path?: string): Promise<GenesisConfig> {
  if (!path) return structuredClone(DEFAULT_GENESIS_CONFIG);
  const parsed = JSON.parse(await readFile(path, "utf8")) as GenesisConfig;
  validateGenesisConfig(parsed);
  return structuredClone(parsed);
}

export function validateGenesisConfig(config: GenesisConfig): void {
  if (config.schemaVersion !== LAB_SCHEMA_VERSION) throw new Error(`Unsupported lab schema ${config.schemaVersion}`);
  if (config.experimentId !== "genesis-1") throw new Error(`Unsupported experiment ${config.experimentId}`);
  if (!config.seed.trim()) throw new Error("Genesis seed must not be empty");
  positiveInteger(config.ticks, "ticks");
  positiveInteger(config.agents, "agents");
  positiveInteger(config.metricEvery, "metricEvery");
  positiveInteger(config.checkpointEvery, "checkpointEvery");
  if (config.agents > 10_000) throw new Error("agents exceeds the logical-mode safety limit");
  if (config.taskStream.families.length === 0) throw new Error("taskStream.families must not be empty");
  const configuredFamilies = new Set<TaskFamily>();
  for (const family of config.taskStream.families) {
    if (!TASK_FAMILIES.includes(family)) throw new Error(`Unknown task family ${String(family)}`);
    if (configuredFamilies.has(family)) throw new Error(`Duplicate task family ${family}`);
    configuredFamilies.add(family);
  }
  nonNegativeInteger(config.taskStream.tasksPerTick, "taskStream.tasksPerTick");
  positiveInteger(config.taskStream.deadlineTicks, "taskStream.deadlineTicks");
  positiveInteger(config.taskStream.maxBacklog, "taskStream.maxBacklog");
  if (config.taskStream.realizationSeed !== undefined) {
    const realizationSeed = config.taskStream.realizationSeed;
    if (typeof realizationSeed !== "string" || realizationSeed.trim().length === 0 || realizationSeed.length > 128) {
      throw new Error("taskStream.realizationSeed must be a non-empty string of at most 128 characters");
    }
  }
  validateResources(config.initialResources, "initialResources");
  validateResources(config.treasuryResources, "treasuryResources");
  validateResources(config.acceptedTaskReward, "acceptedTaskReward");
  const configuredActions = Object.keys(config.costs);
  for (const action of PRIMITIVE_ACTIONS) {
    if (!Object.hasOwn(config.costs, action)) throw new Error(`Missing action cost ${action}`);
    validateResources(config.costs[action], `costs.${action}`);
  }
  for (const action of configuredActions) {
    if (!(PRIMITIVE_ACTIONS as readonly string[]).includes(action)) throw new Error(`Unknown action cost ${action}`);
  }
  if (config.pressures.length !== PRESSURE_TYPES.size) {
    throw new Error(`pressures must contain exactly ${PRESSURE_TYPES.size} logical pressures`);
  }
  const configuredPressures = new Set<string>();
  for (const pressure of config.pressures) {
    if (!PRESSURE_TYPES.has(pressure.type)) throw new Error(`Unknown pressure type ${String(pressure.type)}`);
    if (configuredPressures.has(pressure.type)) throw new Error(`Duplicate pressure type ${pressure.type}`);
    configuredPressures.add(pressure.type);
    positiveInteger(pressure.tick, `pressure.${pressure.type}.tick`);
    const value = pressure.type === "retire_agent_fraction" ? pressure.fractionPpm : pressure.multiplierPpm;
    nonNegativeInteger(value, `pressure.${pressure.type}.value`);
    if (pressure.type === "retire_agent_fraction" && value > PPM) {
      throw new Error("retire_agent_fraction must be <= 1,000,000 ppm");
    }
  }
  for (const type of PRESSURE_TYPES) {
    if (!configuredPressures.has(type)) throw new Error(`Missing pressure type ${type}`);
  }

  for (const resource of RESOURCE_KINDS) {
    const total = BigInt(config.initialResources[resource]) * BigInt(config.agents)
      + BigInt(config.treasuryResources[resource]);
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`total ${resource} exceeds the safe-integer range`);
    }
  }
}

export function validateResources(resources: ResourceVector, name: string): void {
  for (const kind of RESOURCE_KINDS) nonNegativeInteger(resources[kind], `${name}.${kind}`);
  for (const kind of Object.keys(resources)) {
    if (!(RESOURCE_KINDS as readonly string[]).includes(kind)) throw new Error(`${name} contains unknown resource ${kind}`);
  }
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
}

function nonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
}
