#!/usr/bin/env node
import { constants } from "node:fs";
import { isUtf8 } from "node:buffer";
import { lstat, open, type FileHandle } from "node:fs/promises";
import type { Server } from "node:http";
import { parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EvidenceStore } from "./artifacts.js";
import { createLogicalPolicyById, zeroCostConfig } from "./baselines.js";
import { hashValue } from "./canonical.js";
import { deterministicId } from "./ids.js";
import {
  BASELINE_CENTRAL_DISPATCH_ID,
  BASELINE_FIXED_ROLES_ID,
  BASELINE_NO_LINKS_ID,
} from "./manifest.js";
import { analysePopulation } from "./pareto.js";
import { canonicalJson } from "./canonical.js";
import { loadGenesisConfig, validateGenesisConfig } from "./config.js";
import {
  attestRunEvidence,
  verifyRunEvidenceAttestation,
} from "./evidence-attestation.js";
import { LlmRouter, OpenAICompatibleProvider } from "../v1/economy-llm.js";
import { LlmCognition, type CognitionPort } from "./cognition.js";
import { GenesisRunPausedError, runGenesis } from "./genesis.js";
import { startObserverServer } from "./observer.js";
import {
  MAX_POPULATION_PARALLELISM,
  MAX_POPULATION_UNIVERSES,
  PopulationRunPausedError,
  runPopulation,
} from "./population.js";
import { ReplayEngine } from "./replay.js";
import type { LogicalPolicy } from "./policy-schedule.js";
import type { GenesisConfig, RunSummary } from "./types.js";

const DEFAULT_DATA_DIR = "runs";
const DEFAULT_EXPERIMENT_ID = "genesis-1";
const DEFAULT_UNIVERSE_ID = "U0001";
const DEFAULT_OBSERVER_HOST = "0.0.0.0";
const DEFAULT_OBSERVER_PORT = 3_000;
const MAX_PATH_BYTES = 4_096;
const MAX_CONFIG_BYTES = 1_048_576;
const MAX_AUTH_TOKEN_FILE_BYTES = 4_098;
const MAX_TICKS = 10_000_000;
const MAX_SEED_BYTES = 1_024;
const RESOURCE_KINDS = [
  "credits",
  "llmTokens",
  "computeMs",
  "storageBytes",
  "bandwidthBytes",
] as const;

const RUN_OPTIONS = new Set([
  "agents",
  "checkpoint-every",
  "config",
  "data-dir",
  "experiment",
  "metric-every",
  "parallel",
  "seed",
  "ticks",
  "universes",
]);
const GENESIS_OPTIONS = new Set([
  "agents",
  "arm",
  "cohort",
  "checkpoint-every",
  "config",
  "data-dir",
  "experiment",
  "metric-every",
  "seed",
  "ticks",
  "universe-id",
]);
const BASELINES_OPTIONS = new Set([
  "agents",
  "arms",
  "checkpoint-every",
  "config",
  "data-dir",
  "experiment",
  "metric-every",
  "seed",
  "ticks",
]);
const REPLAY_OPTIONS = new Set([
  "data-dir",
  "experiment",
  "run-id",
  "until-tick",
  "universe-id",
]);
const ATTEST_OPTIONS = new Set([
  "data-dir",
  "experiment",
  "run-id",
  "universe-id",
]);
const VERIFY_ATTESTATION_OPTIONS = new Set([
  ...ATTEST_OPTIONS,
  "expected",
]);
const SERVE_OPTIONS = new Set(["auth-token-file", "data-dir", "host", "port"]);

interface JsonSink {
  write(chunk: string): unknown;
}

export interface LabCliIo {
  stdout: JsonSink;
  stderr: JsonSink;
}

