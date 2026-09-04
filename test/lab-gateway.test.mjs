import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LLM_GATEWAY_FATAL_EXIT_CODE, LlmGateway } from "../dist/lab/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SECRET_KEY = "sk-upstream-secret-000";
const SECRET_PROMPT = "the launch code is 0000";
const GATEWAY_TOKEN = "gateway-client-token-0123456789abcdef";

/** A scripted OpenAI-compatible upstream that records what it receives. */
async function startUpstream(handler) {
  const seen = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    seen.push({
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(body),
    });
    const reply = await handler?.(seen.length) ?? {
      id: "cmpl-1",
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40 },
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(reply));
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
  };
}

async function chat(port, body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, json: await response.json() };
}

async function waitFor(predicate) {
  while (!predicate()) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
}

test("the gateway forwards a completion and the client never holds the key", async (t) => {
  const upstream = await startUpstream();
  const gateway = new LlmGateway({ upstreamUrl: upstream.url, apiKey: SECRET_KEY });
  const { port } = await gateway.listen(0);
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });

  const result = await chat(port, { model: "kimi-k2-6", messages: [{ role: "user", content: "hi" }] });
  assert.equal(result.status, 200);
  assert.equal(result.json.choices[0].message.content, "ok");
  assert.match(result.headers.get("x-anu-gateway-identity"), /^gateway-v1-[a-f0-9]{32}$/);
  // The upstream saw the credential; the client request above never sent one.
  assert.equal(upstream.seen[0].authorization, `Bearer ${SECRET_KEY}`);
  assert.equal(upstream.seen[0].url, "/v1/chat/completions");
  assert.deepEqual(gateway.stats(), {
    requests: 1,
    forwarded: 1,
    denied: 0,
    inFlight: 0,
    totalTokens: 40,
    ready: true,
  });
});

test("the surface is a whitelist: unknown paths, streaming and bad JSON are refused", async (t) => {
  const upstream = await startUpstream();
  const gateway = new LlmGateway({ upstreamUrl: upstream.url });
  const { port } = await gateway.listen(0);
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });

  const embeddings = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, { method: "POST", body: "{}" });
  assert.equal(embeddings.status, 404);

  const streaming = await chat(port, { model: "m", stream: true, messages: [] });
  assert.equal(streaming.status, 400);
  assert.equal(streaming.json.error, "streaming_not_supported");

  const malformed = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    body: "not json",
  });
  assert.equal(malformed.status, 400);

  assert.equal(upstream.seen.length, 0, "nothing refused may reach the provider");
});

test("model whitelist and the accounted-token stop threshold are enforced", async (t) => {
  const upstream = await startUpstream();
  const gateway = new LlmGateway({
    upstreamUrl: upstream.url,
    allowedModels: ["kimi-k2-6"],
    maxTotalTokens: 10,
    maxRequests: 5,
  });
  const { port } = await gateway.listen(0);
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });

  const wrongModel = await chat(port, { model: "gpt-x", messages: [] });
  assert.equal(wrongModel.status, 403);
  assert.equal(wrongModel.json.error, "model_not_allowed");
  const identity = await (await fetch(`http://127.0.0.1:${port}/identity`)).json();
  assert.deepEqual(identity.models, ["kimi-k2-6"]);

  // A non-streaming gateway learns usage after the provider has already done
  // the work. The first response may cross the threshold; subsequent work is
  // stopped. The provider account remains the hard financial boundary.
  assert.equal((await chat(port, { model: "kimi-k2-6", messages: [] })).status, 200);
  const exhausted = await chat(port, { model: "kimi-k2-6", messages: [] });
  assert.equal(exhausted.status, 429);
  assert.equal(exhausted.json.error, "token_stop_threshold_reached");
  assert.equal(upstream.seen.length, 1, "an exhausted budget must stop forwarding");
});

test("the request budget and the sliding rate limit refuse before forwarding", async (t) => {
  const upstream = await startUpstream();
  let clock = 0;
  const gateway = new LlmGateway({
    upstreamUrl: upstream.url,
    maxRequests: 3,
    ratePerMinute: 2,
    now: () => clock,
  });
  const { port } = await gateway.listen(0);
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });

  assert.equal((await chat(port, { model: "m", messages: [] })).status, 200);
  assert.equal((await chat(port, { model: "m", messages: [] })).status, 200);
  const limited = await chat(port, { model: "m", messages: [] });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error, "rate_limited");

  // The window slides: a minute later the same request forwards again.
  clock += 60_001;
  assert.equal((await chat(port, { model: "m", messages: [] })).status, 200);
  assert.equal(upstream.seen.length, 3);
  const requestBudget = await chat(port, { model: "m", messages: [] });
  assert.equal(requestBudget.status, 429);
  assert.equal(requestBudget.json.error, "request_budget_exhausted");
});

