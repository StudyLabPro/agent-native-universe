#!/usr/bin/env node
/**
 * Science guard for Genesis-Live (design §4.P; first version in phase L0,
 * permanent CI gate since phase L9).
 *
 * The scientific track (`genesis-1`) must be byte-identical before and after
 * any Genesis-Live change. This script proves it mechanically, without
 * reading `runs/` (which is not in git and not in CI):
 *
 *  0. build — `dist/` is rebuilt when it is missing or older than `src/`
 *     (`--build` forces a rebuild, `--no-build` refuses a stale build);
 *  1. import graph — `src/lab/live/**` never reaches `src/core/*` runtime
 *     code, `src/runtime/*` or `src/v2/*`; `src/lab/*` never imports
 *     `src/core/link-protocol`, `src/runtime/*` or `src/v2/*`; the scientific
 *     instruments (`baselines`, `population`, `pareto`, `genesis`) never import
 *     `src/lab/live/*`; Pareto readouts are computed only by the two gated
 *     instruments (`population.ts`, the `baselines` command in `runner.ts`);
 *  2. `initialWorldState(logical manifest)` and `createGenesisAgents` are
 *     byte-identical to the committed canonical fixtures;
 *  3. the frozen task-family list carries no `external`;
 *  4. `experiments/genesis-1/expected/U000{1..5}.json` describe the five
 *     logical §33 arms under the current logical engine;
 *  5. a live manifest is refused by this build's projector, replay engine and
 *     protocol verifier (in memory), and stored live evidence is refused by
 *     the evidence readers (`EvidenceStore.openExisting`, `anu lab replay`,
 *     `attest`, `verify-attestation`); a canary manifest planted under a
 *     `genesis-1` evidence tree is refused as well;
 *  6. the library instruments refuse live and canary configurations
 *     (`runPopulation`, `runGenesis` as a logical run or a control arm);
 *  7. the CLI refuses the scientific instruments for live identities — by
 *     `--experiment` and by `--config` — and the canary without a cohort,
 *     with a control arm, or with a population universe id;
 *  8. `experiments/genesis-1/aggregate-arms.mjs` filters
 *     `manifest.experimentId === "genesis-1"` (statically and at run time);
 *  9. `experiments/genesis-1/BASELINES.md` and the experiment config carry no
 *     live or canary evidence marker;
 * 10. the five §33 logical runs U0001..U0005 are regenerated from the default
 *     config into a temporary directory and every hash is compared with
 *     `experiments/genesis-1/expected/U000{1..5}.json`.
 *
 * Usage: node .github/scripts/check-live-isolation.mjs [--ticks 600|200]
 *        [--parallel N] [--skip-regeneration] [--build | --no-build]
 *
 * Exit codes: 0 isolated; 1 at least one check failed; 2 usage or build error.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sourceRoot = join(repositoryRoot, "src");
const experimentRoot = join(repositoryRoot, "experiments", "genesis-1");
const expectedRoot = join(experimentRoot, "expected");
const aggregateArmsPath = join(experimentRoot, "aggregate-arms.mjs");
const distRoot = join(repositoryRoot, "dist");
const runnerPath = join(distRoot, "lab", "runner.js");
const SCIENCE_EXPERIMENT = "genesis-1";
const LIVE_EXPERIMENT = "genesis-live";
const CANARY_EXPERIMENT = "genesis-live-canary";
const FIXTURE_TICKS = Object.freeze(["600", "200"]);
const ARMS = Object.freeze({
  A: "U0001",
  C: "U0002",
  D: "U0003",
  E: "U0004",
  F: "U0005",
});
/** The only source files allowed to compute a Pareto readout: both are gated to genesis-1. */
const PARETO_CONSUMERS = Object.freeze(["src/lab/population.ts", "src/lab/runner.ts"]);
/** A well-formed cognitive cognition id, as the cohort path would record it. */
const CANARY_COGNITION_ID = "cognition-llm-c-v1:m@h:apt4:mt2048";

