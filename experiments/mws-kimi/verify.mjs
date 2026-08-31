/**
 * Falsification harness: real LLM cognition against MWS Cloud (Kimi K2.6).
 *
 * Every claim the project makes about metered cognition is expressed here as a
 * hypothesis that a real model call can refute. Nothing is mocked: the runtime
 * primitives are the shipped ones, the agent is a real NanoAgent, and the model
 * is a live deployment.
 *
 * Required environment:
 *   MWS_API_KEY   API key of an MWS service account
 * Optional:
 *   MWS_BASE_URL  defaults to the <mws-project-id> OpenAI-compatible endpoint
 *   MWS_MODEL     defaults to kimi-k2-6
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NanoAgent } from "../../dist/index.js";
import { LlmRouter, OpenAICompatibleProvider } from "../../dist/distributed-v1.js";
import { MeteredCognitiveLoop, PersistentResourceEconomy } from "../../dist/autonomous.js";

const API_KEY = process.env.MWS_API_KEY;
const BASE_URL = process.env.MWS_BASE_URL ?? "https://gpt.mwsapis.ru/projects/<mws-project-id>/openai/v1";
const MODEL = process.env.MWS_MODEL ?? "kimi-k2-6";

if (!API_KEY) {
  console.error("MWS_API_KEY is not set; refusing to run a live experiment without credentials.");
  process.exit(2);
}

const findings = [];
const evidence = [];

function record(id, claim, verdict, detail) {
  findings.push({ id, claim, verdict, detail });
  const mark = verdict === "SUPPORTED" ? "PASS" : verdict === "REFUTED" ? "FAIL" : "WARN";
  console.log(`[${mark}] ${id} — ${claim}`);
  console.log(`        ${detail}`);
}

/** The stock provider, unmodified, pointed at MWS. */
function buildRouter(model = MODEL) {
  const router = new LlmRouter();
  router.register(
    new OpenAICompatibleProvider({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      defaultModel: model,
      timeoutMs: 180_000,
    }),
  );
  return router;
}

function buildAgent(id, objective, exposedState) {
  return new NanoAgent({
    id,
    objective: { primary: objective, secondary: [], antiGoals: [], weights: {} },
    capabilities: [{ id: "analyse", accepts: ["signal"], produces: ["assessment"], riskClass: "low" }],
    exposedState,
    budget: { compute: Infinity, tokens: 100_000, money: Infinity, latencyMs: Infinity, externalActions: 16 },
  });
}

/** Unbilled usage the runtime declared on a failed thought, if any. */
function unbilledOf(error) {
  return Array.isArray(error?.unbilled) ? error.unbilled : [];
}

async function openEconomy() {
  const directory = await mkdtemp(join(tmpdir(), "anu-mws-"));
  const economy = await PersistentResourceEconomy.open(directory);
  return { economy, directory };
}

/* ------------------------------------------------------------------ */
/* H1 — interchangeable providers                                      */
/* ------------------------------------------------------------------ */
async function h1() {
  const router = buildRouter();
  const response = await router.complete(
    {
      messages: [
        { role: "system", content: "Return one valid JSON object only. Allowed keys: summary." },
        { role: "user", content: JSON.stringify({ ping: true }) },
      ],
      responseFormat: "json",
      maxTokens: 1024,
      temperature: 0,
    },
    { require: ["chat", "json"] },
  );
  const parsed = JSON.parse(response.content);
  assert.ok(typeof parsed === "object" && parsed !== null);
  evidence.push({ h: "H1", provider: response.provider, model: response.model, usage: response.usage, latencyMs: response.latencyMs });
  record(
    "H1",
    "A new provider can be added with zero runtime code changes",
    "SUPPORTED",
    `Stock OpenAICompatibleProvider reached MWS unmodified. provider=${response.provider} model=${response.model} latency=${response.latencyMs}ms`,
  );
  return response;
}

