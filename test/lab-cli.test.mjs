import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { LlmGateway } from "../dist/lab/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function invoke(entrypoint, args) {
  return spawnSync(process.execPath, [entrypoint, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function parseSingleJson(text) {
  const lines = text.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1, text);
  return JSON.parse(lines[0]);
}

test("anu lab delegates to the strict structured runner without changing existing commands", () => {
  for (const flag of ["--version", "-v", "version"]) {
    const version = invoke("dist/cli/index.js", [flag]);
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout, "1.0.0\n");
  }
  const rootHelp = invoke("dist/cli/index.js", ["--help"]);
  assert.equal(rootHelp.status, 0, rootHelp.stderr);
  assert.match(rootHelp.stdout, /\bv1\.0\.0\b/);

  const help = invoke("dist/cli/index.js", ["lab", "--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.equal(parseSingleJson(help.stdout).status, "ok");

  const directHelp = invoke("dist/lab/runner.js", ["--help"]);
  assert.equal(directHelp.status, 0, directHelp.stderr);
  assert.equal(parseSingleJson(directHelp.stdout).usage, "anu lab <command> [options]");

  const gatewayHelp = invoke("dist/lab/runner.js", ["gateway", "--help"]);
  assert.equal(gatewayHelp.status, 0, gatewayHelp.stderr);
  assert.match(parseSingleJson(gatewayHelp.stdout).usage, /--api-key-file/);

  const invalid = invoke("dist/cli/index.js", ["lab", "population", "--universes", "01"]);
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, "");
  assert.deepEqual(parseSingleJson(invalid.stderr), {
    command: "population",
    status: "error",
    error: { code: "invalid_usage", message: "--universes must be an integer" },
  });

  const unknown = invoke("dist/lab/runner.js", ["serve", "--write", "yes"]);
  assert.equal(unknown.status, 2);
  assert.equal(parseSingleJson(unknown.stderr).error.code, "invalid_usage");

  const missingUpstream = invoke("dist/lab/runner.js", ["gateway"]);
  assert.equal(missingUpstream.status, 2);
  assert.match(parseSingleJson(missingUpstream.stderr).error.message, /requires --upstream/);

  const emptyModels = invoke("dist/lab/runner.js", [
    "gateway", "--upstream", "https://provider.example/v1", "--models=,,",
  ]);
  assert.equal(emptyModels.status, 2);
  assert.match(parseSingleJson(emptyModels.stderr).error.message, /non-empty model names/);

  const unsafeUpstream = invoke("dist/lab/runner.js", [
    "gateway", "--upstream", "http://provider.example/v1",
  ]);
  assert.equal(unsafeUpstream.status, 2);
  assert.match(parseSingleJson(unsafeUpstream.stderr).error.message, /must use HTTPS/);

  const principles = invoke("dist/cli/index.js", ["principles"]);
  assert.equal(principles.status, 0, principles.stderr);
  assert.match(principles.stdout, /Local worlds, explicit boundaries/);
});

test("run aliases population, conserves finite resources and produces replayable evidence", async (t) => {
  const evidenceRoot = await mkdtemp(join(tmpdir(), "anu-lab-cli-run-"));
  t.after(() => rm(evidenceRoot, { recursive: true, force: true }));

  const run = invoke("dist/cli/index.js", [
    "lab",
    "run",
    "--data-dir",
    evidenceRoot,
    "--universes",
    "2",
    "--parallel",
    "2",
    "--agents",
    "2",
    "--ticks",
    "1",
    "--metric-every",
    "1",
    "--checkpoint-every",
    "1",
    "--seed",
    "cli-test",
  ]);
  assert.equal(run.status, 0, run.stderr);
  const output = parseSingleJson(run.stdout);
  assert.equal(output.command, "run");
  assert.equal(output.mode, "population");
  assert.equal(output.status, "completed");
  assert.deepEqual(output.population.universes.map((summary) => summary.universeId), ["U0001", "U0002"]);

  for (const summary of output.population.universes) {
    const config = JSON.parse(await readFile(
      join(evidenceRoot, "genesis-1", summary.universeId, summary.runId, "config.json"),
      "utf8",
    ));
    assert.equal(config.agents, 2);
    assert.equal(config.initialResources.credits * config.agents + config.treasuryResources.credits, 100_000);
  }

  const replay = invoke("dist/lab/runner.js", [
    "replay",
    "--data-dir",
    evidenceRoot,
    "--universe-id",
    "U0001",
    "--until-tick",
    "1",
  ]);
  assert.equal(replay.status, 0, replay.stderr);
  const replayOutput = parseSingleJson(replay.stdout);
  assert.equal(replayOutput.status, "completed");
  assert.equal(replayOutput.replay.stateHash, output.population.universes[0].finalStateHash);
  assert.equal(replayOutput.replay.state.completed, true);

  const secondRun = invoke("dist/lab/runner.js", [
    "genesis-1",
    "--data-dir",
    evidenceRoot,
    "--universe-id",
    "U0001",
    "--agents",
    "2",
    "--ticks",
    "1",
    "--metric-every",
    "1",
    "--checkpoint-every",
    "1",
    "--seed",
    "cli-test-second-run",
  ]);
  assert.equal(secondRun.status, 0, secondRun.stderr);
  const secondSummary = parseSingleJson(secondRun.stdout).summary;
  assert.notEqual(secondSummary.runId, output.population.universes[0].runId);

  const ambiguousReplay = invoke("dist/lab/runner.js", [
    "replay",
    "--data-dir",
    evidenceRoot,
    "--universe-id",
    "U0001",
  ]);
  assert.equal(ambiguousReplay.status, 1);
  assert.match(
    parseSingleJson(ambiguousReplay.stderr).error.message,
    /Multiple supported evidence runs.*--run-id/,
  );

  const explicitReplay = invoke("dist/lab/runner.js", [
    "replay",
    "--data-dir",
    evidenceRoot,
    "--universe-id",
    "U0001",
    "--run-id",
    output.population.universes[0].runId,
  ]);
  assert.equal(explicitReplay.status, 0, explicitReplay.stderr);
  assert.equal(
    parseSingleJson(explicitReplay.stdout).replay.stateHash,
    output.population.universes[0].finalStateHash,
  );

  const unsafeReplay = invoke("dist/lab/runner.js", [
    "replay",
    "--data-dir",
    evidenceRoot,
    "--universe-id",
    "U0001",
    "--run-id",
    "../outside",
  ]);
  assert.equal(unsafeReplay.status, 2);
  assert.match(parseSingleJson(unsafeReplay.stderr).error.message, /safe evidence run identifier/);

  const impossiblePopulation = invoke("dist/lab/runner.js", [
    "population",
    "--data-dir",
    join(evidenceRoot, "impossible"),
    "--agents",
    "101",
  ]);
  assert.equal(impossiblePopulation.status, 2);
  assert.match(parseSingleJson(impossiblePopulation.stderr).error.message, /finite credits budget/);
});

test("population SIGTERM pauses a child at a durable boundary and the same command resumes", async (t) => {
  const evidenceRoot = await mkdtemp(join(tmpdir(), "anu-lab-cli-resume-"));
  t.after(() => rm(evidenceRoot, { recursive: true, force: true }));
  const args = [
    "dist/lab/runner.js",
    "population",
    "--data-dir",
    evidenceRoot,
    "--universes",
    "1",
    "--parallel",
    "1",
    "--agents",
    "8",
    "--ticks",
    "200",
    "--metric-every",
    "20",
    "--checkpoint-every",
    "20",
    "--seed",
    "cli-durable-resume",
  ];
  const child = spawn(process.execPath, args, {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  });
  assert.ok(child.stdout);
  assert.ok(child.stderr);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  await waitForWriterLease(evidenceRoot);
  assert.equal(child.kill("SIGTERM"), true);
  const [code, signal] = await once(child, "exit");
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
  const paused = parseSingleJson(stdout);
  assert.equal(paused.status, "paused");
  assert.deepEqual(paused.universes, ["U0001"]);

  const resumed = invoke(args[0], args.slice(1));
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(parseSingleJson(resumed.stdout).status, "completed");
});

async function waitForWriterLease(evidenceRoot) {
  const universeRoot = join(evidenceRoot, "genesis-1", "U0001");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      for (const runId of await readdir(universeRoot)) {
        try {
          await readFile(join(universeRoot, runId, ".runner.lock"), "utf8");
          return;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(10);
  }
  throw new Error("population worker lease did not appear before timeout");
}

test("serve binds all interfaces by default and closes gracefully on SIGTERM", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "anu-lab-cli-serve-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const dataDir = join(fixtureRoot, "data");
  await mkdir(dataDir);

  const child = spawn(
    process.execPath,
    ["dist/lab/runner.js", "serve", "--data-dir", dataDir, "--port", "0"],
    { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  });

  assert.ok(child.stdout);
  assert.ok(child.stderr);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const stdoutLines = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  const linesClosed = once(lines, "close");
  const listening = new Promise((resolveListening, rejectListening) => {
    const timeout = setTimeout(
      () => rejectListening(new Error(`observer did not listen; stderr=${stderr}`)),
      5_000,
    );
    lines.on("line", (line) => {
      const parsed = JSON.parse(line);
      stdoutLines.push(parsed);
      if (parsed.status === "listening") {
        clearTimeout(timeout);
        resolveListening(parsed);
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      rejectListening(new Error(`observer exited before listening: code=${code} signal=${signal} stderr=${stderr}`));
    });
  });

  const started = await listening;
  assert.equal(started.command, "serve");
  assert.equal(started.host, "0.0.0.0");
  assert.ok(Number.isInteger(started.port) && started.port > 0);
  const health = await fetch(`http://127.0.0.1:${started.port}/healthz`);
  assert.equal(health.status, 200);

  assert.equal(child.kill("SIGTERM"), true);
  const [exitCode, signal] = await once(child, "exit");
  await linesClosed;
  assert.equal(exitCode, 0, stderr);
  assert.equal(signal, null);
  assert.deepEqual(stdoutLines.map((line) => line.status), ["listening", "stopping", "stopped"]);
  assert.equal(stderr, "");
});

test("gateway reads its provider key from a file and closes with structured lifecycle output", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "anu-lab-cli-gateway-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const keyPath = join(fixtureRoot, "provider.key");
  const auditPath = join(fixtureRoot, "gateway.jsonl");
  const providerSecret = "sk-cli-provider-secret-must-not-appear";
  await writeFile(keyPath, `${providerSecret}\n`, { encoding: "utf8", mode: 0o600 });

  const child = spawn(
    process.execPath,
    [
      "dist/lab/runner.js",
      "gateway",
      "--upstream",
      "https://provider.example/v1",
      "--api-key-file",
      keyPath,
      "--models",
      "model-a",
      "--audit",
      auditPath,
      "--port",
      "0",
    ],
    { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  });

  assert.ok(child.stdout);
  assert.ok(child.stderr);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const stdoutLines = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  const linesClosed = once(lines, "close");
  const listening = new Promise((resolveListening, rejectListening) => {
    const timeout = setTimeout(
      () => rejectListening(new Error(`gateway did not listen; stderr=${stderr}`)),
      5_000,
    );
    lines.on("line", (line) => {
      const parsed = JSON.parse(line);
      stdoutLines.push(parsed);
      if (parsed.status === "listening") {
        clearTimeout(timeout);
        resolveListening(parsed);
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      rejectListening(new Error(`gateway exited before listening: code=${code} signal=${signal} stderr=${stderr}`));
    });
  });

  const started = await listening;
  assert.equal(started.command, "gateway");
  assert.equal(started.host, "127.0.0.1");
  assert.equal(started.upstreamCredential, "file");
  assert.ok(Number.isInteger(started.port) && started.port > 0);
  assert.equal((await fetch(`http://127.0.0.1:${started.port}/readyz`)).status, 200);

  assert.equal(child.kill("SIGTERM"), true);
  const [exitCode, signal] = await once(child, "exit");
  await linesClosed;
  const stdout = stdoutLines.map((line) => JSON.stringify(line)).join("\n");
  assert.equal(exitCode, 0, stderr);
  assert.equal(signal, null);
  assert.deepEqual(stdoutLines.map((line) => line.status), ["listening", "stopping", "stopped"]);
  assert.ok(!stdout.includes(providerSecret));
  assert.ok(!stderr.includes(providerSecret));
  assert.equal(stderr, "");
});

test("a cognitive CLI run binds the gateway upstream identity into its manifest", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "anu-lab-gateway-identity-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the bounded request; prompt content is intentionally not retained.
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "identity-test",
      choices: [{ message: { role: "assistant", content: JSON.stringify({ actions: [{ type: "observe" }] }) } }],
      usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 },
    }));
  });
  await new Promise((resolvePromise) => upstream.listen(0, "127.0.0.1", resolvePromise));
  const upstreamPort = upstream.address().port;
  const gatewayToken = "gateway-identity-token-0123456789abcdef";
  const gateway = new LlmGateway({
    upstreamUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    authToken: gatewayToken,
    allowedModels: ["model-a"],
  });
  const { port } = await gateway.listen(0);
  t.after(async () => {
    await gateway.close();
    await new Promise((resolvePromise) => upstream.close(resolvePromise));
  });
  const identity = await (await fetch(`http://127.0.0.1:${port}/identity`)).json();

  const child = spawn(
    process.execPath,
    [
      "dist/lab/runner.js",
      "genesis-1",
      "--cohort",
      "B",
      "--data-dir",
      fixtureRoot,
      "--agents",
      "1",
      "--ticks",
      "1",
      "--metric-every",
      "1",
      "--checkpoint-every",
      "1",
      "--seed",
      "gateway-identity-test",
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ANU_LLM_API_KEY: gatewayToken,
        ANU_LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
        ANU_LLM_IDENTITY_URL: `http://127.0.0.1:${port}/identity`,
        ANU_LLM_MODEL: "model-a",
        ANU_LLM_AGENTS_PER_TICK: "1",
        ANU_LLM_CONCURRENCY: "1",
        ANU_LLM_MAX_TOKENS: "64",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [exitCode, signal] = await once(child, "exit");
  assert.equal(exitCode, 0, stderr);
  assert.equal(signal, null);
  const summary = parseSingleJson(stdout).summary;
  const manifest = JSON.parse(await readFile(
    join(fixtureRoot, "genesis-1", "U0001", summary.runId, "manifest.json"),
    "utf8",
  ));
  assert.match(
    manifest.cognitionId,
    new RegExp(`^cognition-llm-b-v1:model-a@${identity.id}:apt1:mt64$`),
  );
});