interface ParsedOptions {
  help: boolean;
  values: Map<string, string>;
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

const HELP = {
  usage: "anu lab <command> [options]",
  commands: {
    run: "alias for population",
    "genesis-1": "run one logical Genesis-1 universe",
    baselines: "run the §33 control arms on one seed and compare them",
    population: "run a bounded population of independent universes",
    replay: "replay one universe from its append-only evidence",
    attest: "create or recover a deterministic final evidence attestation",
    "verify-attestation": "verify evidence and an externally published commitment",
    serve: "serve read-only evidence HTTP endpoints",
  },
  commonRunOptions: {
    "--data-dir": "evidence root (default: ./runs)",
    "--config": "Genesis JSON config path (default: built-in safe config)",
    "--agents": "override initial agent count",
    "--ticks": "override run ticks",
    "--seed": "override deterministic base seed",
  },
  examples: [
    "anu lab genesis-1 --data-dir ./runs --universe-id U0001",
    "anu lab population --data-dir ./runs --universes 32 --parallel 8",
    "anu lab baselines --data-dir ./runs --ticks 200 --arms A,C,D,E,F",
    "anu lab replay --data-dir ./runs --universe-id U0001 [--run-id RUN_ID]",
    "anu lab attest --data-dir ./runs --universe-id U0001 --run-id RUN_ID",
    "anu lab verify-attestation --data-dir ./runs --universe-id U0001 --run-id RUN_ID --expected sha256:HASH",
    "anu lab serve --data-dir ./runs --host 0.0.0.0 --port 3000 [--auth-token-file PATH]",
  ],
} as const;

/**
 * Execute a Lab CLI command without terminating the process.
 *
 * This makes the same command surface usable from `anu lab ...`, the dedicated
 * Docker entrypoint and process-level tests. Every emitted line is one JSON
 * object suitable for log collectors.
 */
export async function runLabCli(
  argv: readonly string[],
  partialIo: Partial<LabCliIo> = {},
): Promise<number> {
  const io: LabCliIo = {
    stdout: partialIo.stdout ?? process.stdout,
    stderr: partialIo.stderr ?? process.stderr,
  };
  const command = argv[0];

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    if (argv.length > 1) {
      return usageFailure(io, command ?? "help", "Help does not accept additional arguments");
    }
    writeJson(io.stdout, { command: "help", status: "ok", ...HELP });
    return 0;
  }

  try {
    switch (command) {
      case "run":
      case "population":
        await executePopulation(command, argv.slice(1), io);
        return 0;
      case "genesis-1":
        await executeGenesis(argv.slice(1), io);
        return 0;
      case "baselines":
        await executeBaselines(argv.slice(1), io);
        return 0;
      case "replay":
        await executeReplay(argv.slice(1), io);
        return 0;
      case "attest":
        await executeAttest(argv.slice(1), io);
        return 0;
      case "verify-attestation":
        await executeVerifyAttestation(argv.slice(1), io);
        return 0;
      case "serve":
        await executeServe(argv.slice(1), io);
        return 0;
      default:
        throw new CliUsageError(`Unknown Lab command: ${command}`);
    }
  } catch (error) {
    const usage = error instanceof CliUsageError;
    writeJson(io.stderr, {
      command,
      status: "error",
      error: {
        code: usage ? "invalid_usage" : "command_failed",
        message: safeErrorMessage(error),
      },
    });
    return usage ? 2 : 1;
  }
}

async function executePopulation(
  invokedCommand: "run" | "population",
  argv: readonly string[],
  io: LabCliIo,
): Promise<void> {
  const options = parseOptions(argv, RUN_OPTIONS);
  if (options.help) {
    writeJson(io.stdout, {
      command: invokedCommand,
      status: "ok",
      usage: "anu lab population [--data-dir PATH] [--universes N] [--parallel N] [config overrides]",
    });
    return;
  }

  const config = await configuredGenesis(options.values);
  const runsRoot = optionPath(options.values, "data-dir", DEFAULT_DATA_DIR);
  const universes = optionInteger(
    options.values,
    "universes",
    1,
    1,
    MAX_POPULATION_UNIVERSES,
  );
  const parallel = optionInteger(
    options.values,
    "parallel",
    1,
    1,
    MAX_POPULATION_PARALLELISM,
  );
  const shutdown = installRunAbortController();
  try {
    const population = await runPopulation({
      config,
      runsRoot,
      universes,
      parallel,
      signal: shutdown.signal,
    });
    writeJson(io.stdout, {
      command: invokedCommand,
      mode: "population",
      status: "completed",
      population,
    });
  } catch (error) {
    if (!(error instanceof PopulationRunPausedError)) throw error;
    writeJson(io.stdout, {
      command: invokedCommand,
      mode: "population",
      status: "paused",
      universes: error.universeIds,
    });
  } finally {
    shutdown.cleanup();
  }
}

