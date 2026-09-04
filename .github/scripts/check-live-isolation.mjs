#!/usr/bin/env node
/**
 * Science guard for Genesis-Live (design §4.P; phase L0 first version, L9
 * makes it a permanent gate).
 *
 * The scientific track (`genesis-1`) must be byte-identical before and after
 * any Genesis-Live change. This script proves it mechanically, without
 * reading `runs/` (which is not in git and not in CI):
 *
 *  1. import graph — `src/lab/live/**` never reaches `src/core/*` runtime
 *     code, `src/runtime/*` or `src/v2/*`; `src/lab/*` never imports
 *     `src/core/link-protocol`, `src/runtime/*` or `src/v2/*`; the scientific
 *     instruments (`baselines`, `population`, `pareto`, `genesis`) never import
 *     `src/lab/live/*`;
 *  2. `initialWorldState(logical manifest)` and `createGenesisAgents` are
 *     byte-identical to the committed canonical fixtures;
 *  3. the frozen task-family list carries no `external`;
 *  4. a live manifest is refused by this build's projector and verifier;
 *  5. the CLI refuses the scientific instruments for live identities and the
 *     canary without a cohort;
 *  6. the five §33 logical runs U0001..U0005 are regenerated from the default
 *     config into a temporary directory and every hash is compared with
 *     `experiments/genesis-1/expected/U000{1..5}.json`.
 *
 * Usage: node .github/scripts/check-live-isolation.mjs [--ticks 600|200]
 *        [--parallel N] [--skip-regeneration]
 * Requires `npm run build` first (it executes `dist/`).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sourceRoot = join(repositoryRoot, "src");
const expectedRoot = join(repositoryRoot, "experiments", "genesis-1", "expected");
const runnerPath = join(repositoryRoot, "dist", "lab", "runner.js");
const SCIENCE_EXPERIMENT = "genesis-1";
const ARMS = Object.freeze({
  A: "U0001",
  C: "U0002",
  D: "U0003",
  E: "U0004",
  F: "U0005",
});

const options = parseArguments(process.argv.slice(2));
const failures = [];
const fail = (message) => failures.push(message);
const report = (label, ok, detail = "") => {
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}\n`);
  if (!ok) fail(`${label}${detail ? `: ${detail}` : ""}`);
};

try {
  await stat(runnerPath);
} catch {
  process.stderr.write("check-live-isolation: dist/ is missing; run `npm run build` first\n");
  process.exit(2);
}

const lab = await import(pathToFileURL(join(repositoryRoot, "dist", "lab", "index.js")).href);

await checkImportGraph();
await checkCanonicalFixtures();
await checkTaskFamilies();
checkLiveManifestRefusal();
checkCliAllowlist();
if (options.skipRegeneration) {
  process.stdout.write("skip regeneration of U0001..U0005 (--skip-regeneration)\n");
} else {
  await checkRegeneration();
}

if (failures.length > 0) {
  process.stderr.write(`\ncheck-live-isolation: ${failures.length} failure(s)\n`);
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exit(1);
}
process.stdout.write("\ncheck-live-isolation: the scientific track is isolated from Genesis-Live\n");

// ---------------------------------------------------------------------------

function parseArguments(argv) {
  const parsed = {
    ticks: Number(process.env.ANU_LIVE_ISOLATION_TICKS ?? 600),
    parallel: Math.max(1, Math.min(Object.keys(ARMS).length, availableParallelism())),
    skipRegeneration: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--skip-regeneration") {
      parsed.skipRegeneration = true;
    } else if (argument === "--ticks" || argument === "--parallel") {
      const value = Number(argv[index + 1]);
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${argument} requires a positive integer`);
      parsed[argument.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown option ${argument}`);
    }
  }
  return parsed;
}

async function listTypeScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listTypeScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) files.push(path);
  }
  return files.sort();
}

/** Parse `import`/`export … from` specifiers; type-only imports are marked so. */
function parseImports(text) {
  const imports = [];
  const pattern = /^\s*(import|export)\s+(type\s+)?[^;]*?\sfrom\s+["']([^"']+)["']/gms;
  for (const match of text.matchAll(pattern)) {
    const specifier = match[3];
    if (!specifier.startsWith(".")) continue;
    imports.push({ specifier, typeOnly: match[2] !== undefined });
  }
  const sideEffects = /^\s*import\s+["'](\.[^"']+)["']/gm;
  for (const match of text.matchAll(sideEffects)) imports.push({ specifier: match[1], typeOnly: false });
  return imports;
}

