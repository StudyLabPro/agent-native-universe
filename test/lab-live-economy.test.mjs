/**
 * The economy of thinking in a Genesis-Live epoch (design §4.E, phase L3b).
 *
 * What is proven here: a thought is paid for inside the world, from the same
 * `llmTokens` balance every other action draws on; the debit is committed
 * IMMEDIATELY after the `cognition.recorded` that caused it, with nothing in
 * between; an agent that does nothing but think spends itself down to nothing,
 * overdraws once, says so, and is retired `'exhausted'` after the configured
 * grace period; resources are conserved on every single tick of the run; and
 * the whole economy replays from the events alone, because the protocol
 * verifier recomputes every debit rather than trusting it.
 *
 * Nothing here touches a provider, a network or a clock: the cognition port is
 * a scripted stand-in, exactly as in the other live tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PPM } from "../dist/lab/types.js";
import { liveThinkingCost } from "../dist/lab/epoch-rules.js";
import { ReplayEngine } from "../dist/lab/replay.js";
import { LiveIdlePolicy } from "../dist/lab/live/live-idle-policy.js";
import { openLiveEpochEvidence, runLiveUniverse, verifyLiveChain } from "../dist/lab/live/epoch.js";
import { LIVE_UNIVERSE_ID } from "../dist/lab/live/identity.js";
import { liveTestConfig, resignEventChain } from "./live-fixture.mjs";

const RESOURCES = ["credits", "llmTokens", "computeMs", "storageBytes", "bandwidthBytes"];
/** Tokens the scripted thinker burns per consultation. */
const TOKENS_PER_THOUGHT = 2_000;