async function executeGenesis(argv: readonly string[], io: LabCliIo): Promise<void> {
  const options = parseOptions(argv, GENESIS_OPTIONS);
  if (options.help) {
    writeJson(io.stdout, {
      command: "genesis-1",
      status: "ok",
      usage: "anu lab genesis-1 [--data-dir PATH] [--universe-id U0001] [--cohort A|B|C] [config overrides]",
    });
    return;
  }

  const arm = parseBaselineArm(options.values.get("arm"));
  const config = applyBaselineArm(await configuredGenesis(options.values), arm);
  const runsRoot = optionPath(options.values, "data-dir", DEFAULT_DATA_DIR);
  const universeId = optionUniverseId(options.values, "universe-id", DEFAULT_UNIVERSE_ID);
  const shutdown = installRunAbortController();
  try {
    const cognition = createCohortCognition(options.values.get("cohort"));
    if (cognition !== undefined && arm !== "A") {
      throw new CliUsageError("--cohort applies to arm A only; a control arm that thinks with a model is not a control");
    }
    const policy = baselineArmPolicy(arm);
    const summary = await runGenesis({
      config,
      runsRoot,
      universeId,
      signal: shutdown.signal,
      ...(cognition === undefined ? {} : { cognition }),
      ...(policy === undefined ? {} : { policy }),
    });
    writeJson(io.stdout, {
      command: "genesis-1",
      status: "completed",
      summary,
    });
  } catch (error) {
    if (error instanceof Error && /does not support deterministic resume/.test(error.message)) {
      // Cohort and control-arm policies fail closed on resume by design (and
      // resume itself is unsound until the evaluator's oracle map is rebuilt
      // on restore). Fail with the recovery path instead of a bare engine error.
      throw new CliUsageError(
        "This run was interrupted earlier and cannot resume (only unresumed neutral runs "
        + `support it). Delete ${runsRoot}/${config.experimentId}/${universeId}/ and rerun `
        + "to redo the run from genesis under the same deterministic identity.",
      );
    }
    if (!(error instanceof GenesisRunPausedError)) throw error;
    writeJson(io.stdout, {
      command: "genesis-1",
      status: "paused",
      runId: error.runId,
      universeId: error.universeId,
      tick: error.tick,
    });
  } finally {
    shutdown.cleanup();
  }
}

type BaselineArm = "A" | "C" | "D" | "E" | "F";

/**
 * Universe ids are bound to the arm identity, not to the position in the
 * --arms list: `--arms F` and `--arms A,C,F` must produce the same runId for
 * arm F, or reruns of a subset would silently redo full runs as unrelated
 * evidence.
 */
const BASELINE_ARM_UNIVERSES: Record<BaselineArm, string> = {
  A: "U0001",
  C: "U0002",
  D: "U0003",
  E: "U0004",
  F: "U0005",
};

const BASELINE_ARM_DESCRIPTIONS: Record<BaselineArm, string> = {
  A: "self-organizing network (neutral policy)",
  C: "no resource economy (every action cost is zero)",
  D: "no link adaptation (topology actions suppressed)",
  E: "central orchestrator (fixed dispatch, no discovery)",
  F: "preassigned human roles (fixed roles and fixed routing)",
};

function parseBaselineArm(raw: string | undefined): BaselineArm {
  const arm = (raw ?? "A").trim().toUpperCase();
  if (arm === "B") {
    throw new CliUsageError(
      "Arm B (no metaagents) is not applicable: the logical engine has no metaagents to remove",
    );
  }
  if (arm !== "A" && arm !== "C" && arm !== "D" && arm !== "E" && arm !== "F") {
    throw new CliUsageError(`Unknown baseline arm ${raw}; expected A, C, D, E or F`);
  }
  return arm;
}

/** Arm C is a physics change, not a policy: it lives in the config hash. */
function applyBaselineArm(config: GenesisConfig, arm: BaselineArm): GenesisConfig {
  return arm === "C" ? zeroCostConfig(config) : config;
}