test("a strong bearer token gates the gateway itself", async (t) => {
  const upstream = await startUpstream();
  const gateway = new LlmGateway({ upstreamUrl: upstream.url, authToken: GATEWAY_TOKEN });
  const { port } = await gateway.listen(0);
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });

  const anonymous = await chat(port, { model: "m", messages: [] });
  assert.equal(anonymous.status, 401);
  const wrong = await chat(port, { model: "m", messages: [] }, { authorization: "Bearer nope" });
  assert.equal(wrong.status, 401);
  const authorized = await chat(
    port,
    { model: "m", messages: [] },
    { authorization: `Bearer ${GATEWAY_TOKEN}` },
  );
  assert.equal(authorized.status, 200);
  assert.equal(upstream.seen.length, 1);
});

test("the audit log records decisions and metadata, never content or credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-gateway-"));
  const auditPath = join(directory, "audit", "gateway.jsonl");
  const upstream = await startUpstream();
  const gateway = new LlmGateway({
    upstreamUrl: upstream.url,
    apiKey: SECRET_KEY,
    allowedModels: ["kimi-k2-6"],
    auditPath,
  });
  const { port } = await gateway.listen(0);
  t.after(async () => {
    await gateway.close();
    await upstream.close();
    await rm(directory, { recursive: true, force: true });
  });

  await chat(port, { model: "kimi-k2-6", messages: [{ role: "user", content: SECRET_PROMPT }] });
  await chat(port, { model: "forbidden", messages: [{ role: "user", content: SECRET_PROMPT }] });

  const raw = await readFile(auditPath, "utf8");
  const entries = raw.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.length, 3);
  assert.equal(entries[0].decision, "attempted");
  assert.equal(entries[1].decision, "forwarded");
  assert.deepEqual(entries[1].usage, { promptTokens: 10, completionTokens: 30, totalTokens: 40 });
  assert.equal(entries[2].decision, "denied");
  assert.equal(entries[2].reason, "model_not_allowed");
  assert.ok(!raw.includes(SECRET_PROMPT), "audit must never contain message content");
  assert.ok(!raw.includes(SECRET_KEY), "audit must never contain the provider credential");
});

test("health and readiness probes expose no counters and do not consume budgets", async (t) => {
  const upstream = await startUpstream();
  const gateway = new LlmGateway({ upstreamUrl: upstream.url, maxRequests: 1 });
  const { port } = await gateway.listen(0);
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });

  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: "ready" });
  const identity = await fetch(`http://127.0.0.1:${port}/identity`);
  assert.equal(identity.status, 200);
  const identityBody = await identity.json();
  assert.equal(identityBody.schemaVersion, 1);
  assert.match(identityBody.id, /^gateway-v1-[a-f0-9]{32}$/);
  assert.equal(identityBody.models, "any");
  assert.equal((await chat(port, { model: "m", messages: [] })).status, 200);
});

test("an oversized request receives 413 without reaching the provider", async (t) => {
  const upstream = await startUpstream();
  const gateway = new LlmGateway({ upstreamUrl: upstream.url });
  const { port } = await gateway.listen(0);
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });

  const result = await chat(port, {
    model: "m",
    messages: [{ role: "user", content: "x".repeat(1_048_576) }],
  });
  assert.equal(result.status, 413);
  assert.equal(result.json.error, "request_too_large");
  assert.equal(upstream.seen.length, 0);
});

test("missing or invalid successful usage fails closed and degrades readiness", async (t) => {
  const upstream = await startUpstream(() => ({
    id: "unmetered",
    choices: [{ message: { role: "assistant", content: "not accountable" } }],
    usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: -1 },
  }));
  const gateway = new LlmGateway({ upstreamUrl: upstream.url });
  const { port } = await gateway.listen(0);
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });

  const invalid = await chat(port, { model: "m", messages: [] });
  assert.equal(invalid.status, 502);
  assert.equal(invalid.json.error, "upstream_usage_invalid");
  const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
  assert.equal(ready.status, 503);
  const refused = await chat(port, { model: "m", messages: [] });
  assert.equal(refused.status, 503);
  assert.equal(refused.json.error, "metering_unavailable");
  assert.equal(upstream.seen.length, 1);
});