function resolveSpecifier(from, specifier) {
  const base = resolve(dirname(from), specifier);
  return base.endsWith(".js") ? `${base.slice(0, -3)}.ts` : base.endsWith(".ts") ? base : `${base}.ts`;
}

function posix(path) {
  return relative(repositoryRoot, path).split(sep).join("/");
}

async function checkImportGraph() {
  const files = await listTypeScriptFiles(sourceRoot);
  const graph = new Map();
  for (const file of files) {
    const text = await readFile(file, "utf8");
    graph.set(file, parseImports(text).map((entry) => ({ ...entry, target: resolveSpecifier(file, entry.specifier) })));
  }
  const isForbiddenForLive = (path) => (
    (path.startsWith("src/core/") && path !== "src/core/types.ts")
    || path.startsWith("src/runtime/")
    || path.startsWith("src/v2/")
  );
  const isForbiddenForLab = (path) => (
    path === "src/core/link-protocol.ts" || path.startsWith("src/runtime/") || path.startsWith("src/v2/")
  );

  const liveFiles = files.filter((file) => posix(file).startsWith("src/lab/live/"));
  let liveOk = true;
  for (const file of liveFiles) {
    for (const entry of graph.get(file)) {
      if (isForbiddenForLive(posix(entry.target))) {
        liveOk = false;
        fail(`${posix(file)} imports ${posix(entry.target)}`);
      }
    }
    const reachable = new Set();
    const stack = [file];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const entry of graph.get(current) ?? []) {
        if (entry.typeOnly || reachable.has(entry.target)) continue;
        reachable.add(entry.target);
        stack.push(entry.target);
      }
    }
    for (const target of reachable) {
      if (isForbiddenForLive(posix(target))) {
        liveOk = false;
        fail(`${posix(file)} reaches ${posix(target)} through value imports`);
      }
    }
  }
  report("src/lab/live/** imports no core runtime, runtime/ or v2/", liveOk, `${liveFiles.length} live file(s)`);

  let labOk = true;
  for (const file of files) {
    if (!posix(file).startsWith("src/lab/")) continue;
    for (const entry of graph.get(file)) {
      if (isForbiddenForLab(posix(entry.target))) {
        labOk = false;
        fail(`${posix(file)} imports ${posix(entry.target)}`);
      }
    }
  }
  report("src/lab/* imports no core/link-protocol, runtime/ or v2/", labOk);

  let scienceOk = true;
  for (const name of ["baselines", "population", "pareto", "genesis"]) {
    const file = join(sourceRoot, "lab", `${name}.ts`);
    const reachable = new Set();
    const stack = [file];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const entry of graph.get(current) ?? []) {
        if (reachable.has(entry.target)) continue;
        reachable.add(entry.target);
        stack.push(entry.target);
      }
    }
    for (const target of reachable) {
      if (posix(target).startsWith("src/lab/live/")) {
        scienceOk = false;
        fail(`src/lab/${name}.ts reaches ${posix(target)}`);
      }
    }
  }
  report("scientific instruments (baselines, population, pareto, genesis) never import src/lab/live/*", scienceOk);
}

async function checkCanonicalFixtures() {
  const manifest = lab.createRunManifest(lab.DEFAULT_GENESIS_CONFIG, "U0001");
  const state = lab.initialWorldState(manifest);
  const expectedState = await readFile(join(expectedRoot, "initial-world-state.canonical.json"), "utf8");
  report(
    "initialWorldState(logical manifest) is byte-identical to the fixture",
    lab.canonicalJson(state) === expectedState,
  );
  report(
    "a logical world state carries no live-only field",
    !("mode" in state) && !("counters" in state),
  );
  const agents = lab.createGenesisAgents(lab.DEFAULT_GENESIS_CONFIG);
  const expectedAgents = await readFile(join(expectedRoot, "genesis-agents.canonical.json"), "utf8");
  report("createGenesisAgents is byte-identical to the fixture", lab.canonicalJson(agents) === expectedAgents);
}

async function checkTaskFamilies() {
  for (const relativePath of ["src/lab/config.ts", "src/lab/metrics.ts"]) {
    const text = await readFile(join(repositoryRoot, relativePath), "utf8");
    const match = /TASK_FAMILIES[^=]*=\s*(?:Object\.freeze\()?\[([^\]]*)\]/s.exec(text);
    const families = match === null ? [] : [...match[1].matchAll(/"([a-z_]+)"/g)].map((entry) => entry[1]);
    report(
      `${relativePath} TASK_FAMILIES is the frozen list of eight families without "external"`,
      families.length === 8 && !families.includes("external"),
      families.join(","),
    );
  }
}