function baselineArmPolicy(arm: BaselineArm): LogicalPolicy | undefined {
  switch (arm) {
    case "A":
    case "C":
      return undefined;
    case "D":
      return createLogicalPolicyById(BASELINE_NO_LINKS_ID);
    case "E":
      return createLogicalPolicyById(BASELINE_CENTRAL_DISPATCH_ID);
    case "F":
      return createLogicalPolicyById(BASELINE_FIXED_ROLES_ID);
  }
}

async function executeBaselines(argv: readonly string[], io: LabCliIo): Promise<void> {
  const options = parseOptions(argv, BASELINES_OPTIONS);
  if (options.help) {
    writeJson(io.stdout, {
      command: "baselines",
      status: "ok",
      usage: "anu lab baselines [--data-dir PATH] [--arms A,C,D,E,F] [config overrides]",
      arms: BASELINE_ARM_DESCRIPTIONS,
    });
    return;
  }

  const config = await configuredGenesis(options.values);
  // Pin one task realization for the whole comparison: every arm faces
  // byte-identical tasks and oracles, so metric gaps are attributable to the
  // architecture rather than to each arm drawing its own task luck.
  config.taskStream.realizationSeed ??= config.seed;
  const runsRoot = optionPath(options.values, "data-dir", DEFAULT_DATA_DIR);
  const arms = parseBaselineArmList(options.values.get("arms"));
  const shutdown = installRunAbortController();
  try {
    const runs: Array<{ arm: BaselineArm; description: string; configHash: string; summary: RunSummary }> = [];
    for (const arm of arms) {
      const armConfig = applyBaselineArm(structuredClone(config), arm);
      const policy = baselineArmPolicy(arm);
      const summary = await runGenesis({
        config: armConfig,
        runsRoot,
        universeId: BASELINE_ARM_UNIVERSES[arm],
        signal: shutdown.signal,
        ...(policy === undefined ? {} : { policy }),
      });
      runs.push({
        arm,
        description: BASELINE_ARM_DESCRIPTIONS[arm],
        configHash: hashValue(armConfig),
        summary,
      });
    }

    const comparison = {
      schemaVersion: 1,
      caveats: [
        "All arms face one pinned task realization (taskStream.realizationSeed), so metric gaps are attributable to the architecture, not to per-arm task luck.",
        "One run per arm: differences smaller than seed-to-seed variance are not interpretable. Compare across seeds before concluding.",
        "Arm F verification coverage is bounded by the observation physics: a tick producing more submissions than the public window (64) evicts the overflow before its only verifiable tick.",
      ],
      experimentId: config.experimentId,
      seed: config.seed,
      ticks: config.ticks,
      agents: config.agents,
      arms: runs.map((run) => ({
        arm: run.arm,
        description: run.description,
        universeId: run.summary.universeId,
        runId: run.summary.runId,
        configHash: run.configHash,
        metrics: run.summary.latestMetrics,
      })),
      pareto: analysePopulation(runs.map((run) => run.summary)),
    };
    const comparisonId = deterministicId(
      "baselines",
      config.seed,
      hashValue(config),
      arms.join(","),
    ).replace(":", "-");
    const directory = join(runsRoot, config.experimentId, "baselines", comparisonId);
    await mkdir(directory, { recursive: true });
    const path = join(directory, "comparison.json");
    await writeFile(path, canonicalJson(comparison), "utf8");
    writeJson(io.stdout, { command: "baselines", status: "completed", path, comparison });
  } catch (error) {
    if (error instanceof Error && /does not support deterministic resume/.test(error.message)) {
      // A previously interrupted control arm left a durable checkpoint that
      // baseline policies refuse to resume by design. Fail with the recovery
      // path instead of a bare engine error.
      throw new CliUsageError(
        "A control arm was interrupted earlier and cannot resume "
        + "(baseline policies fail closed on resume). Delete that arm's run directory "
        + `under ${runsRoot}/${config.experimentId}/ and rerun to redo the arm from genesis.`,
      );
    }
    if (!(error instanceof GenesisRunPausedError)) throw error;
    writeJson(io.stdout, {
      command: "baselines",
      status: "paused",
      runId: error.runId,
      universeId: error.universeId,
      tick: error.tick,
    });
  } finally {
    shutdown.cleanup();
  }
}