const options = parseArguments(process.argv.slice(2));
const failures = [];
const fail = (message) => failures.push(message);
const report = (label, ok, detail = "") => {
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}\n`);
  if (!ok) fail(`${label}${detail ? `: ${detail}` : ""}`);
};

await ensureBuild();

const lab = await import(pathToFileURL(join(distRoot, "lab", "index.js")).href);
const workspace = await mkdtemp(join(tmpdir(), "anu-live-isolation-"));

try {
  await checkImportGraph();
  await checkCanonicalFixtures();
  await checkTaskFamilies();
  const fixtures = await checkFixtureIdentity();
  checkLiveManifestRefusal();
  await checkStoredEvidenceRefusal();
  await checkLibraryInstrumentRefusal();
  await checkCliAllowlist();
  await checkAggregateArmsFilter();
  await checkReadoutsCarryNoLiveEvidence();
  if (options.skipRegeneration) {
    process.stdout.write("skip regeneration of U0001..U0005 (--skip-regeneration)\n");
  } else {
    await checkRegeneration(fixtures);
  }
} finally {
  await rm(workspace, { recursive: true, force: true });
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
    /** "auto" rebuilds a missing or stale dist/; "always" and "never" are explicit. */
    build: "auto",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--skip-regeneration") {
      parsed.skipRegeneration = true;
    } else if (argument === "--build") {
      parsed.build = "always";
    } else if (argument === "--no-build") {
      parsed.build = "never";
    } else if (argument === "--ticks" || argument === "--parallel") {
      const value = Number(argv[index + 1]);
      if (!Number.isSafeInteger(value) || value < 1) usageError(`${argument} requires a positive integer`);
      parsed[argument.slice(2)] = value;
      index += 1;
    } else {
      usageError(`Unknown option ${argument}`);
    }
  }
  if (!Number.isSafeInteger(parsed.ticks) || parsed.ticks < 1) usageError("--ticks requires a positive integer");
  return parsed;
}

function usageError(message) {
  process.stderr.write(`check-live-isolation: ${message}\n`);
  process.exit(2);
}

/**
 * The gate builds: a stale `dist/` would check a superseded engine. `npm test`
 * and the PR gate build immediately before, so the default only rebuilds when
 * a source file is newer than the emitted runner.
 */
async function ensureBuild() {
  const emitted = [runnerPath, join(distRoot, "lab", "index.js")];
  let emittedMtime = Number.POSITIVE_INFINITY;
  let present = true;
  for (const file of emitted) {
    try {
      emittedMtime = Math.min(emittedMtime, (await stat(file)).mtimeMs);
    } catch {
      present = false;
    }
  }
  let sourceMtime = 0;
  for (const file of [...await listTypeScriptFiles(sourceRoot), join(repositoryRoot, "tsconfig.json")]) {
    sourceMtime = Math.max(sourceMtime, (await stat(file)).mtimeMs);
  }
  const stale = !present || sourceMtime > emittedMtime;
  const reason = !present ? "dist/ is missing" : stale ? "src/ is newer than dist/" : "dist/ is up to date";
  if (options.build === "never") {
    if (stale) usageError(`${reason}; run \`npm run build\` first (or drop --no-build)`);
    process.stdout.write(`build: ${reason} (--no-build)\n`);
    return;
  }
  if (options.build === "auto" && !stale) {
    process.stdout.write(`build: ${reason}; reusing it (--build forces a rebuild)\n`);
    return;
  }
  process.stdout.write(`build: ${reason}; running \`npm run build\`\n`);
  const npm = process.env.npm_execpath;
  const [command, args] = npm === undefined
    ? ["npm", ["run", "build"]]
    : [process.execPath, [npm, "run", "build"]];
  const result = spawnSync(command, args, { cwd: repositoryRoot, stdio: "inherit" });
  if (result.status !== 0) usageError(`\`npm run build\` failed with ${result.status ?? result.signal}`);
  try {
    await stat(runnerPath);
  } catch {
    usageError("dist/lab/runner.js is still missing after the build");
  }
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
  const texts = new Map();
  for (const file of files) {
    const text = await readFile(file, "utf8");
    texts.set(file, text);
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

  // A Pareto readout has no identity of its own (RunSummary carries no
  // experimentId), so live or canary summaries are kept out of it at the
  // callers: every consumer of the Pareto functions must be one of the two
  // instruments whose inputs are gated to genesis-1. A new call site is a
  // review event, not a silent extension.
  const paretoPattern = /\b(analysePopulation|toParetoPoints|paretoFrontier|paretoRanks|crowdingDistances|selectSurvivors)\s*\(/g;
  const paretoConsumers = [];
  for (const file of files) {
    const path = posix(file);
    if (path === "src/lab/pareto.ts") continue;
    const text = texts.get(file);
    const calls = [...text.matchAll(paretoPattern)];
    if (calls.length > 0) paretoConsumers.push(path);
  }
  const unexpected = paretoConsumers.filter((path) => !PARETO_CONSUMERS.includes(path));
  report(
    "Pareto readouts are computed only by the gated instruments (population, baselines)",
    unexpected.length === 0 && PARETO_CONSUMERS.every((path) => paretoConsumers.includes(path)),
    unexpected.length > 0 ? `unexpected consumer(s): ${unexpected.join(", ")}` : paretoConsumers.join(", "),
  );
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

/**
 * The fixtures are the reference of the regeneration; they must describe the
 * scientific identity under the engine this build carries, or a version bump
 * would be compared against stale evidence.
 */
async function checkFixtureIdentity() {
  const fixtures = new Map();
  const problems = [];
  for (const [arm, universeId] of Object.entries(ARMS)) {
    let fixture;
    try {
      fixture = JSON.parse(await readFile(join(expectedRoot, `${universeId}.json`), "utf8"));
    } catch (error) {
      problems.push(`${universeId}.json: ${error.message}`);
      continue;
    }
    const expect = (label, actual, wanted) => {
      if (actual !== wanted) problems.push(`${universeId}.json ${label} ${JSON.stringify(actual)} ≠ ${JSON.stringify(wanted)}`);
    };
    expect("universeId", fixture.universeId, universeId);
    expect("arm", fixture.arm, arm);
    expect("experimentId", fixture.experimentId, SCIENCE_EXPERIMENT);
    expect("mode", fixture.mode, "logical");
    expect("engineVersion", fixture.engineVersion, lab.LAB_ENGINE_VERSION);
    expect("taskGeneratorId", fixture.taskGeneratorId, lab.LAB_TASK_GENERATOR_ID);
    expect("schemaVersion", fixture.schemaVersion, lab.LAB_SCHEMA_VERSION);
    if (typeof fixture.policyId !== "string" || lab.LAB_LIVE_POLICY_PATTERN.test(fixture.policyId)) {
      problems.push(`${universeId}.json policyId ${JSON.stringify(fixture.policyId)} is not a logical policy`);
    }
    if (typeof fixture.seed !== "string" || fixture.seed.length === 0) problems.push(`${universeId}.json has no seed`);
    if (!Number.isSafeInteger(fixture.agents) || fixture.agents < 1) problems.push(`${universeId}.json has no agent count`);
    for (const ticks of FIXTURE_TICKS) {
      const run = fixture.runs?.[ticks];
      if (run === undefined) {
        problems.push(`${universeId}.json has no ${ticks}-tick run`);
        continue;
      }
      expect(`runs.${ticks}.ticks`, run.ticks, Number(ticks));
      for (const key of ["runId", "configHash", "finalEventHash", "finalStateHash", "metricsHash", "commitment"]) {
        if (typeof run[key] !== "string" || run[key].length === 0) problems.push(`${universeId}.json runs.${ticks}.${key} is missing`);
      }
      if (!Number.isSafeInteger(run.events) || run.events < 1) problems.push(`${universeId}.json runs.${ticks}.events is missing`);
      if (typeof run.latestMetrics !== "object" || run.latestMetrics === null) problems.push(`${universeId}.json runs.${ticks}.latestMetrics is missing`);
    }
    fixtures.set(arm, fixture);
  }
  report(
    "expected/U000{1..5}.json describe the five logical §33 arms under the current engine",
    problems.length === 0,
    problems.length === 0 ? `${lab.LAB_ENGINE_VERSION}, ${FIXTURE_TICKS.join("/")} ticks` : problems.join("; "),
  );
  return fixtures;
}

function liveConfig() {
  return {
    ...structuredClone(lab.DEFAULT_GENESIS_CONFIG),
    experimentId: LIVE_EXPERIMENT,
    live: {
      epochTicks: 500,
      tiers: { fast: { pricePpm: 1_000_000 }, standard: { pricePpm: 3_000_000 }, deliberate: { pricePpm: 8_000_000 } },
      exhaustion: { minThinkTokens: 1_000, graceTicks: 10 },
      archive: { taskTicks: 200, messageTicks: 200, submissionTicks: 200 },
      fsyncEveryTick: true,
    },
  };
}

function canaryConfig() {
  return { ...structuredClone(lab.DEFAULT_GENESIS_CONFIG), experimentId: CANARY_EXPERIMENT };
}

function checkLiveManifestRefusal() {
  const config = liveConfig();
  const manifest = lab.createLiveEpochManifest(config, "U0001", { cognitionId: "cognition-live-v1:guard:cb65536" });
  report(
    "a live manifest carries the live identity",
    manifest.mode === "live"
      && manifest.engineVersion === lab.LAB_LIVE_ENGINE_VERSION
      && manifest.experimentId === LIVE_EXPERIMENT
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
        cognitionId: CANARY_COGNITION_ID,
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

async function rejectsMatching(promiseFactory, pattern) {
  try {
    await promiseFactory();
    return false;
  } catch (error) {
    return pattern.test(error instanceof Error ? error.message : String(error));
  }
}

/** Write `<root>/<experiment>/<universe>/<runId>/{manifest,config}.json + events.jsonl`. */
async function plantEvidence(root, experimentDirectory, manifest, config) {
  const directory = join(root, experimentDirectory, manifest.universeId, manifest.runId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "manifest.json"), lab.canonicalJson(manifest));
  await writeFile(join(directory, "config.json"), lab.canonicalJson(config));
  await writeFile(join(directory, "events.jsonl"), "");
  return directory;
}

/**
 * Stored evidence is the surface the old verifiers actually read. A live run
 * directory must be refused by the readers of this build, and a canary
 * manifest can never be read through the `genesis-1` evidence tree.
 */
async function checkStoredEvidenceRefusal() {
  const root = join(workspace, "stored");
  const live = liveConfig();
  const liveManifest = lab.createLiveEpochManifest(live, "U0001", { cognitionId: "cognition-live-v1:guard:cb65536" });
  await plantEvidence(root, LIVE_EXPERIMENT, liveManifest, live);

  const problems = [];
  const stored = /unsupported implementation/;
  if (!await rejectsMatching(
    () => lab.EvidenceStore.openExisting(root, LIVE_EXPERIMENT, "U0001", liveManifest.runId),
    stored,
  )) problems.push("EvidenceStore.openExisting accepted stored live evidence");
  if (!await rejectsMatching(
    () => lab.EvidenceStore.openExisting(root, LIVE_EXPERIMENT, "U0001"),
    /No supported evidence runs/,
  )) problems.push("EvidenceStore.openExisting discovered stored live evidence as supported");

  const address = ["--data-dir", root, "--experiment", LIVE_EXPERIMENT, "--universe-id", "U0001", "--run-id", liveManifest.runId];
  const commitment = `sha256:${"0".repeat(64)}`;
  const cliCases = [
    { args: ["replay", ...address], pattern: stored },
    { args: ["attest", ...address], pattern: stored },
    { args: ["verify-attestation", ...address, "--expected", commitment], pattern: stored },
  ];
  for (const outcome of await runCliCases(cliCases)) {
    // Refusal of stored evidence is a command failure (exit 1), not a usage error.
    if (outcome.status !== 1 || !outcome.matched) {
      problems.push(`anu lab ${outcome.args[0]} on stored live evidence → exit ${outcome.status}: ${outcome.message}`);
    }
  }
  report(
    "stored live evidence is refused by the evidence readers (library and CLI)",
    problems.length === 0,
    problems.join("; "),
  );

  // A canary manifest planted under runs/genesis-1: the directory identity and
  // the manifest identity disagree, and the readers refuse rather than guess.
  const canary = canaryConfig();
  const canaryManifest = lab.createRunManifest(canary, "U0901", {
    mode: "cognitive",
    policyId: "cohort-c-neutral-backpressure-v1",
    cognitionId: CANARY_COGNITION_ID,
  });
  await plantEvidence(root, SCIENCE_EXPERIMENT, canaryManifest, canary);
  const planted = [];
  const mismatch = /does not match its evidence directory/;
  if (!await rejectsMatching(
    () => lab.EvidenceStore.openExisting(root, SCIENCE_EXPERIMENT, "U0901", canaryManifest.runId),
    mismatch,
  )) planted.push("EvidenceStore.openExisting read a canary manifest through the genesis-1 tree");
  const plantedAddress = ["--data-dir", root, "--experiment", SCIENCE_EXPERIMENT, "--universe-id", "U0901", "--run-id", canaryManifest.runId];
  for (const outcome of await runCliCases([{ args: ["replay", ...plantedAddress], pattern: mismatch }])) {
    if (outcome.status !== 1 || !outcome.matched) {
      planted.push(`anu lab replay on the planted canary → exit ${outcome.status}: ${outcome.message}`);
    }
  }
  report(
    "a canary manifest planted under runs/genesis-1 is refused by the evidence readers",
    planted.length === 0,
    planted.join("; "),
  );
}

/** The library instruments refuse before touching the disk. */
async function checkLibraryInstrumentRefusal() {
  const root = join(workspace, "library");
  await mkdir(root, { recursive: true });
  const problems = [];
  const reserved = /reserved for experiment genesis-1/;
  if (!await rejectsMatching(() => lab.runPopulation({ config: liveConfig(), runsRoot: root, universes: 1 }), reserved)) {
    problems.push("runPopulation accepted a genesis-live configuration");
  }
  if (!await rejectsMatching(() => lab.runPopulation({ config: canaryConfig(), runsRoot: root, universes: 1 }), reserved)) {
    problems.push("runPopulation accepted a genesis-live-canary configuration");
  }
  if (!await rejectsMatching(() => lab.runGenesis({ config: liveConfig(), runsRoot: root, universeId: "U0001" }), /imply each other/)) {
    problems.push("runGenesis accepted a genesis-live configuration as a logical run");
  }
  const canaryLogical = /engineering canary .* cannot run in mode logical/;
  if (!await rejectsMatching(() => lab.runGenesis({ config: canaryConfig(), runsRoot: root, universeId: "U0901" }), canaryLogical)) {
    problems.push("runGenesis accepted a genesis-live-canary configuration as a logical run");
  }
  if (!await rejectsMatching(
    () => lab.runGenesis({
      config: canaryConfig(),
      runsRoot: root,
      universeId: "U0901",
      policy: lab.createLogicalPolicyById(lab.BASELINE_NO_LINKS_ID),
    }),
    canaryLogical,
  )) problems.push("runGenesis accepted a genesis-live-canary configuration as a control arm");
  let written = [];
  try {
    written = await readdir(root);
  } catch {
    written = [];
  }
  if (written.length > 0) problems.push(`refused runs still wrote ${written.join(", ")}`);
  report(
    "runPopulation and runGenesis refuse live and canary configurations",
    problems.length === 0,
    problems.join("; "),
  );
}

/** Spawn `anu lab <args>` cases concurrently (bounded by --parallel) and collect exit + last JSON error. */
async function runCliCases(cases) {
  const queue = cases.map((entry, index) => ({ ...entry, index }));
  const outcomes = new Array(cases.length);
  const worker = async () => {
    while (queue.length > 0) {
      const entry = queue.shift();
      outcomes[entry.index] = await runCli(entry);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.parallel, cases.length) }, worker));
  return outcomes;
}

function runCli({ args, pattern, env }) {
  return new Promise((resolveOutcome) => {
    const child = spawn(process.execPath, [runnerPath, ...args], {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
      ...(env === undefined ? {} : { env }),
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stdout.resume();
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolveOutcome({ args, status: null, message: error.message, matched: false }));
    let status = null;
    child.on("exit", (code) => { status = code; });
    // `close`, not `exit`: the child's exit code is known before its stderr
    // pipe has drained in this process, and reading the refusal message at
    // `exit` intermittently sees an empty string and reports a refusal that
    // did happen as a failure.
    child.on("close", () => {
      let message = "";
      try {
        message = JSON.parse(stderr.trim().split("\n").at(-1)).error.message;
      } catch {
        message = stderr.trim();
      }
      resolveOutcome({ args, status, message, matched: pattern.test(message) });
    });
  });
}

async function checkCliAllowlist() {
  const configs = join(workspace, "configs");
  await mkdir(configs, { recursive: true });
  const livePath = join(configs, "genesis-live.json");
  const canaryPath = join(configs, "genesis-live-canary.json");
  const sciencePath = join(configs, "genesis-1.json");
  await writeFile(livePath, JSON.stringify(liveConfig()));
  await writeFile(canaryPath, JSON.stringify(canaryConfig()));
  await writeFile(sciencePath, JSON.stringify(lab.DEFAULT_GENESIS_CONFIG));

  const cases = [
    // By --experiment.
    { args: ["population", "--experiment", LIVE_EXPERIMENT], pattern: /not allowed for population/ },
    { args: ["population", "--experiment", CANARY_EXPERIMENT], pattern: /not allowed for population/ },
    { args: ["run", "--experiment", LIVE_EXPERIMENT], pattern: /not allowed for run/ },
    { args: ["baselines", "--experiment", LIVE_EXPERIMENT], pattern: /not allowed for baselines/ },
    { args: ["baselines", "--experiment", CANARY_EXPERIMENT], pattern: /not allowed for baselines/ },
    { args: ["genesis-1", "--experiment", LIVE_EXPERIMENT], pattern: /not allowed for genesis-1/ },
    { args: ["genesis-1", "--experiment", CANARY_EXPERIMENT], pattern: /requires --cohort B or C/ },
    { args: ["genesis-1", "--experiment", CANARY_EXPERIMENT, "--cohort", "A"], pattern: /requires --cohort B or C/ },
    { args: ["genesis-1", "--experiment", CANARY_EXPERIMENT, "--cohort", "C", "--arm", "D"], pattern: /runs arm A only/ },
    { args: ["genesis-1", "--experiment", CANARY_EXPERIMENT, "--cohort", "C", "--universe-id", "U0001"], pattern: /universe ids from U0901/ },
    { args: ["live", "--experiment", SCIENCE_EXPERIMENT], pattern: /not allowed for live/ },
    { args: ["live", "--experiment", CANARY_EXPERIMENT], pattern: /not allowed for live/ },
    { args: ["replay", "--experiment", "genesis-2"], pattern: /Unsupported experiment/ },
    // By --config: the identity in the file is refused exactly like the flag.
    { args: ["population", "--config", livePath], pattern: /not allowed for population/ },
    { args: ["population", "--config", canaryPath], pattern: /not allowed for population/ },
    { args: ["run", "--config", livePath], pattern: /not allowed for run/ },
    { args: ["baselines", "--config", livePath], pattern: /not allowed for baselines/ },
    { args: ["baselines", "--config", canaryPath], pattern: /not allowed for baselines/ },
    { args: ["genesis-1", "--config", livePath], pattern: /not allowed for genesis-1/ },
    { args: ["genesis-1", "--config", canaryPath], pattern: /requires --cohort B or C/ },
    { args: ["genesis-1", "--config", canaryPath, "--arm", "F"], pattern: /requires --cohort B or C/ },
    { args: ["live", "--config", canaryPath], pattern: /not allowed for live/ },
    { args: ["live", "--config", sciencePath], pattern: /not allowed for live/ },
    // A flag never relabels a file to the scientific identity.
    { args: ["population", "--experiment", SCIENCE_EXPERIMENT, "--config", livePath], pattern: /does not match config experiment genesis-live/ },
    { args: ["baselines", "--experiment", SCIENCE_EXPERIMENT, "--config", canaryPath], pattern: /does not match config experiment genesis-live-canary/ },
    { args: ["genesis-1", "--experiment", SCIENCE_EXPERIMENT, "--config", canaryPath], pattern: /does not match config experiment genesis-live-canary/ },
  ];
  let ok = true;
  for (const outcome of await runCliCases(cases)) {
    if (outcome.status !== 2 || !outcome.matched) {
      ok = false;
      fail(`anu lab ${outcome.args.map((argument) => (argument.startsWith(configs) ? relative(configs, argument) : argument)).join(" ")} → exit ${outcome.status}: ${outcome.message}`);
    }
  }
  report("CLI allowlist refuses live identities on the scientific instruments (exit 2)", ok, `${cases.length} cases`);

  // The allowlist proven in the other direction (phase L3c).
  //
  // Until L3c the `live` command was a registered identity gate in front of an
  // unimplemented supervisor, and "fails closed as not implemented" was a true
  // statement about it. L3c made the command real, so that half of the old
  // expectation is gone by construction. What must survive — and is asserted
  // here — is that the gate itself did not loosen: exactly one identity gets
  // through it, and the refusal the admitted identity then meets is about
  // deployment (no model tiers configured), never about who it is. Without
  // this case, a regression that let `live` accept `genesis-1` would only be
  // caught by the negative cases above; with it, the guard also fails if the
  // gate stops admitting the one identity it exists for.
  //
  // The environment is cleared of ANU_LIVE_* so an operator's shell cannot
  // change what this case observes.
  const cleanEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("ANU_LIVE_")),
  );
  const [admitted] = await runCliCases([{
    args: ["live", "--experiment", LIVE_EXPERIMENT, "--config", livePath],
    pattern: /requires the live tiers/,
    env: cleanEnvironment,
  }]);
  report(
    "the live command admits genesis-live and only genesis-live (exit 2 on deployment, not identity)",
    admitted.status === 2 && admitted.matched,
    `exit ${admitted.status}: ${admitted.message}`,
  );
}

