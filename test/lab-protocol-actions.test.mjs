/**
 * Deterministic outcome verification for the whole action vocabulary.
 *
 * The protocol verifier's job for an action is to regenerate, from the decision
 * and the projected state alone, the exact event a correct engine would have
 * committed — and to refuse anything else. It used to do that for six action
 * types out of nineteen and crash the process on the rest, because the
 * scientific track's deterministic policies only ever choose those six. A live
 * epoch is steered by a model that chooses freely, so the gap became reachable
 * the moment a real universe ran: the first `store` a model asked for stopped
 * the whole run.
 *
 * What is proven here, for every action type outside that original six:
 *
 *  1. a real epoch in which the action is actually chosen replays and verifies;
 *  2. a TAMPERED outcome — a different amount, a different stored value, a
 *     different capability charge, an invocation for a different input — is
 *     refused with a message naming that action's check;
 *  3. an action this engine prices but cannot perform (`spawn`, `clone`,
 *     `merge`, `reserve`, `trade`) is refused with exactly one reason, and a
 *     forged success in its place is refused too.
 *
 * Every chain forged below is RE-SIGNED, so the hash chain accepts it and the
 * only thing left to refuse it is the rule itself.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReplayEngine } from "../dist/lab/replay.js";
import { LiveIdlePolicy } from "../dist/lab/live/live-idle-policy.js";
import { openLiveEpochEvidence, runLiveUniverse } from "../dist/lab/live/epoch.js";
import { LIVE_UNIVERSE_ID } from "../dist/lab/live/identity.js";
import { LIVE_TEST_COGNITION_ID, liveTestConfig, resignEventChain } from "./live-fixture.mjs";

const LIVE_PROJECTION = { live: { createFallbackPolicy: () => new LiveIdlePolicy() } };

async function tempDir(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * A scripted live cognition whose answer is whatever `plan(request)` returns.
 * Same contract as `scriptedLiveCognition`, but the actions are the test's:
 * an agent with nothing to say is simply not consulted.
 */
function plannedLiveCognition(plan, { id = LIVE_TEST_COGNITION_ID, tier = "fast" } = {}) {
  return {
    id,
    cohort: "C",
    async propose(requests) {
      const records = [];
      for (const request of requests) {
        const actions = plan(request);
        if (actions.length === 0) continue;
        records.push({
          tick: request.tick,
          agentId: request.agentId,
          cohort: "C",
          provider: "scripted",
          model: "scripted-live",
          content: JSON.stringify({ actions }),
          usage: { inputTokens: 4, outputTokens: 4, totalTokens: 8 },
          latencyMs: 1,
          actions,
          tier,
        });
      }
      return records;
    },
  };
}

/** Run one live epoch on a scripted plan and hand back everything a forgery needs. */
async function runPlannedEpoch(t, { prefix, plan, config }) {
  const root = await tempDir(t, prefix);
  const [epoch] = await runLiveUniverse({
    dataRoot: root,
    config,
    cognition: plannedLiveCognition(plan),
    epochs: 1,
  });
  const store = openLiveEpochEvidence(root, LIVE_UNIVERSE_ID, epoch.runId);
  const text = await readFile(store.eventsPath, "utf8");
  const events = text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
  const manifest = await store.readManifest();
  const stored = await store.readConfig();

  // The honest chain verifies, and its projection is the state the epoch
  // published — without this every refusal below could be refusing the setup.
  const replay = ReplayEngine.replay(events, manifest, stored, undefined, LIVE_PROJECTION);
  assert.equal(replay.stateHash, epoch.summary.finalStateHash, "the untampered epoch replays");

  return {
    epoch,
    events,
    /** Replay the chain with one event rewritten, re-signed so only the rules can refuse it. */
    replayWith(seq, mutate) {
      return ReplayEngine.replay(
        resignEventChain(events.map((event) => (
          event.seq === seq ? mutate(structuredClone(event)) : event
        ))),
        manifest,
        stored,
        undefined,
        LIVE_PROJECTION,
      );
    },
  };
}