function parseBaselineArmList(raw: string | undefined): BaselineArm[] {
  const arms = (raw ?? "A,C,D,E,F")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => parseBaselineArm(part));
  if (arms.length === 0) throw new CliUsageError("--arms must name at least one arm");
  if (new Set(arms).size !== arms.length) throw new CliUsageError("--arms must not repeat an arm");
  return arms;
}

/**
 * Cohort A is the control arm and needs no port: it is the logical engine.
 * B and C need a provider, and refusing to invent one keeps a mislabelled run
 * from being recorded as cognitive evidence.
 */
function createCohortCognition(raw: string | undefined): CognitionPort | undefined {
  if (raw === undefined || raw === "A" || raw === "a") return undefined;
  const cohort = raw.toUpperCase();
  if (cohort !== "B" && cohort !== "C") throw new Error(`Unknown cohort ${raw}; expected A, B or C`);
  const apiKey = process.env.ANU_LLM_API_KEY;
  const baseUrl = process.env.ANU_LLM_BASE_URL;
  const model = process.env.ANU_LLM_MODEL;
  if (!baseUrl || !model) {
    throw new Error(`Cohort ${cohort} requires ANU_LLM_BASE_URL and ANU_LLM_MODEL`);
  }
  const router = new LlmRouter();
  router.register(new OpenAICompatibleProvider({
    baseUrl,
    defaultModel: model,
    ...(apiKey === undefined ? {} : { apiKey }),
    timeoutMs: 180_000,
  }));
  // The host disambiguates equally-named deployments on different providers;
  // the full URL stays out of the manifest, and the API key never goes near it.
  const host = new URL(baseUrl).host;
  return new LlmCognition({
    cohort,
    completion: router,
    model: `${model}@${host}`,
    agentsPerTick: positiveEnv("ANU_LLM_AGENTS_PER_TICK", 4),
    concurrency: positiveEnv("ANU_LLM_CONCURRENCY", 4),
    maxTokens: positiveEnv("ANU_LLM_MAX_TOKENS", 2_048),
  });
}

function positiveEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

async function executeReplay(argv: readonly string[], io: LabCliIo): Promise<void> {
  const options = parseOptions(argv, REPLAY_OPTIONS);
  if (options.help) {
    writeJson(io.stdout, {
      command: "replay",
      status: "ok",
      usage: "anu lab replay [--data-dir PATH] [--experiment genesis-1] [--universe-id U0001] [--run-id RUN_ID] [--until-tick N]",
    });
    return;
  }

  const runsRoot = optionPath(options.values, "data-dir", DEFAULT_DATA_DIR);
  const experimentId = optionExperiment(options.values);
  const universeId = optionUniverseId(options.values, "universe-id", DEFAULT_UNIVERSE_ID);
  const runId = optionalRunId(options.values);
  const untilTick = optionalInteger(options.values, "until-tick", 0, MAX_TICKS);
  const evidence = await EvidenceStore.openExisting(runsRoot, experimentId, universeId, runId);
  const manifest = await evidence.readManifest();
  const config = await evidence.readConfig();
  const replay = await ReplayEngine.replayFile(evidence.eventsPath, manifest, config, untilTick);
  writeJson(io.stdout, {
    command: "replay",
    status: "completed",
    manifest,
    replay,
  });
}

async function executeAttest(argv: readonly string[], io: LabCliIo): Promise<void> {
  const options = parseOptions(argv, ATTEST_OPTIONS);
  if (options.help) {
    writeJson(io.stdout, {
      command: "attest",
      status: "ok",
      usage: "anu lab attest [--data-dir PATH] [--experiment genesis-1] [--universe-id U0001] [--run-id RUN_ID]",
    });
    return;
  }

  const evidence = await openSelectedEvidence(options.values);
  const attestation = await attestRunEvidence(evidence);
  writeJson(io.stdout, {
    command: "attest",
    status: "completed",
    attestation,
  });
}