test("upstream responses and simultaneous calls are bounded", async (t) => {
  let releaseFirst;
  const firstBlocked = new Promise((resolvePromise) => { releaseFirst = resolvePromise; });
  const upstream = await startUpstream(async (requestNumber) => {
    if (requestNumber === 1) await firstBlocked;
    return {
      id: `cmpl-${requestNumber}`,
      choices: [{ message: { role: "assistant", content: "x".repeat(512) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  });
  const gateway = new LlmGateway({
    upstreamUrl: upstream.url,
    maxInFlight: 1,
    maxResponseBytes: 256,
  });
  const { port } = await gateway.listen(0);
  t.after(async () => {
    releaseFirst();
    await gateway.close();
    await upstream.close();
  });

  const first = chat(port, { model: "m", messages: [] });
  while (upstream.seen.length === 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
  const concurrent = await chat(port, { model: "m", messages: [] });
  assert.equal(concurrent.status, 429);
  assert.equal(concurrent.json.error, "too_many_in_flight");
  releaseFirst();
  const oversized = await first;
  assert.equal(oversized.status, 502);
  assert.equal(oversized.json.error, "upstream_response_too_large");
  assert.equal(upstream.seen.length, 1);
});

test("configuration rejects weak auth, unsafe URLs and unauthenticated public binds", async () => {
  assert.throws(
    () => new LlmGateway({ upstreamUrl: "https://provider.example/v1", authToken: "short" }),
    /32\.\.4096 bytes/,
  );
  assert.throws(
    () => new LlmGateway({ upstreamUrl: "http://provider.example/v1" }),
    /must use HTTPS/,
  );
  assert.throws(
    () => new LlmGateway({ upstreamUrl: "http://127.attacker.example/v1" }),
    /must use HTTPS/,
  );
  assert.throws(
    () => new LlmGateway({ upstreamUrl: "https://key@provider.example/v1?secret=yes" }),
    /must not contain credentials/,
  );
  const gateway = new LlmGateway({ upstreamUrl: "https://provider.example/v1" });
  await assert.rejects(() => gateway.listen(0, "0.0.0.0"), /non-loopback bind/);
});

test("audit failure stops a request before provider egress and degrades readiness", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-gateway-audit-failure-"));
  const auditPath = join(directory, "gateway.jsonl");
  const upstream = await startUpstream();
  const gateway = new LlmGateway({ upstreamUrl: upstream.url, auditPath });
  const { port } = await gateway.listen(0);
  t.after(async () => {
    await gateway.close();
    await upstream.close();
    await rm(directory, { recursive: true, force: true });
  });

  await rm(auditPath);
  await mkdir(auditPath);
  const response = await chat(port, { model: "m", messages: [] });
  assert.equal(response.status, 503);
  assert.equal(response.json.error, "audit_unavailable");
  assert.equal(upstream.seen.length, 0);
  assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).status, 503);
});

/* ------------------------------------------------------------------ */
/* Hardening: audit rotation, persisted state, sliding-window budgets, */
/* the metering-failure-mode exit path (L1a)                          */
/* ------------------------------------------------------------------ */

test("audit rotation keeps a bounded number of rotated files instead of failing closed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-gateway-rotate-"));
  const auditPath = join(directory, "gateway.jsonl");
  const upstream = await startUpstream();
  const gateway = new LlmGateway({
    upstreamUrl: upstream.url,
    auditPath,
    maxAuditBytes: 400,
    auditRotate: 2,
  });
  const { port } = await gateway.listen(0);
  t.after(async () => {
    await gateway.close();
    await upstream.close();
    await rm(directory, { recursive: true, force: true });
  });

  for (let index = 0; index < 15; index += 1) {
    assert.equal((await chat(port, { model: "m", messages: [] })).status, 200);
  }

  const active = await readFile(auditPath, "utf8");
  assert.ok(active.length > 0, "the active audit file must still be written to");
  const rotated1 = await readFile(`${auditPath}.1`, "utf8");
  assert.ok(rotated1.length > 0, "the most recently rotated file must exist");
  await assert.rejects(readFile(`${auditPath}.3`), { code: "ENOENT" }, "only auditRotate files are kept");

  // A gateway that fails closed at the same size would refuse by now; this
  // one keeps accepting requests because rotation, not refusal, is the policy.
  assert.equal((await chat(port, { model: "m", messages: [] })).status, 200);
});