/** The first event of `type` that satisfies `match`; asserts the epoch produced one. */
function firstOf(events, type, match = () => true, label = type) {
  const found = events.filter((event) => event.type === type && match(event));
  assert.ok(found.length > 0, `the epoch produced at least one ${label}`);
  return found[0];
}

function shortEpoch(overrides = {}) {
  const base = liveTestConfig();
  return {
    ...base,
    metricEvery: 4,
    checkpointEvery: 4,
    ...overrides,
    live: { ...structuredClone(base.live), epochTicks: 8, ...(overrides.live ?? {}) },
  };
}

/** The peers an agent can see, self excluded, in deterministic order. */
function peers(request) {
  return [...request.observation.visibleAgents].filter((agent) => agent !== request.agentId).sort();
}

/* ------------------------------------------------------------------ */
/* Memory, links and resources                                         */
/* ------------------------------------------------------------------ */

test("store, retrieve, disconnect and transfer outcomes are regenerated, and forged ones are refused", async (t) => {
  // One epoch that walks the whole ordinary vocabulary the six original cases
  // never covered. Tick by tick: remember something, link up, tear the link
  // down, move a credit, read the memory back, then ask for a key that was
  // never stored.
  const plan = (request) => {
    const others = peers(request);
    const neighbours = [...request.observation.neighbors].sort();
    switch (request.tick) {
      case 1:
        return [{ type: "store", key: "note", value: { remembered: request.agentId } }];
      case 2:
        return others.length > 0 ? [{ type: "connect", targetId: others[0] }] : [];
      case 3:
        return neighbours.length > 0 ? [{ type: "disconnect", targetId: neighbours[0] }] : [];
      case 4:
        return others.length > 0
          ? [{ type: "transfer", targetId: others[0], resource: "credits", amount: 3 }]
          : [];
      case 5:
        return [{ type: "retrieve", key: "note" }];
      case 6:
        return [{ type: "retrieve", key: "never-written" }];
      default:
        return [];
    }
  };

  const epoch = await runPlannedEpoch(t, {
    prefix: "anu-actions-ordinary-",
    plan,
    config: shortEpoch(),
  });
  const { events, replayWith } = epoch;

  /* store ---------------------------------------------------------- */
  // The action that actually stopped production: an ordinary, priced `store`.
  const stored = firstOf(events, "memory.stored", (event) => event.data.action === "store");
  assert.equal(stored.tick, 1);
  assert.equal(stored.targetId, undefined);
  assert.deepEqual(stored.data.value, { remembered: stored.actorId });
  assert.throws(
    () => replayWith(stored.seq, (event) => {
      event.data.value = { remembered: "someone-else" };
      return event;
    }),
    /store outcome/,
    "a memory the agent never asked to store is refused",
  );
  assert.throws(
    () => replayWith(stored.seq, (event) => {
      event.data.key = "other-note";
      return event;
    }),
    /store outcome/,
    "a memory written under another key is refused",
  );

  /* retrieve ------------------------------------------------------- */
  const retrieved = firstOf(events, "memory.retrieved");
  assert.equal(retrieved.tick, 5);
  assert.deepEqual(retrieved.data.value, { remembered: retrieved.actorId });
  assert.throws(
    () => replayWith(retrieved.seq, (event) => {
      event.data.value = { remembered: "fabricated" };
      return event;
    }),
    /retrieve outcome/,
    "a recall of something the world does not hold is refused",
  );
  // The key the world never held: the world refuses the action, and the
  // verifier regenerates that refusal word for word rather than trusting it.
  const missing = firstOf(
    events,
    "violation.recorded",
    (event) => event.data.action === "retrieve",
    "retrieve violation",
  );
  assert.match(String(missing.data.reason), /^Unknown memory key never-written$/);
  assert.throws(
    () => replayWith(missing.seq, (event) => {
      event.data.reason = "Unknown memory key note";
      return event;
    }),
    /deterministic action violation/,
    "a refusal blamed on the wrong key is refused",
  );

  /* disconnect ----------------------------------------------------- */
  const removed = firstOf(events, "link.removed");
  assert.equal(removed.tick, 3);
  assert.equal(removed.targetId !== undefined, true);
  assert.throws(
    () => replayWith(removed.seq, (event) => {
      event.data.linkId = `${event.data.linkId}-forged`;
      return event;
    }),
    /disconnect outcome/,
    "tearing down a link other than the one the decision named is refused",
  );
  // Contention is real here: two agents decide to drop the same link from one
  // frozen snapshot, and only the first resolution finds it. The second is
  // refused, and the verifier regenerates that refusal too.
  const contended = firstOf(
    events,
    "violation.recorded",
    (event) => event.data.action === "disconnect",
    "disconnect violation",
  );
  assert.equal(contended.data.reason, "Agents are not connected");
  assert.throws(
    () => replayWith(contended.seq, (event) => {
      event.data.reason = "Agents are not connected any more";
      return event;
    }),
    /deterministic action violation/,
    "a disconnect refusal with an invented reason is refused",
  );

  /* transfer ------------------------------------------------------- */
  const transferred = firstOf(
    events,
    "resource.transferred",
    (event) => event.phase === "resolution",
    "agent transfer",
  );
  assert.equal(transferred.tick, 4);
  assert.equal(transferred.data.amount, 3);
  assert.equal(transferred.data.resource, "credits");
  // The tamper the reducer alone would wave through: 3 credits become 300,
  // which the sender can afford and which conserves resources perfectly. Only
  // the decision the agent actually took says it is a forgery.
  assert.throws(
    () => replayWith(transferred.seq, (event) => {
      event.data.amount = 300;
      return event;
    }),
    /transfer outcome/,
    "a transfer larger than the one decided is refused",
  );
  assert.throws(
    () => replayWith(transferred.seq, (event) => {
      event.data.resource = "computeMs";
      return event;
    }),
    /transfer outcome/,
    "a transfer of another resource than the one decided is refused",
  );
});