function liveConfig() {
  return {
    ...structuredClone(lab.DEFAULT_GENESIS_CONFIG),
    experimentId: "genesis-live",
    live: {
      epochTicks: 500,
      tiers: { fast: { pricePpm: 1_000_000 }, standard: { pricePpm: 3_000_000 }, deliberate: { pricePpm: 8_000_000 } },
      exhaustion: { minThinkTokens: 1_000, graceTicks: 10 },
      archive: { taskTicks: 200, messageTicks: 200, submissionTicks: 200 },
      fsyncEveryTick: true,
    },
  };
}

function checkLiveManifestRefusal() {
  const config = liveConfig();
  const manifest = lab.createLiveEpochManifest(config, "U0001", { cognitionId: "cognition-live-v1:guard:cb65536" });
  report(
    "a live manifest carries the live identity",
    manifest.mode === "live"
      && manifest.engineVersion === lab.LAB_LIVE_ENGINE_VERSION
      && manifest.experimentId === "genesis-live"
      && lab.LAB_LIVE_POLICY_PATTERN.test(manifest.policyId)
      && manifest.taskGeneratorId === lab.LAB_LIVE_TASK_SOURCE_ID,
  );
  report("the projector refuses a live manifest", throwsMatching(() => lab.assertLabManifestImplementation(manifest), /mode live/));
  report(
    "the replay engine refuses a live manifest",
    throwsMatching(() => lab.ReplayEngine.replay([], manifest, config), /mode live/),
  );
  report(
    "the protocol verifier refuses a live manifest",
    throwsMatching(() => new lab.LabProtocolVerifier(manifest, config), /not verifiable/),
  );
  report(
    "genesis-live cannot be projected as a logical run",
    throwsMatching(() => lab.createRunManifest(config, "U0001"), /imply each other/),
  );
  report(
    "the live policy literal is reserved for mode live",
    throwsMatching(
      () => lab.createRunManifest(lab.DEFAULT_GENESIS_CONFIG, "U0001", {
        mode: "cognitive",
        policyId: lab.LAB_LIVE_POLICY_ID,
        cognitionId: "cognition-llm-c-v1:m@h:apt4:mt2048",
      }),
      /reserved for mode live/,
    ),
  );
}

function throwsMatching(fn, pattern) {
  try {
    fn();
    return false;
  } catch (error) {
    return pattern.test(error instanceof Error ? error.message : String(error));
  }
}

function checkCliAllowlist() {
  const cases = [
    { args: ["population", "--experiment", "genesis-live"], pattern: /not allowed for population/ },
    { args: ["population", "--experiment", "genesis-live-canary"], pattern: /not allowed for population/ },
    { args: ["baselines", "--experiment", "genesis-live"], pattern: /not allowed for baselines/ },
    { args: ["baselines", "--experiment", "genesis-live-canary"], pattern: /not allowed for baselines/ },
    { args: ["genesis-1", "--experiment", "genesis-live"], pattern: /not allowed for genesis-1/ },
    { args: ["genesis-1", "--experiment", "genesis-live-canary"], pattern: /requires --cohort B or C/ },
    { args: ["live", "--experiment", "genesis-1"], pattern: /not allowed for live/ },
    { args: ["live", "--experiment", "genesis-live-canary"], pattern: /not allowed for live/ },
    { args: ["replay", "--experiment", "genesis-2"], pattern: /Unsupported experiment/ },
  ];
  let ok = true;
  for (const { args, pattern } of cases) {
    const result = spawnSync(process.execPath, [runnerPath, ...args], { cwd: repositoryRoot, encoding: "utf8" });
    let message = "";
    try {
      message = JSON.parse(result.stderr.trim().split("\n").at(-1)).error.message;
    } catch {
      message = result.stderr;
    }
    if (result.status !== 2 || !pattern.test(message)) {
      ok = false;
      fail(`anu lab ${args.join(" ")} → exit ${result.status}: ${message}`);
    }
  }
  report("CLI allowlist refuses live identities on the scientific instruments (exit 2)", ok, `${cases.length} cases`);
}

