import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DEFAULT_GENESIS_CONFIG,
  LAB_COGNITIVE_ENGINE_VERSION,
  LAB_ENGINE_VERSION,
  LAB_EXPERIMENT_IDS,
  LAB_LIVE_ENGINE_VERSION,
  LAB_LIVE_POLICY_ID,
  LAB_LIVE_POLICY_PATTERN,
  LAB_LIVE_TASK_SOURCE_ID,
  LAB_POLICY_ID,
  LAB_TASK_GENERATOR_ID,
  LIVE_UNIVERSE_ID,
  LabProtocolVerifier,
  LogicalUniverse,
  ReplayEngine,
  assertCanaryUniverseId,
  assertLabManifestImplementation,
  canonicalJson,
  createGenesisAgents,
  createLiveEpochManifest,
  createRunManifest,
  hashValue,
  initialWorldState,
  isLiveManifest,
  runPopulation,
  validateGenesisConfig,
} from "../dist/lab/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedRoot = join(repositoryRoot, "experiments", "genesis-1", "expected");
const runnerPath = join(repositoryRoot, "dist", "lab", "runner.js");

function invoke(args, env = {}) {
  return spawnSync(process.execPath, [runnerPath, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 16 * 1024 * 1024,
  });
}

function lastJson(text) {
  const lines = text.trim().split("\n").filter(Boolean);
  assert.ok(lines.length > 0, "expected structured output");
  return JSON.parse(lines.at(-1));
}