test("a transfer the sender cannot make is refused for exactly the world's reason", async (t) => {
  const plan = (request) => {
    const others = peers(request);
    if (request.tick !== 1 || others.length === 0) return [];
    return [{ type: "transfer", targetId: others[0], resource: "credits", amount: 10_000_000 }];
  };
  const { events, replayWith } = await runPlannedEpoch(t, {
    prefix: "anu-actions-overdraw-",
    plan,
    config: shortEpoch({ live: { epochTicks: 2 } }),
  });

  const refused = firstOf(
    events,
    "violation.recorded",
    (event) => event.data.action === "transfer",
    "transfer violation",
  );
  assert.equal(refused.data.reason, "Insufficient credits");
  assert.equal(
    events.some((event) => event.type === "resource.transferred" && event.phase === "resolution"),
    false,
    "nothing moved",
  );
  assert.throws(
    () => replayWith(refused.seq, (event) => {
      event.data.reason = "Insufficient computeMs";
      return event;
    }),
    /deterministic action violation/,
    "a refusal that names the wrong resource is refused",
  );
});

/* ------------------------------------------------------------------ */
/* Capabilities                                                        */
/* ------------------------------------------------------------------ */

const ECHO_CAPABILITY = Object.freeze({
  id: "cap://echo/v1",
  inputs: ["a"],
  outputs: ["b"],
  primitivePlan: ["execute"],
  executionPlan: [{ op: "copy", from: "a", to: "b" }],
  tests: [{ input: { a: 1 }, output: { b: 1 } }],
  cost: { credits: 2, llmTokens: 0, computeMs: 1, storageBytes: 0, bandwidthBytes: 0 },
});

/** Same bounded plan, priced past anything a genesis agent holds. */
const COSTLY_CAPABILITY = Object.freeze({
  ...structuredClone(ECHO_CAPABILITY),
  id: "cap://costly/v1",
  cost: { credits: 10_000_000, llmTokens: 0, computeMs: 0, storageBytes: 0, bandwidthBytes: 0 },
});