test("--state-file persists counters across listen()/close() and a restart continues the same budget", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-gateway-state-"));
  const stateFile = join(directory, "gateway-state.json");
  const upstream = await startUpstream();
  t.after(async () => {
    await upstream.close();
    await rm(directory, { recursive: true, force: true });
  });

  const first = new LlmGateway({ upstreamUrl: upstream.url, stateFile });
  const opened = await first.listen(0);
  assert.equal((await chat(opened.port, { model: "m", messages: [] })).status, 200);
  assert.equal((await chat(opened.port, { model: "m", messages: [] })).status, 200);
  assert.equal(first.stats().totalTokens, 80);
  assert.equal(first.stats().forwarded, 2);
  await first.close();

  const persisted = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(persisted.schemaVersion, 1);
  assert.equal(persisted.totalTokens, 80);
  assert.equal(persisted.forwarded, 2);

  // A fresh instance, same upstream (so the same gateway identity), loads the
  // persisted counters in listen() — before it has served a single request.
  const restarted = new LlmGateway({ upstreamUrl: upstream.url, stateFile });
  const reopened = await restarted.listen(0);
  t.after(() => restarted.close());
  assert.equal(restarted.stats().totalTokens, 80, "counters must be restored before the first request");
  assert.equal(restarted.stats().forwarded, 2);
  assert.equal((await chat(reopened.port, { model: "m", messages: [] })).status, 200);
  assert.equal(restarted.stats().totalTokens, 120, "a restart continues the same budget, it does not reset it");
});

test("a state file from a different upstream is refused rather than silently adopted", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-gateway-state-mismatch-"));
  const stateFile = join(directory, "gateway-state.json");
  const upstreamA = await startUpstream();
  const upstreamB = await startUpstream();
  t.after(async () => {
    await upstreamA.close();
    await upstreamB.close();
    await rm(directory, { recursive: true, force: true });
  });

  const gatewayA = new LlmGateway({ upstreamUrl: upstreamA.url, stateFile });
  await gatewayA.listen(0);
  await gatewayA.close();

  const gatewayB = new LlmGateway({ upstreamUrl: upstreamB.url, stateFile });
  await assert.rejects(gatewayB.listen(0), /belongs to another gateway configuration/);
});

test("a sliding token-per-window budget refuses at the threshold and recovers as the window slides", async (t) => {
  const upstream = await startUpstream();
  let clock = 0;
  const gateway = new LlmGateway({
    upstreamUrl: upstream.url,
    budgetWindowMs: 60_000,
    maxTokensPerWindow: 80,
    now: () => clock,
  });
  const { port } = await gateway.listen(0);
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });

  assert.equal((await chat(port, { model: "m", messages: [] })).status, 200);
  assert.equal((await chat(port, { model: "m", messages: [] })).status, 200);
  const exhausted = await chat(port, { model: "m", messages: [] });
  assert.equal(exhausted.status, 429);
  assert.equal(exhausted.json.error, "token_window_exhausted");
  assert.equal(upstream.seen.length, 2, "a window refusal must never reach the provider");

  // The window slides: past its length, the same request forwards again.
  clock += 60_001;
  assert.equal((await chat(port, { model: "m", messages: [] })).status, 200);
  assert.equal(upstream.seen.length, 3);
});

test("a sliding request-per-window budget refuses at the threshold and recovers as the window slides", async (t) => {
  const upstream = await startUpstream();
  let clock = 0;
  const gateway = new LlmGateway({
    upstreamUrl: upstream.url,
    budgetWindowMs: 60_000,
    maxRequestsPerWindow: 2,
    now: () => clock,
  });
  const { port } = await gateway.listen(0);
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });

  assert.equal((await chat(port, { model: "m", messages: [] })).status, 200);
  assert.equal((await chat(port, { model: "m", messages: [] })).status, 200);
  const exhausted = await chat(port, { model: "m", messages: [] });
  assert.equal(exhausted.status, 429);
  assert.equal(exhausted.json.error, "request_window_exhausted");

  clock += 60_001;
  assert.equal((await chat(port, { model: "m", messages: [] })).status, 200);
  assert.equal(upstream.seen.length, 3);
});