async function checkRegeneration() {
  const expected = new Map();
  for (const [arm, universeId] of Object.entries(ARMS)) {
    const fixture = JSON.parse(await readFile(join(expectedRoot, `${universeId}.json`), "utf8"));
    if (fixture.universeId !== universeId || fixture.arm !== arm || fixture.experimentId !== SCIENCE_EXPERIMENT) {
      throw new Error(`expected/${universeId}.json does not describe arm ${arm} of ${SCIENCE_EXPERIMENT}`);
    }
    const run = fixture.runs[String(options.ticks)];
    if (run === undefined) throw new Error(`expected/${universeId}.json has no fixture for ${options.ticks} ticks`);
    expected.set(arm, { fixture, run });
  }

  const workspace = await mkdtemp(join(tmpdir(), "anu-live-isolation-"));
  try {
    const first = expected.get("A").fixture;
    const config = structuredClone(lab.DEFAULT_GENESIS_CONFIG);
    config.seed = first.seed;
    config.agents = first.agents;
    config.ticks = options.ticks;
    config.taskStream.realizationSeed = first.realizationSeed;
    const configPath = join(workspace, "config.json");
    await writeFile(configPath, JSON.stringify(config));
    const runsRoot = join(workspace, "runs");

    const started = process.hrtime.bigint();
    const queue = Object.entries(ARMS);
    const outcomes = new Map();
    const worker = async () => {
      while (queue.length > 0) {
        const [arm, universeId] = queue.shift();
        outcomes.set(arm, await regenerateArm(arm, universeId, configPath, runsRoot));
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.parallel, queue.length) }, worker));
    const elapsedMs = Number((process.hrtime.bigint() - started) / 1_000_000n);

    for (const [arm, universeId] of Object.entries(ARMS)) {
      const { fixture, run } = expected.get(arm);
      const outcome = outcomes.get(arm);
      if (outcome.error !== undefined) {
        report(`${universeId} (arm ${arm}) regenerates`, false, outcome.error);
        continue;
      }
      const runDirectory = join(runsRoot, SCIENCE_EXPERIMENT, universeId, run.runId);
      let manifest;
      let summary;
      let attestation;
      try {
        manifest = JSON.parse(await readFile(join(runDirectory, "manifest.json"), "utf8"));
        summary = JSON.parse(await readFile(join(runDirectory, "summary.json"), "utf8"));
        attestation = JSON.parse(await readFile(join(runDirectory, "attestations", "final.json"), "utf8"));
      } catch (error) {
        report(`${universeId} (arm ${arm}) produced run ${run.runId}`, false, `${outcome.runId ?? "?"}: ${error.message}`);
        continue;
      }
      const differences = [];
      const compare = (label, actual, wanted) => {
        if (JSON.stringify(actual) !== JSON.stringify(wanted)) differences.push(`${label} ${JSON.stringify(actual)} ≠ ${JSON.stringify(wanted)}`);
      };
      compare("runId", summary.runId, run.runId);
      compare("configHash", manifest.configHash, run.configHash);
      compare("engineVersion", manifest.engineVersion, fixture.engineVersion);
      compare("mode", manifest.mode, fixture.mode);
      compare("policyId", manifest.policyId, fixture.policyId);
      compare("taskGeneratorId", manifest.taskGeneratorId, fixture.taskGeneratorId);
      compare("ticks", summary.ticks, run.ticks);
      compare("events", summary.events, run.events);
      compare("finalEventHash", summary.finalEventHash, run.finalEventHash);
      compare("finalStateHash", summary.finalStateHash, run.finalStateHash);
      compare("metricsHash", attestation.evidence.metricsHash, run.metricsHash);
      compare("commitment", attestation.commitment, run.commitment);
      compare("latestMetrics", lab.canonicalJson(summary.latestMetrics), lab.canonicalJson(run.latestMetrics));
      report(`${universeId} (arm ${arm}, ${run.ticks} ticks) matches expected/${universeId}.json`, differences.length === 0, differences.join("; "));
    }
    process.stdout.write(`regeneration of ${Object.keys(ARMS).length} runs × ${options.ticks} ticks took ${elapsedMs} ms (parallel ${options.parallel})\n`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function regenerateArm(arm, universeId, configPath, runsRoot) {
  return new Promise((resolveOutcome) => {
    const child = spawn(process.execPath, [
      runnerPath, "genesis-1", "--config", configPath, "--data-dir", runsRoot, "--arm", arm, "--universe-id", universeId,
    ], { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolveOutcome({ error: error.message }));
    child.on("exit", (code, signal) => {
      if (code !== 0) {
        resolveOutcome({ error: `exit ${code ?? signal}: ${stderr.trim().slice(0, 500)}` });
        return;
      }
      try {
        resolveOutcome({ runId: JSON.parse(stdout.trim().split("\n").at(-1)).summary.runId });
      } catch (error) {
        resolveOutcome({ error: `unparseable runner output: ${error.message}` });
      }
    });
  });
}