/**
 * `aggregate-arms.mjs` folds several comparisons into one readout; it must
 * refuse any run whose manifest is not genesis-1 — by experiment identity, not
 * by mode, because the canary is cognitive too.
 */
async function checkAggregateArmsFilter() {
  const source = await readFile(aggregateArmsPath, "utf8");
  report(
    'aggregate-arms.mjs filters manifest.experimentId === "genesis-1" (source)',
    /manifest\.experimentId\s*!==\s*["']genesis-1["']/.test(source) && /manifest\.json/.test(source),
  );

  const root = join(workspace, "aggregate", SCIENCE_EXPERIMENT);
  const comparisons = join(root, "baselines");
  const runs = {
    science: { universeId: "U0001", runId: "run-science", experimentId: SCIENCE_EXPERIMENT },
    canary: { universeId: "U0901", runId: "run-canary", experimentId: CANARY_EXPERIMENT },
    live: { universeId: "U0001", runId: "run-live", experimentId: LIVE_EXPERIMENT },
  };
  for (const run of Object.values(runs)) {
    const directory = join(root, run.universeId, run.runId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ experimentId: run.experimentId }));
    await writeFile(join(directory, "events.jsonl"), "");
  }
  const comparisonFor = async (name, run) => {
    const directory = join(comparisons, name);
    await mkdir(directory, { recursive: true });
    const path = join(directory, "comparison.json");
    await writeFile(path, JSON.stringify({
      seed: "guard",
      arms: [{ arm: "A", universeId: run.universeId, runId: run.runId, metrics: { taskSuccessRatePpm: 0, p95LatencyTicks: 0 } }],
    }));
    return path;
  };
  const science = await comparisonFor("science", runs.science);
  const canary = await comparisonFor("canary", runs.canary);
  const live = await comparisonFor("live", runs.live);
  const aggregate = (paths) => spawnSync(process.execPath, [aggregateArmsPath, ...paths], { cwd: repositoryRoot, encoding: "utf8" });

  const problems = [];
  const accepted = aggregate([science]);
  let rows;
  try {
    rows = JSON.parse(accepted.stdout);
  } catch {
    rows = undefined;
  }
  if (accepted.status !== 0 || !Array.isArray(rows) || rows.length !== 1 || rows[0].arm !== "A") {
    problems.push(`genesis-1 evidence was not aggregated (exit ${accepted.status}): ${accepted.stderr.trim().slice(0, 200)}`);
  }
  for (const [label, path, experimentId] of [["canary", canary, CANARY_EXPERIMENT], ["live", live, LIVE_EXPERIMENT]]) {
    const refused = aggregate([science, path]);
    const expected = new RegExp(`${experimentId.replace(/-/g, "\\-")} is not scientific evidence`);
    if (refused.status === 0 || !expected.test(refused.stderr)) {
      problems.push(`${label} evidence was aggregated (exit ${refused.status}): ${refused.stderr.trim().slice(0, 200)}`);
    }
  }
  report("aggregate-arms.mjs refuses live and canary evidence at run time", problems.length === 0, problems.join("; "));
}