test("publishCapability and useCapability outcomes are regenerated, and forged ones are refused", async (t) => {
  // Two publishers, then every way an invocation can end: accepted and paid to
  // its owner, accepted and paid to the treasury (the owner calling its own),
  // rejected because the plan refuses the input, rejected because the caller
  // cannot pay, and refused outright because there is no such capability.
  const plan = (request) => {
    const published = request.observation.capabilities;
    if (request.tick === 1) {
      if (request.agentId === "N0001") {
        return [{ type: "publishCapability", capability: structuredClone(ECHO_CAPABILITY) }];
      }
      if (request.agentId === "N0002") {
        return [{ type: "publishCapability", capability: structuredClone(COSTLY_CAPABILITY) }];
      }
      return [];
    }
    const echo = published.find((capability) => capability.id === ECHO_CAPABILITY.id);
    const costly = published.find((capability) => capability.id === COSTLY_CAPABILITY.id);
    if (echo === undefined || costly === undefined) return [];
    switch (request.tick) {
      case 2:
        return request.agentId === "N0002"
          ? [{ type: "useCapability", capabilityId: echo.id, input: { a: 7 } }]
          : [];
      case 3:
        // The bounded plan needs `a`; without it the invocation is recorded as
        // rejected rather than refused — a paid, visible failure.
        return request.agentId === "N0003"
          ? [{ type: "useCapability", capabilityId: echo.id, input: { z: 1 } }]
          : [];
      case 4:
        return request.agentId === "N0003"
          ? [{ type: "useCapability", capabilityId: costly.id, input: { a: 1 } }]
          : [];
      case 5:
        // The owner calling its own capability pays the treasury, not itself.
        return request.agentId === "N0001"
          ? [{ type: "useCapability", capabilityId: echo.id, input: { a: 5 } }]
          : [];
      case 6:
        return request.agentId === "N0004"
          ? [{ type: "useCapability", capabilityId: "cap://absent/v1", input: { a: 1 } }]
          : [];
      default:
        return [];
    }
  };

  const { events, replayWith } = await runPlannedEpoch(t, {
    prefix: "anu-actions-capability-",
    plan,
    config: shortEpoch({ live: { epochTicks: 8 } }),
  });

  /* publishCapability ---------------------------------------------- */
  const publication = firstOf(
    events,
    "capability.published",
    (event) => event.data.capability.id === ECHO_CAPABILITY.id,
    "echo publication",
  );
  assert.equal(publication.tick, 1);
  assert.equal(publication.actorId, "N0001");
  assert.equal(publication.targetId, undefined);
  assert.equal(publication.data.capability.id, ECHO_CAPABILITY.id);
  assert.equal(publication.data.capability.version, 1);
  assert.deepEqual(publication.data.capability.cost, ECHO_CAPABILITY.cost);
  // A published price is what every later caller is charged, so a publication
  // that quietly costs more than the one decided is exactly worth forging.
  assert.throws(
    () => replayWith(publication.seq, (event) => {
      event.data.capability.cost.credits = 900;
      return event;
    }),
    /publishCapability outcome/,
    "a capability published at a price nobody agreed to is refused",
  );
  assert.throws(
    () => replayWith(publication.seq, (event) => {
      event.data.capability.executionPlan = [{ op: "literal", output: "b", value: 0 }];
      return event;
    }),
    /publishCapability outcome/,
    "a capability published with a different plan than the one decided is refused",
  );

  /* useCapability — accepted --------------------------------------- */
  const accepted = firstOf(
    events,
    "capability.used",
    (event) => event.data.invocation.accepted === true && event.actorId === "N0002",
    "accepted invocation",
  );
  assert.equal(accepted.actorId, "N0002");
  assert.equal(accepted.targetId, "N0001");
  assert.deepEqual(accepted.data.invocation.input, { a: 7 });
  assert.deepEqual(accepted.data.invocation.output, { b: 7 });
  assert.equal(accepted.data.invocation.paymentTo, "N0001");
  assert.deepEqual(accepted.data.invocation.chargedCost, ECHO_CAPABILITY.cost);
  // Input and output rewritten together: the invocation stays internally
  // consistent — the plan really does map {a:99} to {b:99} — so the reducer
  // has nothing to object to. What refuses it is that the caller decided on a
  // different input.
  assert.throws(
    () => replayWith(accepted.seq, (event) => {
      event.data.invocation.input = { a: 99 };
      event.data.invocation.output = { b: 99 };
      return event;
    }),
    /useCapability outcome/,
    "an invocation recorded for an input the caller never chose is refused",
  );
  assert.throws(
    () => replayWith(accepted.seq, (event) => {
      event.data.invocation.paymentTo = "@treasury";
      return event;
    }),
    /useCapability outcome/,
    "an invocation that pays somewhere other than the owner is refused",
  );

  /* useCapability — the owner calling its own capability ------------ */
  const ownCall = firstOf(
    events,
    "capability.used",
    (event) => event.actorId === "N0001" && event.data.invocation.accepted === true,
    "self invocation",
  );
  assert.equal(ownCall.data.invocation.paymentTo, "@treasury", "an owner pays the treasury, not itself");
  assert.throws(
    () => replayWith(ownCall.seq, (event) => {
      event.data.invocation.paymentTo = "N0001";
      return event;
    }),
    /useCapability outcome/,
    "an owner paying its own charge back to itself is refused",
  );

  /* useCapability — rejected by its own plan ------------------------ */
  const rejected = firstOf(
    events,
    "capability.used",
    (event) => event.data.invocation.reason === "execution_failed",
    "plan-rejected invocation",
  );
  assert.equal(rejected.actorId, "N0003");
  assert.equal(rejected.data.invocation.accepted, false);
  assert.equal(rejected.data.invocation.success, false);
  assert.deepEqual(
    rejected.data.invocation.chargedCost,
    { credits: 0, llmTokens: 0, computeMs: 0, storageBytes: 0, bandwidthBytes: 0 },
  );
  assert.throws(
    () => replayWith(rejected.seq, (event) => {
      event.data.invocation.reason = "insufficient_resources";
      return event;
    }),
    /useCapability outcome/,
    "a rejection blamed on the caller's balance rather than the plan is refused",
  );

  /* useCapability — rejected because the caller cannot pay ---------- */
  const unaffordable = firstOf(
    events,
    "capability.used",
    (event) => event.data.invocation.reason === "insufficient_resources",
    "unaffordable invocation",
  );
  assert.equal(unaffordable.data.invocation.capabilityId, COSTLY_CAPABILITY.id);
  assert.equal(unaffordable.data.invocation.accepted, false);
  assert.throws(
    () => replayWith(unaffordable.seq, (event) => {
      event.data.invocation.reason = "execution_failed";
      return event;
    }),
    /useCapability outcome/,
    "a rejection blamed on the plan rather than the caller's balance is refused",
  );

  /* useCapability — no such capability ------------------------------ */
  const unknown = firstOf(
    events,
    "violation.recorded",
    (event) => event.data.action === "useCapability",
    "useCapability violation",
  );
  assert.equal(unknown.data.reason, "Unknown capability cap://absent/v1");
  assert.throws(
    () => replayWith(unknown.seq, (event) => {
      event.data.reason = "Unknown capability cap://echo/v1";
      return event;
    }),
    /deterministic action violation/,
    "a refusal that names a capability the world does hold is refused",
  );
});

