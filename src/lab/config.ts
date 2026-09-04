import { readFile } from "node:fs/promises";
import {
  LAB_LIVE_EXPERIMENT_ID,
  LAB_SCHEMA_VERSION,
  LIVE_THINK_TIERS,
  PPM,
  isLabExperimentId,
  type CheckpointRuntimeState,
  type GenesisConfig,
  type LiveConfig,
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
  if (!isLabExperimentId(config.experimentId)) throw new Error(`Unsupported experiment ${config.experimentId}`);
  // Live physics exist exactly for genesis-live. A scientific or canary config
  // carrying them would put live parameters into a genesis-1 configHash.
  if (config.experimentId === LAB_LIVE_EXPERIMENT_ID) {
    if (config.live === undefined) throw new Error(`Experiment ${LAB_LIVE_EXPERIMENT_ID} requires a live section`);
    validateLiveConfig(config.live);
  } else if (config.live !== undefined) {
    throw new Error(`Experiment ${config.experimentId} must not carry a live section`);
  }
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
  // A live universe takes its physics from recorded operator input
  // (`physics/inbox.jsonl`, phase L3b), never from a config schedule, so an
  // empty list is the honest default there. Every other experiment still
  // carries exactly the four logical pressures.
  const liveExperiment = config.experimentId === LAB_LIVE_EXPERIMENT_ID;
  if (liveExperiment && config.pressures.length === 0) return assertResourceRanges(config);
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

  assertResourceRanges(config);
}

function assertResourceRanges(config: GenesisConfig): void {
  for (const resource of RESOURCE_KINDS) {
    const total = BigInt(config.initialResources[resource]) * BigInt(config.agents)
      + BigInt(config.treasuryResources[resource]);
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`total ${resource} exceeds the safe-integer range`);
    }
  }
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

const GENESIS_FROM_FIELDS: readonly string[] = [
  "runId", "engineVersion", "tick", "seq", "eventHash", "stateHash", "runtimeHash",
  "genesisStateHash", "runtime", "compaction",
];

/**
 * The parent's final `CheckpointRuntimeState`, carried in the config so the
 * child continues the same deterministic streams. Only its shape is checked
 * here; that it is the parent's own runtime is proven by `runtimeHash` and by
 * the parent's checkpoint (`src/lab/live/epoch.ts`).
 */
function validateInheritedRuntime(runtime: CheckpointRuntimeState): void {
  if (typeof runtime !== "object" || runtime === null) {
    throw new Error("live.genesisFrom.runtime must be an object");
  }
  const taskStream = runtime.taskStream;
  if (typeof taskStream !== "object" || taskStream === null) {
    throw new Error("live.genesisFrom.runtime.taskStream must be an object");
  }
  nonNegativeInteger(taskStream.sequence, "live.genesisFrom.runtime.taskStream.sequence");
  const rng = taskStream.rng;
  if (typeof rng !== "object" || rng === null || rng.algorithm !== "xoshiro256**") {
    throw new Error("live.genesisFrom.runtime.taskStream.rng must be a deterministic RNG checkpoint");
  }
  if (runtime.policy !== null && (typeof runtime.policy !== "object" || Array.isArray(runtime.policy))) {
    throw new Error("live.genesisFrom.runtime.policy must be a policy checkpoint or null");
  }
  for (const key of Object.keys(runtime)) {
    // `taskSource`/`pressureSource` cursors join this list in phase L3b.
    if (!["taskStream", "policy"].includes(key)) {
      throw new Error(`live.genesisFrom.runtime contains unknown field ${key}`);
    }
  }
}

export function validateLiveConfig(live: LiveConfig): void {
  if (typeof live !== "object" || live === null) throw new Error("live must be an object");
  positiveInteger(live.epochTicks, "live.epochTicks");
  if (typeof live.tiers !== "object" || live.tiers === null) throw new Error("live.tiers must be an object");
  for (const tier of LIVE_THINK_TIERS) {
    const physics = live.tiers[tier];
    if (typeof physics !== "object" || physics === null) throw new Error(`Missing live tier ${tier}`);
    positiveInteger(physics.pricePpm, `live.tiers.${tier}.pricePpm`);
    for (const key of Object.keys(physics)) {
      if (key !== "pricePpm") throw new Error(`live.tiers.${tier} contains unknown field ${key}`);
    }
  }
  for (const tier of Object.keys(live.tiers)) {
    if (!(LIVE_THINK_TIERS as readonly string[]).includes(tier)) throw new Error(`Unknown live tier ${tier}`);
  }
  if (typeof live.exhaustion !== "object" || live.exhaustion === null) throw new Error("live.exhaustion must be an object");
  nonNegativeInteger(live.exhaustion.minThinkTokens, "live.exhaustion.minThinkTokens");
  positiveInteger(live.exhaustion.graceTicks, "live.exhaustion.graceTicks");
  if (typeof live.archive !== "object" || live.archive === null) throw new Error("live.archive must be an object");
  positiveInteger(live.archive.taskTicks, "live.archive.taskTicks");
  positiveInteger(live.archive.messageTicks, "live.archive.messageTicks");
  positiveInteger(live.archive.submissionTicks, "live.archive.submissionTicks");
  if (typeof live.fsyncEveryTick !== "boolean") throw new Error("live.fsyncEveryTick must be a boolean");
  if (live.genesisFrom !== undefined) {
    const from = live.genesisFrom;
    if (typeof from !== "object" || from === null) throw new Error("live.genesisFrom must be an object");
    if (typeof from.runId !== "string" || !/^run-[a-f0-9]{32}$/.test(from.runId)) {
      throw new Error("live.genesisFrom.runId must be a run identifier");
    }
    if (
      typeof from.engineVersion !== "string"
      || from.engineVersion.length === 0
      || from.engineVersion.length > 128
    ) {
      throw new Error("live.genesisFrom.engineVersion must be a non-empty string of at most 128 characters");
    }
    positiveInteger(from.tick, "live.genesisFrom.tick");
    positiveInteger(from.seq, "live.genesisFrom.seq");
    for (const field of ["eventHash", "stateHash", "runtimeHash", "genesisStateHash"] as const) {
      if (typeof from[field] !== "string" || !SHA256_HEX.test(from[field])) {
        throw new Error(`live.genesisFrom.${field} must be a lowercase SHA-256 digest`);
      }
    }
    validateInheritedRuntime(from.runtime);
    if (typeof from.compaction !== "object" || from.compaction === null) {
      throw new Error("live.genesisFrom.compaction must be an object");
    }
    // Fail closed on a rule this build cannot apply: the inherited state would
    // otherwise be trusted rather than re-derivable from the parent's.
    if (from.compaction.kind !== "none") {
      throw new Error(`Unsupported live.genesisFrom.compaction.kind ${String(from.compaction.kind)}`);
    }
    for (const key of Object.keys(from.compaction)) {
      if (key !== "kind") throw new Error(`live.genesisFrom.compaction contains unknown field ${key}`);
    }
    for (const key of Object.keys(from)) {
      if (!GENESIS_FROM_FIELDS.includes(key)) {
        throw new Error(`live.genesisFrom contains unknown field ${key}`);
      }
    }
  }
  for (const key of Object.keys(live)) {
    if (!["epochTicks", "tiers", "exhaustion", "archive", "fsyncEveryTick", "genesisFrom"].includes(key)) {
      throw new Error(`live contains unknown field ${key}`);
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