/**
 * The committed readouts and the experiment config are the last place live
 * evidence could leak into the science by hand. Identity markers are the
 * detectable trace: experiment ids in evidence paths, canary universe ids,
 * the live policy, task source and engine version.
 */
async function checkReadoutsCarryNoLiveEvidence() {
  const readout = await readFile(join(experimentRoot, "BASELINES.md"), "utf8");
  const markers = [
    [/genesis-live-canary/, "the canary experiment id"],
    [/genesis-live\//, "a live evidence path"],
    [/\bU09[0-9]{2}\b/, "a canary universe id"],
    [lab.LAB_LIVE_POLICY_ID, "the live policy id"],
    [lab.LAB_LIVE_TASK_SOURCE_ID, "the live task source id"],
    [lab.LAB_LIVE_ENGINE_VERSION, "the live engine version"],
    [lab.LAB_COGNITIVE_ENGINE_VERSION, "the cognitive engine version (a canary run)"],
  ];
  const found = markers
    .filter(([marker]) => (marker instanceof RegExp ? marker.test(readout) : readout.includes(marker)))
    .map(([, label]) => label);
  const config = JSON.parse(await readFile(join(experimentRoot, "config.json"), "utf8"));
  const configProblems = [];
  if (config.experimentId !== SCIENCE_EXPERIMENT) configProblems.push(`config.json experimentId ${JSON.stringify(config.experimentId)}`);
  if ("live" in config) configProblems.push("config.json carries a live section");
  report(
    "BASELINES.md and the experiment config carry no live or canary evidence marker",
    found.length === 0 && configProblems.length === 0,
    [...found.map((label) => `BASELINES.md contains ${label}`), ...configProblems].join("; "),
  );
}

async function checkRegeneration(fixtures) {
  const expected = new Map();
  for (const arm of Object.keys(ARMS)) {
    const fixture = fixtures.get(arm);
    const run = fixture?.runs?.[String(options.ticks)];
    if (fixture === undefined || run === undefined) {
      report(`${ARMS[arm]} (arm ${arm}) has a ${options.ticks}-tick fixture`, false);
      return;
    }
    expected.set(arm, { fixture, run });
  }

  const regeneration = join(workspace, "regeneration");
  await mkdir(regeneration, { recursive: true });
  const first = expected.get("A").fixture;
  const config = structuredClone(lab.DEFAULT_GENESIS_CONFIG);
  config.seed = first.seed;
  config.agents = first.agents;
  config.ticks = options.ticks;
  config.taskStream.realizationSeed = first.realizationSeed;
  const configPath = join(regeneration, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  const runsRoot = join(regeneration, "runs");

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
    compare("experimentId", manifest.experimentId, SCIENCE_EXPERIMENT);
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