/* ------------------------------------------------------------------ */
/* Priced, but unimplemented                                           */
/* ------------------------------------------------------------------ */

test("spawn, clone, merge, reserve and trade are paid for and refused, and the refusal cannot be forged", async (t) => {
  // `spawn` costs 1 000 credits and a genesis agent starts with exactly that,
  // so after paying 2 credits for the thought that chose it the attempt is
  // never made at all — the payment is refused for want of resources and the
  // world commits nothing. Raising the endowment is what makes the refusal
  // itself reachable; the cost table is untouched.
  const base = liveTestConfig();
  const config = shortEpoch({
    initialResources: { ...base.initialResources, credits: 20_000 },
    live: { epochTicks: 3 },
  });

  const plan = (request) => {
    const others = peers(request);
    if (request.tick === 1) {
      switch (request.agentId) {
        case "N0001": return [{ type: "spawn" }];
        case "N0002": return [{ type: "clone" }];
        case "N0003": return others.length > 0 ? [{ type: "merge", targetId: others[0] }] : [];
        default: return [{ type: "reserve", resource: "credits", amount: 5 }];
      }
    }
    if (request.tick === 2) return [{ type: "trade", resource: "credits", amount: 5, credits: 5 }];
    return [];
  };

  const { events, replayWith } = await runPlannedEpoch(t, {
    prefix: "anu-actions-unsupported-",
    plan,
    config,
  });

  const refusals = new Map();
  for (const action of ["spawn", "clone", "merge", "reserve", "trade"]) {
    const violation = firstOf(
      events,
      "violation.recorded",
      (event) => event.data.action === action,
      `${action} violation`,
    );
    assert.equal(
      violation.data.reason,
      `${action} is unsupported in logical v1`,
      `${action} is refused for the one reason the engine has`,
    );
    // It was paid for: the attempt is charged even though nothing happened.
    const payment = events.find((event) => event.eventId === violation.causationId);
    assert.equal(payment.type, "resource.spent");
    assert.equal(payment.data.action, action);
    refusals.set(action, violation);
  }

  // Nothing was created, merged or reserved: these actions move no state at all.
  assert.equal(
    events.some((event) => event.type === "agent.created" && event.tick > 0),
    false,
    "no agent was born from a spawn or a clone",
  );

  for (const [action, violation] of refusals) {
    assert.throws(
      () => replayWith(violation.seq, (event) => {
        event.data.reason = `${action} is supported in logical v1`;
        return event;
      }),
      /deterministic action violation/,
      `a ${action} refusal cannot claim the engine performed it`,
    );
  }

  // And the refusal cannot be replaced by a success. A `memory.stored` in the
  // reserve refusal's place is a well-formed event the reducer would accept —
  // the payment it is chained to says the agent decided to reserve, not to
  // store, and the verifier will not let an unimplemented action be laundered
  // into an outcome the engine can perform.
  const reserved = refusals.get("reserve");
  assert.throws(
    () => replayWith(reserved.seq, (event) => ({
      ...event,
      type: "memory.stored",
      data: { agentId: event.actorId, key: "spoils", value: 5, action: "store" },
    })),
    /does not match its action payment/,
    "an unsupported action cannot produce a successful outcome event",
  );
});

test("the world and the verifier read one definition of what this engine cannot perform", async (t) => {
  // Single embodiment, checked at the source: the reason an unsupported
  // attempt is refused exists once. Two copies of that string would drift the
  // moment either side is edited, and the drift would only surface as a
  // refused live epoch.
  const rule = await readFile(new URL("../src/lab/action-rules.ts", import.meta.url), "utf8");
  assert.match(rule, /is unsupported in logical v1/, "the reason lives in action-rules.ts");

  for (const name of ["world", "protocol-verifier"]) {
    const source = await readFile(new URL(`../src/lab/${name}.ts`, import.meta.url), "utf8");
    assert.match(
      source,
      /import \{[^}]*unsupportedActionReason[^}]*\} from "\.\/action-rules\.js";/,
      `${name}.ts takes the reason from the shared rule`,
    );
    assert.equal(
      /is unsupported in logical v1/.test(source),
      false,
      `${name}.ts does not spell the reason a second time`,
    );
  }
  t.diagnostic("one embodiment of the unsupported-action rule");
});