async function tempDir(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function readEvents(dataRoot, runId) {
  const store = openLiveEpochEvidence(dataRoot, LIVE_UNIVERSE_ID, runId);
  const text = await readFile(store.eventsPath, "utf8");
  return text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

/**
 * A universe of one thinker. Exactly one agent is consulted, every tick, at
 * the most expensive tier and with a fat token bill; every other agent is
 * silent and therefore idles through `LiveIdlePolicy`, holding its balance.
 *
 * That asymmetry is the point: the retirement below has to be caused by what
 * the thinker spent, not by anything the population shares.
 */
function thinkerCognition(thinkerId, tier = "deliberate") {
  return {
    id: "cognition-live-test-v1:thinker:cb65536",
    cohort: "C",
    async propose(requests) {
      return requests
        .filter((request) => request.agentId === thinkerId)
        .map((request) => ({
          tick: request.tick,
          agentId: request.agentId,
          cohort: "C",
          provider: "scripted",
          model: "scripted-live",
          content: JSON.stringify({ actions: [{ type: "observe" }] }),
          usage: {
            inputTokens: TOKENS_PER_THOUGHT / 2,
            outputTokens: TOKENS_PER_THOUGHT / 2,
            totalTokens: TOKENS_PER_THOUGHT,
          },
          latencyMs: 1,
          actions: [{ type: "observe" }],
          tier,
        }));
    },
  };
}

function economyConfig() {
  const base = liveTestConfig();
  return {
    ...base,
    // Short epoch, a checkpoint on every tick: conservation is then a claim
    // about the recorded states, not about the final one only.
    checkpointEvery: 1,
    metricEvery: 5,
    live: { ...structuredClone(base.live), epochTicks: 24 },
  };
}

test("thinking is paid for from the world's own balance, debited immediately after the record", async (t) => {
  const root = await tempDir(t, "anu-live-economy-");
  const config = economyConfig();
  const thinkerId = "N0001";
  const [epoch] = await runLiveUniverse({
    dataRoot: root,
    config,
    cognition: thinkerCognition(thinkerId),
    epochs: 1,
  });

  const events = await readEvents(root, epoch.runId);
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  const debits = events.filter(
    (event) => event.type === "resource.spent" && event.phase === "observation",
  );
  assert.ok(debits.length > 0, "the thinker was charged for thinking");

  // 1. The debit always immediately follows its `cognition.recorded`.
  for (const debit of debits) {
    const previous = bySeq.get(debit.seq - 1);
    assert.equal(previous.type, "cognition.recorded", "nothing comes between a thought and its price");
    assert.equal(debit.causationId, previous.eventId, "the debit is caused by the record it pays for");
    assert.equal(previous.actorId, debit.actorId);
    assert.equal(debit.actorId, thinkerId, "only the agent that thought is charged");
    assert.equal(debit.data.action, "reason", "a thought is charged as the action it is");
    assert.equal(debit.targetId, undefined);
  }
  // And every recorded thought has one: no thought is free.
  const records = events.filter((event) => event.type === "cognition.recorded");
  assert.equal(
    records.length,
    debits.length,
    "every recorded thought is followed by exactly one debit",
  );

  // 2. The price is the tier price of the recorded usage — not something the
  //    record asserts. `deliberate` is 8x, so 2 000 tokens cost 16 000.
  const fullPrice = liveThinkingCost(config, { resourcePricePpm: {
    credits: PPM, llmTokens: PPM, computeMs: PPM, storageBytes: PPM, bandwidthBytes: PPM,
  }, bandwidthCapacityPpm: PPM, taskLoadPpm: PPM }, "deliberate", TOKENS_PER_THOUGHT);
  assert.equal(fullPrice.llmTokens, 16_000);
  assert.equal(debits[0].data.cost.llmTokens, 16_000, "the first thought is charged in full");
  assert.deepEqual(
    debits[0].data.cost,
    fullPrice,
    "the other four resources are the configured price of the reason action",
  );

  // 3. The balance runs out. 100 000 llmTokens buys six full thoughts; the
  //    seventh is charged down to zero and recorded as an overdraft.
  const charged = debits.map((event) => event.data.cost.llmTokens);
  assert.deepEqual(charged.slice(0, 6), Array(6).fill(16_000));
  assert.equal(charged[6], 4_000, "the seventh thought is charged only what is left");
  assert.deepEqual(charged.slice(7), Array(charged.length - 7).fill(0), "a broke agent pays nothing more");

  const overdrafts = events.filter(
    (event) => event.type === "violation.recorded" && event.phase === "observation",
  );
  assert.ok(overdrafts.length > 0, "the shortfall is on record, not silently forgiven");
  for (const overdraft of overdrafts) {
    assert.equal(overdraft.data.reason, "cognition overdraft");
    assert.equal(overdraft.data.action, "reason");
    assert.equal(overdraft.actorId, thinkerId);
    const previous = bySeq.get(overdraft.seq - 1);
    assert.equal(previous.type, "resource.spent");
    assert.equal(overdraft.causationId, previous.eventId, "the violation is caused by the debit that overdrew");
  }
  assert.equal(overdrafts[0].tick, debits[6].tick, "the overdraft is the tick the balance ran out");

  // 4. The thinker is retired `exhausted` — in the upkeep, with no causal
  //    parent, after `graceTicks` consecutive starving ticks.
  const retirements = events.filter((event) => event.type === "agent.retired");
  assert.equal(retirements.length, 1, "exactly one agent leaves, and it is the one that spent itself");
  const retirement = retirements[0];
  assert.equal(retirement.actorId, thinkerId);
  assert.equal(retirement.data.reason, "exhausted");
  assert.equal(retirement.phase, "upkeep");
  assert.equal(retirement.causationId, undefined, "exhaustion has no cause but the agent's own balance");
  const starvedFrom = debits[6].tick;
  assert.equal(
    retirement.tick,
    starvedFrom + config.live.exhaustion.graceTicks - 1,
    "retirement lands on the graceTicks-th consecutive starving tick",
  );
  // Nothing is consulted after it leaves.
  assert.equal(
    records.filter((event) => event.tick > retirement.tick).length,
    0,
    "a retired agent is never consulted again",
  );
  const store = openLiveEpochEvidence(root, LIVE_UNIVERSE_ID, epoch.runId);
  const finalCheckpoint = await store.readCheckpoint(epoch.ticks);
  const thinker = finalCheckpoint.state.agents[thinkerId];
  assert.equal(thinker.active, false);
  assert.equal(thinker.retiredTick, retirement.tick);
  assert.equal(thinker.resources.llmTokens, 0, "it left with nothing to think with");
  for (const [agentId, agent] of Object.entries(finalCheckpoint.state.agents)) {
    if (agentId === thinkerId) continue;
    assert.equal(agent.active, true, "a silent agent keeps its balance and stays");
    assert.equal(agent.resources.llmTokens, config.initialResources.llmTokens);
  }

  // 5. Conservation, on every tick of the run rather than at the end.
  const genesis = await store.readCheckpoint(1);
  const expectedTotal = totalResources(genesis.state);
  for (let tick = 1; tick <= epoch.ticks; tick += 1) {
    const checkpoint = await store.readCheckpoint(tick);
    assert.ok(checkpoint !== undefined, `tick ${tick} has a checkpoint`);
    assert.deepEqual(
      totalResources(checkpoint.state),
      expectedTotal,
      `resources are conserved on tick ${tick}`,
    );
  }
  // The tokens the thinker no longer holds are in the treasury, not gone.
  assert.equal(
    finalCheckpoint.state.resourceSpent.llmTokens,
    config.initialResources.llmTokens,
    "every llmToken the thinker held was spent through the world, not evaporated",
  );

  // 6. The verifier recomputes all of it: the debits, the overdraft and the
  //    retirement are regenerated from the states, so a run cannot under-charge
  //    itself for thinking or retire an agent that was still solvent.
  const manifest = await store.readManifest();
  const stored = await store.readConfig();
  const replay = await ReplayEngine.replayFile(store.eventsPath, manifest, stored, undefined, {
    live: { createFallbackPolicy: () => new LiveIdlePolicy() },
  });
  assert.equal(replay.stateHash, epoch.summary.finalStateHash);
  const audit = await verifyLiveChain({ dataRoot: root });
  assert.equal(audit.finalStateHash, epoch.summary.finalStateHash);

  // A run that under-charged itself is refused, and so is one that retires an
  // agent the rule would not have retired.
  //
  //    The forged chains below are RE-SIGNED, so the hash chain accepts them
  //    and the only thing left to refuse them is the rule itself.
  const replayWith = (mutate) => ReplayEngine.replay(
    resignEventChain(
      events.map((event) => (event.seq === mutate.seq ? mutate.event(structuredClone(event)) : event)),
    ),
    manifest,
    stored,
    undefined,
    { live: { createFallbackPolicy: () => new LiveIdlePolicy() } },
  );
  assert.throws(() => replayWith({
    seq: debits[0].seq,
    event: (event) => {
      event.data.cost.llmTokens = 1;
      return event;
    },
  }), /thinking debit/i, "an under-charged thought is refused by the recomputed price");
  assert.throws(() => replayWith({
    seq: retirement.seq,
    event: (event) => {
      event.data.agentId = "N0002";
      event.actorId = "N0002";
      return event;
    },
  }), /exhaustion retirement/i, "an agent the rule would not retire cannot be retired");
  assert.throws(() => replayWith({
    seq: debits[0].seq,
    event: (event) => {
      event.causationId = records[0].eventId.replace(/.$/, "0");
      return event;
    },
  }), /thinking debit/i, "a debit that names another cause is not the price of this thought");
});

test("the exhaustion clock is continuous across an epoch boundary", async (t) => {
  const root = await tempDir(t, "anu-live-starving-");
  const base = liveTestConfig();
  // Twelve-tick epochs. The thinker's balance runs out on tick 7, so it is
  // starving for six ticks of epoch 0 and four of epoch 1. A clock that
  // restarted at the boundary would retire it on tick 22 instead of 16 — the
  // grace period belongs to the universe, not to the epoch.
  const config = {
    ...base,
    checkpointEvery: 1,
    metricEvery: 4,
    live: { ...structuredClone(base.live), epochTicks: 12 },
  };
  const thinkerId = "N0001";
  const results = await runLiveUniverse({
    dataRoot: root,
    config,
    cognition: thinkerCognition(thinkerId),
    epochs: 2,
  });

  const first = await readEvents(root, results[0].runId);
  assert.equal(
    first.filter((event) => event.type === "agent.retired").length,
    0,
    "the grace period has not run out inside the first epoch",
  );
  // The clock crosses the boundary inside the inherited genesis, and is the
  // parent's count at its final tick.
  const childConfig = await openLiveEpochEvidence(root, LIVE_UNIVERSE_ID, results[1].runId).readConfig();
  assert.deepEqual(
    childConfig.live.genesisFrom.runtime.exhaustion,
    { starving: [{ agentId: thinkerId, ticks: 6 }] },
    "the child inherits how long the thinker has already been starving",
  );

  const second = await readEvents(root, results[1].runId);
  const retirements = second.filter((event) => event.type === "agent.retired");
  assert.equal(retirements.length, 1);
  assert.equal(retirements[0].actorId, thinkerId);
  assert.equal(retirements[0].data.reason, "exhausted");
  assert.equal(
    retirements[0].tick,
    16,
    "the tenth consecutive starving tick, counted across the boundary rather than from it",
  );

  // The full chain audit re-derives the inherited genesis from the parent's
  // replayed final state, so the inherited clock is verified, not trusted.
  const audit = await verifyLiveChain({ dataRoot: root });
  assert.equal(audit.epochs.length, 2);
  assert.equal(audit.finalStateHash, results[1].summary.finalStateHash);
});

test("a live cognition record that names no tier cannot be priced, and is refused", async (t) => {
  const root = await tempDir(t, "anu-live-untiered-");
  const untiered = {
    id: "cognition-live-test-v1:untiered:cb65536",
    cohort: "C",
    async propose(requests) {
      return requests.map((request) => ({
        tick: request.tick,
        agentId: request.agentId,
        cohort: "C",
        provider: "scripted",
        model: "scripted-live",
        content: JSON.stringify({ actions: [{ type: "observe" }] }),
        usage: { inputTokens: 4, outputTokens: 4, totalTokens: 8 },
        latencyMs: 1,
        actions: [{ type: "observe" }],
      }));
    },
  };
  await assert.rejects(
    () => runLiveUniverse({ dataRoot: root, config: economyConfig(), cognition: untiered, epochs: 1 }),
    /must state the tier/,
  );
});

function totalResources(state) {
  const total = { ...state.treasury };
  for (const agent of Object.values(state.agents)) {
    for (const resource of RESOURCES) total[resource] += agent.resources[resource];
  }
  return total;
}