test("--metering-failure-mode exit persists the last metered response before reporting the fatal reason", async (t) => {
  const upstream = await startUpstream((requestNumber) => (requestNumber === 1
    ? {
      id: "cmpl-1",
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40 },
    }
    : {
      id: "cmpl-2",
      choices: [{ message: { role: "assistant", content: "not accountable" } }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: -1 },
    }));
  const directory = await mkdtemp(join(tmpdir(), "anu-gateway-exit-"));
  const stateFile = join(directory, "gateway-state.json");
  const fatal = [];
  const gateway = new LlmGateway({
    upstreamUrl: upstream.url,
    stateFile,
    meteringFailureMode: "exit",
    onFatal: (reason) => fatal.push(reason),
  });
  const { port } = await gateway.listen(0);
  t.after(async () => {
    await gateway.close();
    await upstream.close();
    await rm(directory, { recursive: true, force: true });
  });

  assert.equal((await chat(port, { model: "m", messages: [] })).status, 200);
  const second = await chat(port, { model: "m", messages: [] });
  assert.equal(second.status, 502);
  assert.equal(second.json.error, "upstream_usage_invalid");

  // onFatal fires only once the failing response has already been sent.
  await waitFor(() => fatal.length > 0);
  assert.deepEqual(fatal, ["metering_unavailable"]);
  // Latched from here regardless of mode: exit hands off to the supervisor,
  // it does not keep answering with degraded accounting in the meantime.
  assert.equal((await chat(port, { model: "m", messages: [] })).status, 503);

  const persisted = JSON.parse(await readFile(stateFile, "utf8"));
  // forwarded counts requests sent upstream, including the one whose usage
  // turned out to be unaccountable; totalTokens only ever grows from usage
  // the gateway could actually trust.
  assert.equal(persisted.totalTokens, 40, "only the successfully metered response is on record");
  assert.equal(persisted.forwarded, 2);

  await gateway.close();
  const restarted = new LlmGateway({ upstreamUrl: upstream.url, stateFile });
  await restarted.listen(0);
  t.after(() => restarted.close());
  assert.equal(restarted.stats().totalTokens, 40, "a restart continues the persisted budget, not a fresh one");
});

test("a response over --max-response-bytes takes the same fatal path as an unmetered response", async (t) => {
  const upstream = await startUpstream(() => ({
    id: "big",
    choices: [{ message: { role: "assistant", content: "x".repeat(1_024) } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
  const fatal = [];
  const gateway = new LlmGateway({
    upstreamUrl: upstream.url,
    maxResponseBytes: 64,
    meteringFailureMode: "exit",
    onFatal: (reason) => fatal.push(reason),
  });
  const { port } = await gateway.listen(0);
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });

  const result = await chat(port, { model: "m", messages: [] });
  assert.equal(result.status, 502);
  assert.equal(result.json.error, "upstream_response_too_large");

  await waitFor(() => fatal.length > 0);
  assert.deepEqual(fatal, ["metering_unavailable"]);
});

test("the gateway CLI exits with the fatal exit code and its state file survives it", async (t) => {
  const upstream = await startUpstream(() => ({
    id: "cli-exit",
    choices: [{ message: { role: "assistant", content: "not accountable" } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: -1 },
  }));
  const directory = await mkdtemp(join(tmpdir(), "anu-gateway-cli-exit-"));
  const stateFile = join(directory, "gateway-state.json");
  t.after(async () => {
    await upstream.close();
    await rm(directory, { recursive: true, force: true });
  });

  const child = spawn(
    process.execPath,
    [
      "dist/lab/runner.js", "gateway",
      "--upstream", upstream.url,
      "--state-file", stateFile,
      "--metering-failure-mode", "exit",
      "--port", "0",
    ],
    { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const listening = await new Promise((resolveListening, rejectListening) => {
    const onData = () => {
      for (const line of stdout.trim().split("\n").filter(Boolean)) {
        const parsed = JSON.parse(line);
        if (parsed.status === "listening") {
          child.stdout.off("data", onData);
          resolveListening(parsed);
          return;
        }
      }
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => rejectListening(new Error(`exited before listening: code=${code} stderr=${stderr}`)));
  });

  const response = await chat(listening.port, { model: "m", messages: [] });
  assert.equal(response.status, 502);

  const [exitCode] = await once(child, "exit");
  assert.equal(exitCode, LLM_GATEWAY_FATAL_EXIT_CODE, stderr);
  assert.equal(exitCode, 75);

  const persisted = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(persisted.schemaVersion, 1);
});