async function executeVerifyAttestation(argv: readonly string[], io: LabCliIo): Promise<void> {
  const options = parseOptions(argv, VERIFY_ATTESTATION_OPTIONS);
  if (options.help) {
    writeJson(io.stdout, {
      command: "verify-attestation",
      status: "ok",
      usage: "anu lab verify-attestation [--data-dir PATH] [--experiment genesis-1] [--universe-id U0001] [--run-id RUN_ID] --expected sha256:HASH",
    });
    return;
  }

  const expected = requiredSha256Commitment(options.values, "expected");
  const evidence = await openSelectedEvidence(options.values);
  const attestation = await verifyRunEvidenceAttestation(evidence, expected);
  writeJson(io.stdout, {
    command: "verify-attestation",
    status: "verified",
    attestation,
  });
}

async function openSelectedEvidence(
  options: ReadonlyMap<string, string>,
): Promise<EvidenceStore> {
  const runsRoot = optionPath(options, "data-dir", DEFAULT_DATA_DIR);
  const experimentId = optionExperiment(options);
  const universeId = optionUniverseId(options, "universe-id", DEFAULT_UNIVERSE_ID);
  const runId = optionalRunId(options);
  return EvidenceStore.openExisting(runsRoot, experimentId, universeId, runId);
}

async function executeServe(argv: readonly string[], io: LabCliIo): Promise<void> {
  const options = parseOptions(argv, SERVE_OPTIONS);
  if (options.help) {
    writeJson(io.stdout, {
      command: "serve",
      status: "ok",
      usage: "anu lab serve [--data-dir PATH] [--host HOST] [--port 0..65535] [--auth-token-file PATH]",
    });
    return;
  }

  const dataDir = optionPath(options.values, "data-dir", DEFAULT_DATA_DIR);
  const host = optionHost(options.values.get("host") ?? DEFAULT_OBSERVER_HOST);
  const port = optionInteger(options.values, "port", DEFAULT_OBSERVER_PORT, 0, 65_535);
  const authTokenFile = options.values.get("auth-token-file");
  const authToken = authTokenFile === undefined
    ? undefined
    : await readObserverAuthTokenFile(safePath(authTokenFile, "auth-token-file"));
  const server = await startObserverServer({
    dataDir,
    host,
    port,
    ...(authToken === undefined ? {} : { authToken }),
  });
  const address = server.address();
  const boundPort = address !== null && typeof address === "object" ? address.port : port;
  installObserverShutdown(server, io);
  writeJson(io.stdout, {
    command: "serve",
    status: "listening",
    authentication: authToken === undefined ? "none" : "bearer",
    host,
    port: boundPort,
  });
}

async function readObserverAuthTokenFile(path: string): Promise<string> {
  let file: FileHandle | undefined;
  let secretBytes: Buffer | undefined;
  try {
    const pathInfo = await lstat(path);
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) throw new Error("invalid");
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_AUTH_TOKEN_FILE_BYTES) throw new Error("invalid");

    const bytes = Buffer.alloc(MAX_AUTH_TOKEN_FILE_BYTES + 1);
    secretBytes = bytes;
    let offset = 0;
    while (offset <= MAX_AUTH_TOKEN_FILE_BYTES) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > MAX_AUTH_TOKEN_FILE_BYTES) throw new Error("invalid");
    const content = bytes.subarray(0, offset);
    if (!isUtf8(content)) throw new Error("invalid");

    let token = content.toString("utf8");
    if (token.endsWith("\r\n")) token = token.slice(0, -2);
    else if (token.endsWith("\n")) token = token.slice(0, -1);
    return token;
  } catch {
    throw new Error("Observer authentication token file could not be read or is invalid");
  } finally {
    secretBytes?.fill(0);
    await file?.close().catch(() => undefined);
  }
}