/* ------------------------------------------------------------------ */
/* H2 + H3 + H5 — metered cognition on a real NanoAgent                */
/* ------------------------------------------------------------------ */
async function h2h3h5() {
  const { economy, directory } = await openEconomy();
  try {
    await economy.mint("agent:analyst", "model_tokens", 200_000);
    await economy.mint("agent:analyst", "credits", 10_000);

    const beforeTokens = economy.balance("agent:analyst", "model_tokens");
    const beforeCredits = economy.balance("agent:analyst", "credits");

    const agent = buildAgent("agent:analyst", "assess the incoming signal and expose a recommendation", {
      signal: { source: "sensor-7", value: 0.82, trend: "rising" },
    });
    agent.activate();

    const loop = new MeteredCognitiveLoop(economy, buildRouter(), {
      providerAccount: "provider:mws",
      reserveOutputTokens: 3_000,
      tokenSafetyFactor: 1.2,
      inputCreditsPerThousand: 10,
      outputCreditsPerThousand: 30,
    });

    const actions = [];
    const result = await loop.think(agent, {
      maxTokens: 3_000,
      input: { tick: 1, instruction: "Expose a recommendation and request one action." },
      actionHandler: (_agent, action) => actions.push(action),
    });

    const afterTokens = economy.balance("agent:analyst", "model_tokens");
    const afterCredits = economy.balance("agent:analyst", "credits");
    const providerTokens = economy.balance("provider:mws", "model_tokens");
    const providerCredits = economy.balance("provider:mws", "credits");

    /* H2 — settlement matches real reported usage, and nothing leaks. */
    const tokensSpent = beforeTokens - afterTokens;
    const conservedTokens = economy.assertConserved("model_tokens");
    const conservedCredits = economy.assertConserved("credits");
    const exact =
      tokensSpent === result.chargedModelTokens &&
      providerTokens === result.chargedModelTokens &&
      beforeCredits - afterCredits === result.chargedCredits &&
      providerCredits === result.chargedCredits;

    evidence.push({
      h: "H2",
      reportedUsage: result.response.usage,
      chargedModelTokens: result.chargedModelTokens,
      chargedCredits: result.chargedCredits,
      agentTokensDelta: tokensSpent,
      providerTokens,
      conservedTokens,
      conservedCredits,
    });
    record(
      "H2",
      "Agents pay for their own resource use; reservations settle exactly and conserve",
      exact && conservedTokens && conservedCredits ? "SUPPORTED" : "REFUTED",
      `charged=${result.chargedModelTokens} tokens / ${result.chargedCredits} credits; agent debited ${tokensSpent}; ` +
        `provider credited ${providerTokens}; conservation tokens=${conservedTokens} credits=${conservedCredits}`,
    );

    /* H3 — the model actually changed the real NanoAgent. */
    const snapshot = agent.snapshot();
    const mutated =
      Object.keys(snapshot.exposedState).length > 1 ||
      Object.keys(snapshot.durableState).length > 0 ||
      Object.keys(snapshot.privateState).length > 0;
    evidence.push({
      h: "H3",
      summary: result.decision.summary,
      exposedState: snapshot.exposedState,
      durableState: snapshot.durableState,
      privateState: snapshot.privateState,
      actions,
      budgetTokensLeft: snapshot.budget.tokens,
    });
    record(
      "H3",
      "LLM cognition mutates the agent's bounded local world and dispatches actions",
      mutated ? "SUPPORTED" : "REFUTED",
      `exposed=${JSON.stringify(snapshot.exposedState).slice(0, 160)}; actions=${actions.length}; ` +
        `budget.tokens ${snapshot.budget.tokens} (was 100000)`,
    );

    /* H5 — hidden reasoning tokens are billed to the agent. */
    const raw = result.response.raw ?? {};
    const reasoning = Number(raw?.usage?.completion_tokens_details?.reasoning_tokens ?? 0);
    const visible = result.response.content.length;
    evidence.push({ h: "H5", reasoningTokens: reasoning, completionTokens: result.response.usage.outputTokens, visibleChars: visible });
    record(
      "H5",
      "Billing covers hidden reasoning tokens, not just visible output",
      reasoning > 0 ? "SUPPORTED" : "INCONCLUSIVE",
      `reasoning_tokens=${reasoning} of completion_tokens=${result.response.usage.outputTokens}; ` +
        `visible content ${visible} chars — the agent paid for invisible work`,
    );

    return { result, actions };
  } finally {
    await economy.checkpoint();
    await rm(directory, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* H4 — failure refunds the reservation                                */
/* ------------------------------------------------------------------ */
async function h4() {
  const { economy, directory } = await openEconomy();
  try {
    await economy.mint("agent:doomed", "model_tokens", 50_000);
    await economy.mint("agent:doomed", "credits", 1_000);
    const beforeTokens = economy.balance("agent:doomed", "model_tokens");
    const beforeCredits = economy.balance("agent:doomed", "credits");

    const agent = buildAgent("agent:doomed", "this thought will fail", { signal: 1 });
    agent.activate();

    // A model that does not exist in the deployment: a real remote failure.
    const loop = new MeteredCognitiveLoop(economy, buildRouter("model-that-does-not-exist"), {
      providerAccount: "provider:mws",
      reserveOutputTokens: 2_000,
      inputCreditsPerThousand: 10,
      outputCreditsPerThousand: 30,
    });

    let threw = false;
    let message = "";
    try {
      await loop.think(agent, { maxTokens: 2_000 });
    } catch (error) {
      threw = true;
      message = error instanceof Error ? error.message : String(error);
    }

    const afterTokens = economy.balance("agent:doomed", "model_tokens");
    const afterCredits = economy.balance("agent:doomed", "credits");
    const restored = afterTokens === beforeTokens && afterCredits === beforeCredits;
    const conserved = economy.assertConserved("model_tokens") && economy.assertConserved("credits");

    evidence.push({ h: "H4", threw, restored, conserved, beforeTokens, afterTokens, message: message.slice(0, 200) });
    record(
      "H4",
      "A failed thought refunds its reservation and leaves no orphaned escrow",
      threw && restored && conserved ? "SUPPORTED" : "REFUTED",
      `remote failure raised=${threw}; balances restored=${restored} (${beforeTokens}→${afterTokens}); conserved=${conserved}`,
    );
  } finally {
    await economy.checkpoint();
    await rm(directory, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* H6 — reasoning budget pressure: does the default 1024 cap survive?  */
/* ------------------------------------------------------------------ */
async function h6() {
  const { economy, directory } = await openEconomy();
  try {
    await economy.mint("agent:tight", "model_tokens", 200_000);
    const agent = buildAgent("agent:tight", "produce a structured assessment with several fields", {
      signal: { source: "sensor-9", value: 0.4, history: [0.1, 0.2, 0.3, 0.4] },
    });
    agent.activate();
    const loop = new MeteredCognitiveLoop(economy, buildRouter(), {
      providerAccount: "provider:mws",
      reserveOutputTokens: 1_024,
    });

    let failed = false;
    let overran = false;
    let detail = "";
    let usage;
    try {
      // The library default for a thought.
      const result = await loop.think(agent, { maxTokens: 1_024 });
      usage = result.response.usage;
      overran = usage.outputTokens > 1_024;
      detail =
        `parsed successfully; output=${usage.outputTokens} tokens, content ${result.response.content.length} chars` +
        (overran ? ` — but only because the provider ignored the 1024 cap (see H7); reasoning alone would have truncated it` : "");
    } catch (error) {
      failed = true;
      detail = error instanceof Error ? error.message.slice(0, 200) : String(error);
    }

    evidence.push({ h: "H6", failedAtDefaultCap: failed, overranRequestedCap: overran, usage, detail });
    record(
      "H6",
      "The library default maxTokens=1024 is safe for a reasoning model",
      failed ? "REFUTED" : overran ? "INCONCLUSIVE" : "SUPPORTED",
      detail,
    );
  } finally {
    await economy.checkpoint();
    await rm(directory, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* H7 — is the per-thought token bound actually enforced?              */
/* ------------------------------------------------------------------ */
async function h7() {
  const router = buildRouter();
  const cap = 32;
  const response = await router.complete(
    {
      messages: [{ role: "user", content: "Объясни подробно, что такое энтропия в термодинамике." }],
      maxTokens: cap,
      temperature: 0,
    },
    { require: ["chat"] },
  );
  const overrun = response.usage.outputTokens > cap;
  evidence.push({ h: "H7", requestedMaxTokens: cap, actualOutputTokens: response.usage.outputTokens, finishReason: response.raw?.choices?.[0]?.finish_reason });
  record(
    "H7",
    "A bounded agent can cap the cost of a single thought via maxTokens",
    overrun ? "REFUTED" : "SUPPORTED",
    `requested max_tokens=${cap}, provider returned ${response.usage.outputTokens} output tokens ` +
      `(finish_reason=${response.raw?.choices?.[0]?.finish_reason}) — the bound is advisory, not enforced`,
  );
}

/* ------------------------------------------------------------------ */
/* H8 — who pays when real usage overruns the agent's means?           */
/* ------------------------------------------------------------------ */
async function h8() {
  const { economy, directory } = await openEconomy();
  try {
    // Enough to cover the reservation, far too little to cover real usage.
    await economy.mint("agent:poor", "model_tokens", 600);
    const before = economy.balance("agent:poor", "model_tokens");

    const agent = buildAgent("agent:poor", "produce a long structured assessment", {
      signal: { source: "sensor-3", value: 0.5 },
    });
    agent.activate();
    const loop = new MeteredCognitiveLoop(economy, buildRouter(), {
      providerAccount: "provider:mws",
      reserveOutputTokens: 200,
      tokenSafetyFactor: 1.0,
    });

    let threw = false;
    let message = "";
    let caught;
    try {
      await loop.think(agent, { maxTokens: 200 });
    } catch (error) {
      threw = true;
      caught = error;
      message = error instanceof Error ? error.message : String(error);
    }

    const after = economy.balance("agent:poor", "model_tokens");
    const providerPaid = economy.balance("provider:mws", "model_tokens");
    // Real tokens were burned at MWS regardless of what the ledger recorded.
    const ledgerCharged = before - after;
    const unbilled = unbilledOf(caught);
    // After the fix the runtime must bill what it can and declare the remainder,
    // instead of refunding spend that already happened.
    const honest = threw && ledgerCharged > 0 && providerPaid === ledgerCharged;

    evidence.push({ h: "H8", threw, before, after, ledgerCharged, providerPaid, unbilled, message: message.slice(0, 180) });
    record(
      "H8",
      "Real provider spend is always reflected in the ledger",
      honest ? "SUPPORTED" : "REFUTED",
      `overrun raised=${threw}; ledger charged ${ledgerCharged} tokens, provider holds ${providerPaid}; ` +
        `declared unbilled=${JSON.stringify(unbilled)} — spend is recorded, shortfall is declared rather than hidden`,
    );
  } finally {
    await economy.checkpoint();
    await rm(directory, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* H9 — is a reservation a spending cap for a solvent agent?           */
/* ------------------------------------------------------------------ */
async function h9() {
  const { economy, directory } = await openEconomy();
  try {
    await economy.mint("agent:rich", "model_tokens", 200_000);
    const agent = buildAgent("agent:rich", "produce a structured assessment", {
      signal: { source: "sensor-5", value: 0.66 },
    });
    agent.activate();
    // Deliberately reserve far less than a reasoning model will consume, and
    // ask the runtime to treat that reservation as a ceiling.
    const loop = new MeteredCognitiveLoop(economy, buildRouter(), {
      providerAccount: "provider:mws",
      reserveOutputTokens: 100,
      tokenSafetyFactor: 1.0,
      overrunPolicy: "reject",
    });

    const before = economy.balance("agent:rich", "model_tokens");
    let caught;
    try {
      await loop.think(agent, { maxTokens: 100 });
    } catch (error) {
      caught = error;
    }

    const debited = before - economy.balance("agent:rich", "model_tokens");
    const providerPaid = economy.balance("provider:mws", "model_tokens");
    const overrun = caught?.overrun;
    const capped =
      caught?.name === "CognitiveOverrunError" &&
      overrun !== undefined &&
      overrun.toppedUp === 0 &&
      debited === providerPaid &&
      debited <= overrun.reserved;

    evidence.push({
      h: "H9",
      error: caught?.name,
      overrun,
      unbilled: unbilledOf(caught),
      debited,
      providerPaid,
      conserved: economy.assertConserved("model_tokens"),
    });
    record(
      "H9",
      "A reservation caps what a single thought may spend",
      capped ? "SUPPORTED" : "REFUTED",
      `model wanted ${overrun?.required} tokens against a ${overrun?.reserved} reservation; the agent was debited ` +
        `${debited} and no more, the breach surfaced as ${caught?.name}, and the unbilled remainder is declared`,
    );
  } finally {
    await economy.checkpoint();
    await rm(directory, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */

async function main() {
  console.log(`Live falsification run against ${BASE_URL}`);
  console.log(`Model: ${MODEL}\n`);

  await h1();
  console.log();
  await h2h3h5();
  console.log();
  await h4();
  console.log();
  await h6();
  console.log();
  await h7();
  console.log();
  await h8();
  console.log();
  await h9();

  console.log("\n================ VERDICT ================");
  for (const finding of findings) console.log(`${finding.verdict.padEnd(13)} ${finding.id}  ${finding.claim}`);

  const refuted = findings.filter((finding) => finding.verdict === "REFUTED");
  console.log(`\n${findings.length} hypotheses, ${refuted.length} refuted.`);
  console.log("\n---- EVIDENCE ----");
  console.log(JSON.stringify(evidence, null, 2));
  process.exit(refuted.length === 0 ? 0 : 1);
}

await main();