function liveConfig() {
  return {
    ...structuredClone(DEFAULT_GENESIS_CONFIG),
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

test("the lab pins exactly three experiment identities and the live engine identity", () => {
  assert.deepEqual([...LAB_EXPERIMENT_IDS], ["genesis-1", "genesis-live", "genesis-live-canary"]);
  assert.equal(LAB_ENGINE_VERSION, "genesis-logical-v1.1.0");
  assert.equal(LAB_COGNITIVE_ENGINE_VERSION, "genesis-cognitive-v1.1.0");
  assert.equal(LAB_LIVE_ENGINE_VERSION, "genesis-live-v1.0.0");
  assert.equal(LAB_LIVE_POLICY_ID, "cohort-c-live-idle-v1");
  assert.ok(LAB_LIVE_POLICY_PATTERN.test(LAB_LIVE_POLICY_ID));
  assert.ok(!LAB_LIVE_POLICY_PATTERN.test("cohort-c-neutral-backpressure-v1"));
  assert.equal(LAB_LIVE_TASK_SOURCE_ID, "live-task-source-v1");
  assert.equal(LAB_TASK_GENERATOR_ID, "deterministic-task-stream-v1");
  assert.equal(LAB_POLICY_ID, "neutral-backpressure-v1");
  assert.equal(LIVE_UNIVERSE_ID, "U0001");
});

test("stateHash discipline: logical genesis is byte-identical to the pre-live fixtures", async () => {
  const manifest = createRunManifest(DEFAULT_GENESIS_CONFIG, "U0001");
  assert.equal(manifest.runId, "run-03c8dac61325e815a7b1d86516887723");
  const state = initialWorldState(manifest);
  const expectedState = await readFile(join(expectedRoot, "initial-world-state.canonical.json"), "utf8");
  assert.equal(canonicalJson(state), expectedState);
  assert.equal(hashValue(state), "a9f1599318d8e710539a004cd9b7fd2ae29f554f9c97585f97d56c1478af711c");
  assert.ok(!("mode" in state), "a logical state must not carry the live mode marker");
  assert.ok(!("counters" in state), "a logical state must not carry live counters");

  const agents = createGenesisAgents(DEFAULT_GENESIS_CONFIG);
  const expectedAgents = await readFile(join(expectedRoot, "genesis-agents.canonical.json"), "utf8");
  assert.equal(canonicalJson(agents), expectedAgents);
  assert.equal(hashValue(agents), "5ee9a0e57e54ba314d44ad39cc9b58602017a621d618eba2353ed95fd8c59bec");
});

test("'external' is a live-only literal outside the frozen task families", async () => {
  for (const relativePath of ["src/lab/config.ts", "src/lab/metrics.ts"]) {
    const text = await readFile(join(repositoryRoot, relativePath), "utf8");
    const match = /TASK_FAMILIES[^=]*=\s*(?:Object\.freeze\()?\[([^\]]*)\]/s.exec(text);
    assert.ok(match, `${relativePath} must declare TASK_FAMILIES`);
    const families = [...match[1].matchAll(/"([a-z_]+)"/g)].map((entry) => entry[1]);
    assert.equal(families.length, 8, relativePath);
    assert.ok(!families.includes("external"), `${relativePath} must not list external`);
  }
  const config = structuredClone(DEFAULT_GENESIS_CONFIG);
  config.taskStream.families.push("external");
  assert.throws(() => validateGenesisConfig(config), /Unknown task family external/);
});

test("live physics are validated only for genesis-live and refused elsewhere", () => {
  assert.doesNotThrow(() => validateGenesisConfig(liveConfig()));
  assert.throws(
    () => validateGenesisConfig({ ...structuredClone(DEFAULT_GENESIS_CONFIG), live: liveConfig().live }),
    /must not carry a live section/,
  );
  assert.throws(
    () => validateGenesisConfig({ ...structuredClone(DEFAULT_GENESIS_CONFIG), experimentId: "genesis-live-canary", live: liveConfig().live }),
    /must not carry a live section/,
  );
  assert.throws(
    () => validateGenesisConfig({ ...structuredClone(DEFAULT_GENESIS_CONFIG), experimentId: "genesis-live" }),
    /requires a live section/,
  );
  assert.throws(
    () => validateGenesisConfig({ ...structuredClone(DEFAULT_GENESIS_CONFIG), experimentId: "genesis-2" }),
    /Unsupported experiment genesis-2/,
  );
  const missingTier = liveConfig();
  delete missingTier.live.tiers.deliberate;
  assert.throws(() => validateGenesisConfig(missingTier), /Missing live tier deliberate/);
  const zeroPrice = liveConfig();
  zeroPrice.live.tiers.fast.pricePpm = 0;
  assert.throws(() => validateGenesisConfig(zeroPrice), /pricePpm must be a positive/);
  const unknownField = liveConfig();
  unknownField.live.models = ["kimi"];
  assert.throws(() => validateGenesisConfig(unknownField), /unknown field models/);
  const inherited = liveConfig();
  inherited.live.genesisFrom = {
    runId: "run-3ed209cf5feb4b39178c834e8a716312",
    tick: 500,
    seq: 12_000,
    eventHash: "a".repeat(64),
    stateHash: "b".repeat(64),
    runtimeHash: "c".repeat(64),
    genesisStateHash: "d".repeat(64),
  };
  assert.doesNotThrow(() => validateGenesisConfig(inherited));
  inherited.live.genesisFrom.eventHash = "not-a-digest";
  assert.throws(() => validateGenesisConfig(inherited), /genesisFrom.eventHash/);
});

test("a live epoch manifest comes from the shared builder and is refused by this build's projector", () => {
  const config = liveConfig();
  const manifest = createLiveEpochManifest(config, "U0001", { cognitionId: "cognition-live-v1:test:cb65536" });
  assert.equal(manifest.mode, "live");
  assert.equal(manifest.experimentId, "genesis-live");
  assert.equal(manifest.engineVersion, LAB_LIVE_ENGINE_VERSION);
  assert.equal(manifest.policyId, LAB_LIVE_POLICY_ID);
  assert.equal(manifest.taskGeneratorId, LAB_LIVE_TASK_SOURCE_ID);
  assert.equal(manifest.cognitionId, "cognition-live-v1:test:cb65536");
  assert.match(manifest.runId, /^run-[a-f0-9]{32}$/);
  assert.ok(isLiveManifest(manifest));
  assert.ok(!isLiveManifest(createRunManifest(DEFAULT_GENESIS_CONFIG, "U0001")));

  // The same builder with the same inputs yields the same identity; a
  // different cognition identity yields a different epoch run id.
  assert.equal(
    createLiveEpochManifest(config, "U0001", { cognitionId: "cognition-live-v1:test:cb65536" }).runId,
    manifest.runId,
  );
  assert.notEqual(
    createLiveEpochManifest(config, "U0001", { cognitionId: "cognition-live-v1:other:cb65536" }).runId,
    manifest.runId,
  );

  // Every projector of this build refuses live evidence fail-closed.
  assert.throws(() => assertLabManifestImplementation(manifest), /Unsupported lab execution mode live/);
  assert.throws(() => ReplayEngine.replay([], manifest, config), /Unsupported lab execution mode live/);
  assert.throws(() => new LabProtocolVerifier(manifest, config), /not verifiable by this engine build/);
  const recorder = { manifest, append() { throw new Error("unreachable"); } };
  assert.throws(() => new LogicalUniverse(manifest, config, recorder), /does not match this logical engine/);

  // Logical and cognitive identities still pass the same gate.
  assert.doesNotThrow(() => assertLabManifestImplementation(createRunManifest(DEFAULT_GENESIS_CONFIG, "U0001")));
  assert.doesNotThrow(() => assertLabManifestImplementation(createRunManifest(DEFAULT_GENESIS_CONFIG, "U0001", {
    mode: "cognitive",
    policyId: "cohort-c-neutral-backpressure-v1",
    cognitionId: "cognition-llm-c-v1:m@h:apt4:mt2048",
  })));
});

test("experiment, mode and policy literal imply each other", () => {
  const live = liveConfig();
  const canary = { ...structuredClone(DEFAULT_GENESIS_CONFIG), experimentId: "genesis-live-canary" };
  const cognitive = { mode: "cognitive", policyId: "cohort-c-neutral-backpressure-v1", cognitionId: "cognition-llm-c-v1:m@h:apt4:mt2048" };

  assert.throws(() => createRunManifest(live, "U0001"), /imply each other/);
  assert.throws(() => createRunManifest(live, "U0001", cognitive), /imply each other/);
  assert.throws(
    () => createRunManifest(DEFAULT_GENESIS_CONFIG, "U0001", { mode: "live", cognitionId: "cognition-live-v1:x:cb65536" }),
    /imply each other/,
  );
  assert.throws(() => createRunManifest(canary, "U0901"), /engineering canary/);
  const canaryManifest = createRunManifest(canary, "U0901", cognitive);
  assert.equal(canaryManifest.experimentId, "genesis-live-canary");
  assert.equal(canaryManifest.engineVersion, LAB_COGNITIVE_ENGINE_VERSION);
  assert.doesNotThrow(() => assertLabManifestImplementation(canaryManifest));

  assert.throws(
    () => createRunManifest(DEFAULT_GENESIS_CONFIG, "U0001", { ...cognitive, policyId: LAB_LIVE_POLICY_ID }),
    /reserved for mode live/,
  );
  assert.throws(
    () => createRunManifest(live, "U0001", { mode: "live", policyId: "cohort-c-neutral-backpressure-v1", cognitionId: "cognition-live-v1:x:cb65536" }),
    /requires policy cohort-c-live-idle-v1/,
  );
  assert.throws(() => createRunManifest(live, "U0001", { mode: "live" }), /Cognition id/);

  // A hand-made manifest with a foreign experiment is refused by the gate.
  assert.throws(
    () => assertLabManifestImplementation({ ...createRunManifest(DEFAULT_GENESIS_CONFIG, "U0001"), experimentId: "genesis-2" }),
    /Unsupported lab experimentId genesis-2/,
  );
  assert.throws(() => assertCanaryUniverseId("U0001"), /U0901 upwards/);
  assert.doesNotThrow(() => assertCanaryUniverseId("U0901"));
});

test("populations are reserved for the scientific identity", async (t) => {
  const runsRoot = await mkdtemp(join(tmpdir(), "anu-live-population-"));
  t.after(() => rm(runsRoot, { recursive: true, force: true }));
  const canary = { ...structuredClone(DEFAULT_GENESIS_CONFIG), experimentId: "genesis-live-canary", ticks: 1, agents: 1 };
  await assert.rejects(
    runPopulation({ config: canary, runsRoot, universes: 1, parallel: 1 }),
    /reserved for experiment genesis-1/,
  );
  await assert.rejects(
    runPopulation({ config: liveConfig(), runsRoot, universes: 1, parallel: 1 }),
    /reserved for experiment genesis-1/,
  );
});

test("the CLI refusal matrix keeps live identities off the scientific instruments", () => {
  const refusals = [
    [["population", "--experiment", "genesis-live"], /not allowed for population; allowed: genesis-1$/],
    [["population", "--experiment", "genesis-live-canary"], /not allowed for population/],
    [["run", "--experiment", "genesis-live"], /not allowed for run/],
    [["baselines", "--experiment", "genesis-live"], /not allowed for baselines; allowed: genesis-1$/],
    [["baselines", "--experiment", "genesis-live-canary"], /not allowed for baselines/],
    [["genesis-1", "--experiment", "genesis-live"], /not allowed for genesis-1; allowed: genesis-1, genesis-live-canary$/],
    [["genesis-1", "--experiment", "genesis-live-canary"], /requires --cohort B or C/],
    [["genesis-1", "--experiment", "genesis-live-canary", "--cohort", "A"], /requires --cohort B or C/],
    [["genesis-1", "--experiment", "genesis-live-canary", "--cohort", "C", "--arm", "D"], /runs arm A only/],
    [["genesis-1", "--experiment", "genesis-live-canary", "--cohort", "C", "--universe-id", "U0001"], /U0901 upwards/],
    [["genesis-1", "--experiment", "genesis-2"], /Unsupported experiment: genesis-2/],
    [["live", "--experiment", "genesis-1"], /not allowed for live; allowed: genesis-live$/],
    [["live", "--experiment", "genesis-live-canary"], /not allowed for live/],
    [["live"], /not implemented in this build/],
    [["live", "--experiment", "genesis-live"], /not implemented in this build/],
    [["replay", "--experiment", "genesis-2", "--data-dir", "runs"], /Unsupported experiment: genesis-2/],
    [["attest", "--experiment", "genesis-2", "--data-dir", "runs"], /Unsupported experiment: genesis-2/],
  ];
  for (const [args, pattern] of refusals) {
    const result = invoke(args);
    assert.equal(result.status, 2, `anu lab ${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.stdout, "");
    const error = lastJson(result.stderr);
    assert.equal(error.status, "error");
    assert.equal(error.error.code, "invalid_usage", args.join(" "));
    assert.match(error.error.message, pattern, args.join(" "));
  }

  // Evidence readers accept every registered identity: the refusal, if any,
  // is about missing evidence (exit 1), never about the identity (exit 2).
  for (const experiment of ["genesis-live", "genesis-live-canary"]) {
    const result = invoke(["replay", "--experiment", experiment, "--data-dir", join(tmpdir(), "anu-live-no-such-evidence")]);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(lastJson(result.stderr).error.code, "command_failed");
  }

  const help = invoke(["live", "--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(lastJson(help.stdout).usage, /^anu lab live /);
  assert.match(lastJson(invoke(["--help"]).stdout).commands.live, /Genesis-Live/);
});

test("the canary runs the cohort path under its own identity and never under genesis-1", async (t) => {
  const evidenceRoot = await mkdtemp(join(tmpdir(), "anu-live-canary-"));
  t.after(() => rm(evidenceRoot, { recursive: true, force: true }));
  const provider = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the request; the canary's prompt content is not retained here.
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "canary-test",
      choices: [{ message: { role: "assistant", content: JSON.stringify({ actions: [{ type: "observe" }] }) } }],
      usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 },
    }));
  });
  await new Promise((resolvePromise) => provider.listen(0, "127.0.0.1", resolvePromise));
  t.after(() => new Promise((resolvePromise) => provider.close(resolvePromise)));
  const env = {
    ANU_LLM_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`,
    ANU_LLM_MODEL: "canary-model",
    ANU_LLM_AGENTS_PER_TICK: "1",
    ANU_LLM_CONCURRENCY: "1",
    ANU_LLM_MAX_TOKENS: "64",
  };
  const child = spawn(process.execPath, [
    runnerPath, "genesis-1", "--experiment", "genesis-live-canary", "--cohort", "C",
    "--data-dir", evidenceRoot, "--agents", "1", "--ticks", "1", "--metric-every", "1", "--checkpoint-every", "1",
    "--seed", "first-light-test",
  ], { cwd: repositoryRoot, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [exitCode] = await once(child, "exit");
  assert.equal(exitCode, 0, stderr);
  const summary = lastJson(stdout).summary;
  assert.equal(summary.universeId, "U0901", "the canary defaults to the first canary universe");

  const runDirectory = join(evidenceRoot, "genesis-live-canary", "U0901", summary.runId);
  const manifest = JSON.parse(await readFile(join(runDirectory, "manifest.json"), "utf8"));
  assert.equal(manifest.experimentId, "genesis-live-canary");
  assert.equal(manifest.mode, "cognitive");
  assert.equal(manifest.engineVersion, LAB_COGNITIVE_ENGINE_VERSION);
  assert.match(manifest.policyId, /^cohort-c-/);
  const config = JSON.parse(await readFile(join(runDirectory, "config.json"), "utf8"));
  assert.equal(config.experimentId, "genesis-live-canary");
  assert.equal(config.live, undefined);
  await assert.rejects(readdir(join(evidenceRoot, "genesis-1")), { code: "ENOENT" });

  // The same physics under the scientific identity is a different run id, so
  // the canary can never recover — or be recovered by — genesis-1 evidence.
  const scientific = createRunManifest({ ...config, experimentId: "genesis-1" }, "U0901", {
    mode: "cognitive",
    policyId: manifest.policyId,
    cognitionId: manifest.cognitionId,
  });
  assert.notEqual(scientific.runId, manifest.runId);

  // Evidence readers accept the canary identity.
  const replay = invoke(["replay", "--experiment", "genesis-live-canary", "--universe-id", "U0901", "--data-dir", evidenceRoot]);
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(lastJson(replay.stdout).replay.state.tick, 1);
});

test("aggregate-arms refuses evidence that is not genesis-1", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "anu-live-aggregate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const comparisonDirectory = join(root, "baselines", "baselines-test");
  const runDirectory = join(root, "U0901", "run-canary");
  await mkdir(comparisonDirectory, { recursive: true });
  await mkdir(runDirectory, { recursive: true });
  await writeFile(join(runDirectory, "manifest.json"), JSON.stringify({ experimentId: "genesis-live-canary" }));
  await writeFile(join(runDirectory, "events.jsonl"), "");
  await writeFile(join(comparisonDirectory, "comparison.json"), JSON.stringify({
    seed: "s",
    arms: [{ arm: "A", universeId: "U0901", runId: "run-canary", metrics: { taskSuccessRatePpm: 0, p95LatencyTicks: 0 } }],
  }));
  const result = spawnSync(process.execPath, [
    join(repositoryRoot, "experiments", "genesis-1", "aggregate-arms.mjs"),
    join(comparisonDirectory, "comparison.json"),
  ], { cwd: repositoryRoot, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /genesis-live-canary is not scientific evidence/);
});

test("check-live-isolation regenerates the §33 fixtures and proves the scientific track unchanged", { timeout: 600_000 }, () => {
  const result = spawnSync(process.execPath, [
    join(repositoryRoot, ".github", "scripts", "check-live-isolation.mjs"), "--ticks", "200",
  ], { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  for (const universeId of ["U0001", "U0002", "U0003", "U0004", "U0005"]) {
    assert.match(result.stdout, new RegExp(`^ok   ${universeId} \\(arm [ACDEF], 200 ticks\\) matches expected/${universeId}\\.json$`, "m"));
  }
  assert.doesNotMatch(result.stdout, /^FAIL/m);
});