async function configuredGenesis(options: ReadonlyMap<string, string>): Promise<GenesisConfig> {
  const configPath = options.get("config");
  if (configPath !== undefined) await validateConfigPath(safePath(configPath, "config"));
  const config = await loadGenesisConfig(
    configPath === undefined ? undefined : safePath(configPath, "config"),
  );

  const requestedExperiment = options.get("experiment");
  if (requestedExperiment !== undefined && requestedExperiment !== config.experimentId) {
    throw new CliUsageError(
      `--experiment ${requestedExperiment} does not match config experiment ${config.experimentId}`,
    );
  }

  const agents = optionalInteger(options, "agents", 1, 10_000);
  const ticks = optionalInteger(options, "ticks", 1, MAX_TICKS);
  const metricEvery = optionalInteger(options, "metric-every", 1, MAX_TICKS);
  const checkpointEvery = optionalInteger(options, "checkpoint-every", 1, MAX_TICKS);
  const seed = options.get("seed");
  if (agents !== undefined) rebalanceTreasuryForAgents(config, agents);
  if (ticks !== undefined) config.ticks = ticks;
  if (metricEvery !== undefined) config.metricEvery = metricEvery;
  if (checkpointEvery !== undefined) config.checkpointEvery = checkpointEvery;
  if (seed !== undefined) config.seed = safeSeed(seed);
  validateGenesisConfig(config);
  return config;
}

/** Preserve the configured per-universe finite budget across topology overrides. */
function rebalanceTreasuryForAgents(config: GenesisConfig, nextAgents: number): void {
  if (nextAgents === config.agents) return;
  const nextTreasury = structuredClone(config.treasuryResources);

  for (const resource of RESOURCE_KINDS) {
    const initialPerAgent = config.initialResources[resource];
    const currentAllocated = initialPerAgent * config.agents;
    const total = currentAllocated + config.treasuryResources[resource];
    const nextAllocated = initialPerAgent * nextAgents;
    if (
      !Number.isSafeInteger(currentAllocated)
      || !Number.isSafeInteger(total)
      || !Number.isSafeInteger(nextAllocated)
    ) {
      throw new CliUsageError(`--agents makes the ${resource} budget exceed safe integer precision`);
    }
    const remaining = total - nextAllocated;
    if (remaining < 0) {
      throw new CliUsageError(`--agents exceeds the finite ${resource} budget`);
    }
    nextTreasury[resource] = remaining;
  }

  config.agents = nextAgents;
  config.treasuryResources = nextTreasury;
}

function parseOptions(argv: readonly string[], allowed: ReadonlySet<string>): ParsedOptions {
  const values = new Map<string, string>();
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--help" || argument === "-h") {
      if (help) throw new CliUsageError("Duplicate --help option");
      help = true;
      continue;
    }
    if (!argument.startsWith("--") || argument === "--") {
      throw new CliUsageError(`Unexpected positional argument: ${argument}`);
    }

    const equals = argument.indexOf("=");
    const name = argument.slice(2, equals < 0 ? undefined : equals);
    if (!allowed.has(name)) throw new CliUsageError(`Unknown option: --${name}`);
    if (values.has(name)) throw new CliUsageError(`Duplicate option: --${name}`);

    let value: string;
    if (equals >= 0) {
      value = argument.slice(equals + 1);
    } else {
      const following = argv[index + 1];
      if (following === undefined || following.startsWith("--")) {
        throw new CliUsageError(`Option --${name} requires a value`);
      }
      value = following;
      index += 1;
    }
    if (value.length === 0) throw new CliUsageError(`Option --${name} requires a non-empty value`);
    values.set(name, value);
  }

  if (help && values.size > 0) {
    throw new CliUsageError("--help cannot be combined with command options");
  }
  return { help, values };
}

function optionPath(
  options: ReadonlyMap<string, string>,
  name: string,
  fallback: string,
): string {
  return safePath(options.get(name) ?? fallback, name);
}

function safePath(value: string, label: string): string {
  if (value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES) {
    throw new CliUsageError(`--${label} is not a safe path`);
  }
  const absolute = resolve(value);
  if (absolute === parse(absolute).root) {
    throw new CliUsageError(`--${label} must not be a filesystem root`);
  }
  return absolute;
}

async function validateConfigPath(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new CliUsageError("--config must identify a regular non-symlink file");
  }
  if (info.size > MAX_CONFIG_BYTES) {
    throw new CliUsageError(`--config exceeds ${MAX_CONFIG_BYTES} bytes`);
  }
}

function optionExperiment(options: ReadonlyMap<string, string>): string {
  const experiment = options.get("experiment") ?? DEFAULT_EXPERIMENT_ID;
  if (experiment !== DEFAULT_EXPERIMENT_ID) {
    throw new CliUsageError(`Unsupported experiment: ${experiment}`);
  }
  return experiment;
}

