import test from "node:test";
import assert from "node:assert/strict";

import { LlmRouter, OpenAICompatibleProvider } from "../dist/v1/economy-llm.js";

const REQUEST = { messages: [{ role: "user", content: "hi" }] };

function successResponse(id) {
  return {
    ok: true,
    json: async () => ({
      id,
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  };
}

/**
 * Never resolves on its own: only the request's own abort signal settles it,
 * simulating an upstream that never answers inside the provider's timeoutMs.
 *
 * AbortSignal.timeout()'s internal timer is unref'd by design, so it must not
 * be the only thing left pending: a ref'd keep-alive lets it still fire on
 * schedule instead of the test runner deciding the event loop is idle and
 * cancelling every test still waiting behind this one. It is cleared the
 * moment the signal actually fires.
 */
function hangUntilAborted(_url, init) {
  return new Promise((_resolve, reject) => {
    const keepAlive = setInterval(() => {}, 1_000);
    init.signal.addEventListener("abort", () => {
      clearInterval(keepAlive);
      reject(new Error("upstream did not respond"));
    }, { once: true });
  });
}

test("3 injected timeouts open the circuit; it recovers after cooldownMs and the 5th consultation succeeds", async () => {
  let clock = 1_000_000;
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    return calls <= 3 ? hangUntilAborted(url, init) : successResponse(`cmpl-${calls}`);
  };
  const provider = new OpenAICompatibleProvider(
    { defaultModel: "m", timeoutMs: 20, cooldownMs: 5_000, failureThreshold: 3, now: () => clock },
    fetchImpl,
  );

  assert.equal(provider.health().state, "closed");

  const outcomes = [];
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await provider.complete(REQUEST);
      outcomes.push({ attempt, ok: true, content: response.content });
    } catch (error) {
      outcomes.push({ attempt, ok: false, message: error.message });
    }
  }
  // All four consultations are accounted for, whether they reached the
  // network or were refused by the breaker — nothing is silently dropped.
  assert.equal(outcomes.length, 4);
  assert.equal(outcomes[0].ok, false);
  assert.match(outcomes[0].message, /upstream did not respond/);
  assert.equal(outcomes[1].ok, false);
  assert.match(outcomes[1].message, /upstream did not respond/);
  assert.equal(outcomes[2].ok, false);
  assert.match(outcomes[2].message, /upstream did not respond/);

  const openedHealth = provider.health();
  assert.equal(openedHealth.healthy, false);
  assert.equal(openedHealth.consecutiveFailures, 3);
  assert.equal(openedHealth.state, "open");

  // The fourth attempt lands while the circuit is open: refused before ever
  // reaching the network, and it must not count as a fourth failure either.
  assert.equal(outcomes[3].ok, false);
  assert.match(outcomes[3].message, /cooling down/);
  assert.equal(calls, 3, "a refusal while open must never reach the provider");
  assert.equal(provider.health().consecutiveFailures, 3, "a refusal must not inflate the failure count");

  // Nothing changes until cooldownMs has actually elapsed.
  clock += 4_999;
  assert.equal(provider.health().state, "open");
  clock += 1;
  assert.equal(provider.health().state, "half-open");
  assert.equal(provider.health().healthy, true, "half-open admits exactly one probe, so it reports healthy");

  const fifth = await provider.complete(REQUEST);
  assert.equal(fifth.content, "ok");
  assert.equal(calls, 4, "the recovery probe is the only call the provider made after opening");

  const recovered = provider.health();
  assert.equal(recovered.healthy, true);
  assert.equal(recovered.state, "closed");
  assert.equal(recovered.consecutiveFailures, 0, "a successful probe resets the failure count");
});

test("half-open admits exactly one recovery probe at a time", async () => {
  let clock = 0;
  let release;
  const blocked = new Promise((resolvePromise) => { release = resolvePromise; });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    // The first call opens the circuit with an ordinary HTTP failure — fast,
    // no timer involved. The second (the recovery probe, after the cooldown)
    // stays in flight until the test releases it, so a concurrent third call
    // can observe the circuit while the probe is still outstanding.
    if (calls === 1) return { ok: false, status: 500, text: async () => "boom" };
    await blocked;
    return successResponse("cmpl-probe");
  };
  const provider = new OpenAICompatibleProvider(
    { defaultModel: "m", timeoutMs: 5_000, cooldownMs: 1_000, failureThreshold: 1, now: () => clock },
    fetchImpl,
  );

  await assert.rejects(provider.complete(REQUEST), /HTTP 500/);
  assert.equal(provider.health().state, "open");

  clock += 1_000;
  assert.equal(provider.health().state, "half-open");

  const probe = provider.complete(REQUEST);
  await waitFor(() => calls >= 2);
  assert.equal(provider.health().state, "half-open");
  assert.equal(provider.health().healthy, false, "a probe already in flight must not invite a second one");

  await assert.rejects(provider.complete(REQUEST), /half-open/);
  assert.equal(calls, 2, "a concurrent call must be refused before it reaches the network");

  release();
  const result = await probe;
  assert.equal(result.content, "ok");
  assert.equal(provider.health().state, "closed");
});

async function waitFor(predicate) {
  while (!predicate()) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
}

test("the router skips an open provider and resumes routing to it once it half-opens", async () => {
  let clock = 0;
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    return calls === 1 ? hangUntilAborted(url, init) : successResponse(`cmpl-${calls}`);
  };
  const provider = new OpenAICompatibleProvider(
    { defaultModel: "m", timeoutMs: 20, cooldownMs: 2_000, failureThreshold: 1, now: () => clock },
    fetchImpl,
  );
  const router = new LlmRouter();
  router.register(provider);

  await assert.rejects(router.complete(REQUEST), /All eligible LLM providers failed/);
  assert.equal(provider.health().state, "open");

  // While open, the router must not even attempt the provider: no healthy
  // provider satisfies the policy at all.
  await assert.rejects(router.complete(REQUEST), /No healthy LLM provider satisfies the routing policy/);
  assert.equal(calls, 1, "a router must not retry an open provider");

  clock += 2_000;
  const response = await router.complete(REQUEST);
  assert.equal(response.content, "ok");
  assert.equal(provider.health().state, "closed");
});