function optionUniverseId(
  options: ReadonlyMap<string, string>,
  name: string,
  fallback: string,
): string {
  const value = options.get(name) ?? fallback;
  if (!/^U[0-9]{4,8}$/.test(value)) {
    throw new CliUsageError(`--${name} must match U0001-style notation`);
  }
  return value;
}

function optionalRunId(options: ReadonlyMap<string, string>): string | undefined {
  const value = options.get("run-id");
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) || value.includes("..")) {
    throw new CliUsageError("--run-id must be a safe evidence run identifier");
  }
  return value;
}

function requiredSha256Commitment(
  options: ReadonlyMap<string, string>,
  name: string,
): string {
  const value = options.get(name);
  if (value === undefined) throw new CliUsageError(`Option --${name} is required`);
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new CliUsageError(`--${name} must be sha256 followed by a lowercase 64-hex digest`);
  }
  return value;
}

function optionInteger(
  options: ReadonlyMap<string, string>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return parseInteger(options.get(name), name, minimum, maximum) ?? fallback;
}

function optionalInteger(
  options: ReadonlyMap<string, string>,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  return parseInteger(options.get(name), name, minimum, maximum);
}

function parseInteger(
  value: string | undefined,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new CliUsageError(`--${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new CliUsageError(`--${name} must be from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function safeSeed(seed: string): string {
  if (
    seed.trim().length === 0
    || Buffer.byteLength(seed, "utf8") > MAX_SEED_BYTES
    || /[\u0000-\u001f\u007f]/u.test(seed)
  ) {
    throw new CliUsageError("--seed must be a non-empty printable value no longer than 1024 bytes");
  }
  return seed;
}

function optionHost(host: string): string {
  if (
    host.length === 0
    || host.length > 255
    || !/^[A-Za-z0-9.:[\]_-]+$/.test(host)
  ) {
    throw new CliUsageError("--host must be a valid host name or IP address");
  }
  return host;
}

function installRunAbortController(): {
  signal: AbortSignal;
  cleanup(): void;
} {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  return {
    signal: controller.signal,
    cleanup: () => {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    },
  };
}

function installObserverShutdown(server: Server, io: LabCliIo): void {
  let stopping = false;
  let forceTimer: NodeJS.Timeout | undefined;

  const cleanup = (): void => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    if (forceTimer !== undefined) clearTimeout(forceTimer);
  };
  const shutdown = (signal: "SIGINT" | "SIGTERM"): void => {
    if (stopping) {
      server.closeAllConnections();
      return;
    }
    stopping = true;
    writeJson(io.stdout, { command: "serve", status: "stopping", signal });
    forceTimer = setTimeout(() => {
      process.exitCode = 1;
      writeJson(io.stderr, {
        command: "serve",
        status: "error",
        error: { code: "shutdown_timeout", message: "Observer shutdown exceeded 10 seconds" },
      });
      server.closeAllConnections();
    }, 10_000);
    forceTimer.unref();
    server.close((error?: Error) => {
      cleanup();
      if (error !== undefined) {
        process.exitCode = 1;
        writeJson(io.stderr, {
          command: "serve",
          status: "error",
          error: { code: "shutdown_failed", message: safeErrorMessage(error) },
        });
        return;
      }
      writeJson(io.stdout, { command: "serve", status: "stopped", signal });
    });
  };
  const onSigint = (): void => shutdown("SIGINT");
  const onSigterm = (): void => shutdown("SIGTERM");

  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  server.once("close", cleanup);
}

function usageFailure(io: LabCliIo, command: string, message: string): number {
  writeJson(io.stderr, {
    command,
    status: "error",
    error: { code: "invalid_usage", message },
  });
  return 2;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message.slice(0, 1_024).replace(/[\u0000-\u001f\u007f]/gu, " ");
  }
  return "Unknown command failure";
}

function writeJson(sink: JsonSink, value: unknown): void {
  sink.write(`${canonicalJson(value)}\n`);
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isDirectExecution()) {
  process.exitCode = await runLabCli(process.argv.slice(2));
}
