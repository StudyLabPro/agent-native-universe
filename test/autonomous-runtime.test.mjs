import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContinuousMetaAgentController,
  DistributedDiscoveryMesh,
  EncryptedTcpTransport,
  MeshIdentity,
  MeteredCognitiveLoop,
  NetworkByzantineNode,
  PersistentResourceEconomy,
} from "../dist/autonomous.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(10);
  }
  assert.fail("condition was not reached before timeout");
}

class FakeAgent {
  constructor(id, spec) {
    this.id = id;
    this.state = {
      objective: { primary: spec.objective ?? id, secondary: [] },
      exposedState: structuredClone(spec.exposedState ?? {}),
      durableState: {},
      privateState: {},
      ephemeralState: {},
      capabilities: structuredClone(spec.capabilities ?? []),
      needs: structuredClone(spec.needs ?? []),
      generation: 0,
      links: [],
      networkPolicy: { maxLinks: 8, minCompatibility: 0.2, maxCommunicationCost: 8 },
    };
    this.consumed = { tokens: 0, latencyMs: 0 };
  }
  snapshot() { return structuredClone(this.state); }
  expose(delta) { Object.assign(this.state.exposedState, structuredClone(delta)); }
  remember(delta) { Object.assign(this.state.durableState, structuredClone(delta)); }
  think(delta) { Object.assign(this.state.privateState, structuredClone(delta)); }
  setEphemeral(delta) { this.state.ephemeralState = deepMerge(this.state.ephemeralState, delta); }
  consumeBudget(kind, amount) { this.consumed[kind] = (this.consumed[kind] ?? 0) + amount; }
}

function deepMerge(left, right) {
  const output = structuredClone(left);
  for (const [key, value] of Object.entries(right)) {
    output[key] = value && typeof value === "object" && !Array.isArray(value)
      ? deepMerge(output[key] ?? {}, value)
      : structuredClone(value);
  }
  return output;
}

test("encrypted mesh transport hides plaintext, authenticates peers and rejects tampering", async () => {
  const alice = MeshIdentity.generate("alice");
  const bob = MeshIdentity.generate("bob");
  const aliceTransport = new EncryptedTcpTransport(alice);
  const bobTransport = new EncryptedTcpTransport(bob);
  const aliceAddress = await aliceTransport.start({ host: "127.0.0.1", port: 0 });
  const bobAddress = await bobTransport.start({ host: "127.0.0.1", port: 0 });
  aliceTransport.addPeer(bob.publicIdentity());
  bobTransport.addPeer(alice.publicIdentity());

  let raw = "";
  aliceTransport.observeRawFrames((bytes, direction) => {
    if (direction === "out") raw = Buffer.from(bytes).toString("utf8");
  });
  const received = new Promise((resolve) => bobTransport.onMessage(resolve));
  await aliceTransport.send(
    { identity: bob.publicIdentity(), address: bobAddress },
    "secret.topic",
    { secret: "the-network-must-not-see-this" },
  );
  const message = await received;
  assert.deepEqual(message.payload, { secret: "the-network-must-not-see-this" });
  assert.equal(raw.includes("the-network-must-not-see-this"), false);

  const sealed = aliceTransport.codec.seal(bob.publicIdentity(), "secret.topic", { value: 7 });
  const tampered = { ...sealed, ciphertext: `${sealed.ciphertext.slice(0, -2)}AA` };
  assert.throws(() => bobTransport.codec.open(tampered), /signature|decrypt|authenticate|invalid/i);
  assert.deepEqual(bobTransport.codec.open(sealed), { value: 7 });
  assert.throws(() => bobTransport.codec.open(sealed), /replay/i);

  await aliceTransport.stop();
  await bobTransport.stop();
  assert.ok(aliceAddress.port > 0);
});

test("agents on different machines discover, negotiate and alternate boundary synchronization", async () => {
  const leftIdentity = MeshIdentity.generate("node-left");
  const rightIdentity = MeshIdentity.generate("node-right");
  const leftTransport = new EncryptedTcpTransport(leftIdentity);
  const rightTransport = new EncryptedTcpTransport(rightIdentity);
  const leftAddress = await leftTransport.start({ host: "127.0.0.1", port: 0 });
  const rightAddress = await rightTransport.start({ host: "127.0.0.1", port: 0 });
  const leftPeer = { identity: leftIdentity.publicIdentity(), address: leftAddress };
  const rightPeer = { identity: rightIdentity.publicIdentity(), address: rightAddress };
  const leftMesh = new DistributedDiscoveryMesh(leftIdentity.id, leftTransport);
  const rightMesh = new DistributedDiscoveryMesh(rightIdentity.id, rightTransport);
  leftMesh.addPeer(rightPeer);
  rightMesh.addPeer(leftPeer);
  leftMesh.start();
  rightMesh.start();

  const consumer = new FakeAgent("consumer", {
    objective: "consume result",
    capabilities: [{ id: "consumer", accepts: ["result"], produces: ["request"] }],
    needs: [{ accepts: ["result"] }],
    exposedState: { request: "latest" },
  });
  const producer = new FakeAgent("producer", {
    objective: "produce result",
    capabilities: [{ id: "producer", accepts: ["request"], produces: ["result"] }],
    needs: [{ accepts: ["request"] }],
    exposedState: { result: 42 },
  });
  leftMesh.registerAgent(consumer);
  rightMesh.registerAgent(producer);
  await Promise.all([leftMesh.announceAll(), rightMesh.announceAll()]);
  await eventually(() => leftMesh.remoteAdvertisements().length === 1 && rightMesh.remoteAdvertisements().length === 1);

  const [candidate] = leftMesh.candidates();
  assert.ok(candidate);
  const relationship = await leftMesh.negotiate(candidate);
  await eventually(() => rightMesh.relationships().length === 1);
  assert.equal(relationship.remoteAgentId, "producer");

  await leftMesh.synchronize(relationship.id);
  await eventually(() => producer.snapshot().ephemeralState.distributedBoundaries !== undefined);
  const mirrored = rightMesh.relationships()[0];
  assert.ok(mirrored);
  await rightMesh.synchronize(mirrored.id);
  await eventually(() => consumer.snapshot().ephemeralState.distributedBoundaries !== undefined);
  assert.equal(leftMesh.relationships()[0].revisions, 2);
  assert.equal(rightMesh.relationships()[0].revisions, 2);

  leftMesh.stop();
  rightMesh.stop();
  await leftTransport.stop();
  await rightTransport.stop();
});

test("BFT leader collects independent votes over encrypted network and commits with one replica offline", async () => {
  const identities = [0, 1, 2, 3].map((index) => MeshIdentity.generate(`r${index}`));
  const transports = identities.map((identity) => new EncryptedTcpTransport(identity));
  const addresses = await Promise.all(transports.map((transport) => transport.start({ host: "127.0.0.1", port: 0 })));
  const committee = identities.map((identity, index) => ({ identity: identity.publicIdentity(), address: addresses[index] }));
  const applied = identities.map(() => []);
  const nodes = identities.map((identity, index) => new NetworkByzantineNode(identity, transports[index], committee, {
    validateCommand: (command) => command.type === "graph.change",
    applyCommit: (certificate) => { applied[index].push(certificate.proposal.command.id); },
    voteTimeoutMs: 2_000,
  }));
  nodes.forEach((node) => node.start());

  nodes[3].stop();
  await transports[3].stop();
  const certificate = await nodes[0].propose("graph.change", { value: 1 });
  assert.equal(certificate.votes.length, 3);
  await eventually(() => applied[0].length === 1 && applied[1].length === 1 && applied[2].length === 1);
  assert.equal(nodes[0].sequence, 1);
  assert.equal(nodes[1].sequence, 1);
  assert.equal(nodes[2].sequence, 1);

  nodes.slice(0, 3).forEach((node) => node.stop());
  await Promise.all(transports.slice(0, 3).map((transport) => transport.stop()));
});

test("persistent market reserves both sides, prevents double-selling and recovers open orders", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anu-economy-"));
  let economy = await PersistentResourceEconomy.open(directory);
  await economy.mint("seller", "compute_ms", 100);
  await economy.mint("buyer", "credits", 1_000);
  const offer = await economy.placeOffer({
    seller: "seller",
    resource: "compute_ms",
    quantity: 80,
    unitPrice: 2,
    minimumFill: 1,
    expiresAt: Date.now() + 60_000,
  });
  assert.equal(economy.balance("seller", "compute_ms"), 20);
  assert.equal(economy.balance(offer.escrowAccount, "compute_ms"), 80);
  await assert.rejects(() => economy.placeOffer({
    seller: "seller",
    resource: "compute_ms",
    quantity: 30,
    unitPrice: 1,
    minimumFill: 1,
    expiresAt: Date.now() + 60_000,
  }), /insufficient/);
  const bid = await economy.placeBid({
    buyer: "buyer",
    resource: "compute_ms",
    quantity: 20,
    maxUnitPrice: 3,
    expiresAt: Date.now() + 60_000,
  });
  assert.equal(economy.balance("buyer", "credits"), 940);
  assert.equal(economy.balance(bid.escrowAccount, "credits"), 60);

  economy = await PersistentResourceEconomy.open(directory);
  assert.equal(economy.offers().filter((value) => value.state === "open").length, 1);
  assert.equal(economy.bids().filter((value) => value.state === "open").length, 1);
  const [trade] = await economy.match();
  assert.ok(trade);
  await economy.settleTrade(trade.id);
  assert.equal(economy.balance("buyer", "compute_ms"), 20);
  assert.equal(economy.balance("seller", "credits"), 40);
  assert.equal(economy.balance("buyer", "credits"), 960);
  assert.equal(economy.assertConserved("compute_ms"), true);
  assert.equal(economy.assertConserved("credits"), true);
});

test("LLM cognition changes the agent and automatically settles actual token and credit usage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anu-cognition-"));
  const economy = await PersistentResourceEconomy.open(directory);
  await economy.mint("agent:one", "model_tokens", 2_000);
  await economy.mint("agent:one", "credits", 100);
  const llm = {
    async complete() {
      return {
        provider: "fake-provider",
        model: "fake-model",
        content: JSON.stringify({
          privateState: { hypothesis: "signal is useful" },
          exposedState: { recommendation: "act" },
          durableState: { learned: true },
          ephemeralState: { attention: "signal" },
          actions: [{ type: "relationship.sync", payload: { id: "r1" } }],
          summary: "updated local world",
        }),
        usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
        latencyMs: 5,
      };
    },
  };
  const agent = new FakeAgent("agent:one", { objective: "decide", exposedState: { signal: 1 } });
  const actions = [];
  const loop = new MeteredCognitiveLoop(economy, llm, {
    providerAccount: "provider:fake",
    reserveOutputTokens: 100,
    inputCreditsPerThousand: 100,
    outputCreditsPerThousand: 100,
  });
  const result = await loop.think(agent, { actionHandler: (_agent, action) => actions.push(action) });
  assert.equal(result.chargedModelTokens, 20);
  assert.equal(result.chargedCredits, 2);
  assert.equal(economy.balance("agent:one", "model_tokens"), 1_980);
  assert.equal(economy.balance("provider:fake", "model_tokens"), 20);
  assert.equal(economy.balance("agent:one", "credits"), 98);
  assert.equal(economy.balance("provider:fake", "credits"), 2);
  assert.equal(agent.snapshot().exposedState.recommendation, "act");
  assert.equal(agent.snapshot().durableState.learned, true);
  assert.equal(actions.length, 1);
});

class FakeFractalGraph {
  constructor() {
    this.agents = [
      { id: "a", kind: "nano", capabilities: ["sense"], exposedState: {}, lineage: [] },
      { id: "b", kind: "nano", capabilities: ["decide"], exposedState: {}, lineage: [] },
      { id: "outside", kind: "nano", capabilities: ["act"], exposedState: {}, lineage: [] },
    ];
    this.links = [
      { id: "ab", left: "a", right: "b", protocol: {}, strength: 0.9 },
      { id: "bo", left: "b", right: "outside", protocol: {}, strength: 0.8 },
    ];
    this.metaAgents = [];
  }
  projection() { return structuredClone({ agents: this.agents, links: this.links, metaAgents: this.metaAgents }); }
  detectClusters(minStrength = 0.7) {
    if (this.metaAgents.length > 0) return [];
    return this.links.find((link) => link.id === "ab" && link.strength >= minStrength) ? [["a", "b"]] : [];
  }
  foldCluster(members, id) {
    const meta = { id, kind: "meta", capabilities: ["decide", "sense"], exposedState: {}, lineage: [...members], members, depth: 1 };
    this.metaAgents.push(meta);
    this.agents.push(meta);
    this.links = this.links.filter((link) => link.id !== "ab").map((link) => ({
      ...link,
      left: members.includes(link.left) ? id : link.left,
      right: members.includes(link.right) ? id : link.right,
    }));
    return structuredClone(meta);
  }
  unfold(id) {
    const meta = this.metaAgents.find((value) => value.id === id);
    if (!meta) throw new Error("missing meta");
    this.metaAgents = this.metaAgents.filter((value) => value.id !== id);
    this.agents = this.agents.filter((value) => value.id !== id);
    this.links = this.links.map((link) => ({ ...link, left: link.left === id ? "b" : link.left, right: link.right === id ? "b" : link.right }));
    this.links.push({ id: "ab", left: "a", right: "b", protocol: {}, strength: 0.9 });
    return structuredClone(meta);
  }
  getMetaAgent(id) { return structuredClone(this.metaAgents.find((value) => value.id === id)); }
}

test("stable clusters automatically fold into metaagents and weak boundaries automatically unfold", async () => {
  const graph = new FakeFractalGraph();
  const events = [];
  const controller = new ContinuousMetaAgentController(graph, {
    stableTicks: 2,
    unfoldTicks: 2,
    minStrength: 0.7,
    unfoldBelowStrength: 0.25,
    onEvent: (event) => events.push(event),
  });
  await controller.tick();
  assert.equal(graph.metaAgents.length, 0);
  await controller.tick();
  assert.equal(graph.metaAgents.length, 1);
  const metaId = graph.metaAgents[0].id;
  const boundary = graph.links.find((link) => link.left === metaId || link.right === metaId);
  boundary.strength = 0.1;
  await controller.tick();
  await controller.tick();
  assert.equal(graph.metaAgents.length, 0);
  assert.ok(events.some((event) => event.type === "folded"));
  assert.ok(events.some((event) => event.type === "unfolded"));
});

/* ------------------------------------------------------------------ *
 * Metering boundary regressions.
 *
 * A live run against a reasoning model on MWS Cloud showed three ways the
 * declared bound failed to bind: providers may ignore the requested output
 * cap, a solvent agent could exceed its reservation silently, and a thought
 * that failed after the provider had already answered was refunded in full.
 * See experiments/mws-kimi/verify.mjs.
 * ------------------------------------------------------------------ */

function fixedUsageLlm(totalTokens, content) {
  return {
    async complete() {
      return {
        provider: "fake-provider",
        model: "fake-model",
        content: content ?? JSON.stringify({ exposedState: { ok: true }, summary: "done" }),
        usage: { inputTokens: 10, outputTokens: totalTokens - 10, totalTokens },
        latencyMs: 3,
      };
    },
  };
}

test("an overrun is reported even when the reservation is topped up", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anu-overrun-topup-"));
  const economy = await PersistentResourceEconomy.open(directory);
  await economy.mint("agent:solvent", "model_tokens", 10_000);
  const agent = new FakeAgent("agent:solvent", { objective: "think" });
  const loop = new MeteredCognitiveLoop(economy, fixedUsageLlm(900), {
    providerAccount: "provider:x",
    reserveOutputTokens: 10,
    tokenSafetyFactor: 1,
  });

  const result = await loop.think(agent);

  assert.equal(result.chargedModelTokens, 900);
  assert.equal(result.overruns.length, 1);
  assert.equal(result.overruns[0].resource, "model_tokens");
  assert.ok(result.overruns[0].toppedUp > 0, "the top-up must be visible, not silent");
  assert.ok(result.overruns[0].required > result.overruns[0].reserved);
  assert.equal(economy.balance("provider:x", "model_tokens"), 900);
  assert.equal(economy.assertConserved("model_tokens"), true);
});

test("overrunPolicy reject turns the reservation into a real ceiling and still pays for delivered work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anu-overrun-reject-"));
  const economy = await PersistentResourceEconomy.open(directory);
  await economy.mint("agent:capped", "model_tokens", 10_000);
  const before = economy.balance("agent:capped", "model_tokens");
  const agent = new FakeAgent("agent:capped", { objective: "think" });
  const loop = new MeteredCognitiveLoop(economy, fixedUsageLlm(900), {
    providerAccount: "provider:x",
    reserveOutputTokens: 10,
    tokenSafetyFactor: 1,
    overrunPolicy: "reject",
  });

  const error = await loop.think(agent).then(
    () => null,
    (raised) => raised,
  );

  assert.ok(error, "a breached ceiling must surface");
  assert.equal(error.name, "CognitiveOverrunError");
  assert.equal(error.overrun.required, 900);
  assert.ok(error.overrun.toppedUp === 0);
  // The provider really did the work, so it is paid — but only up to the ceiling.
  const paid = economy.balance("provider:x", "model_tokens");
  assert.ok(paid > 0 && paid < 900, `expected a capped payment, got ${paid}`);
  assert.equal(before - economy.balance("agent:capped", "model_tokens"), paid);
  assert.equal(error.unbilled[0].delivered, 900);
  assert.equal(error.unbilled[0].billed, paid);
  assert.equal(economy.assertConserved("model_tokens"), true);
});

test("a thought that fails after the provider answered pays for the delivered tokens instead of refunding them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anu-postfail-"));
  const economy = await PersistentResourceEconomy.open(directory);
  await economy.mint("agent:parsefail", "model_tokens", 10_000);
  const before = economy.balance("agent:parsefail", "model_tokens");
  const agent = new FakeAgent("agent:parsefail", { objective: "think" });
  // Valid usage, unparseable content: the completion happened, the thought did not.
  const loop = new MeteredCognitiveLoop(economy, fixedUsageLlm(400, "not json at all"), {
    providerAccount: "provider:x",
    reserveOutputTokens: 5_000,
    tokenSafetyFactor: 1,
  });

  await assert.rejects(() => loop.think(agent));

  assert.equal(economy.balance("provider:x", "model_tokens"), 400);
  assert.equal(before - economy.balance("agent:parsefail", "model_tokens"), 400);
  assert.equal(economy.assertConserved("model_tokens"), true);
});

test("a thought that never reached the provider is still refunded in full", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anu-prefail-"));
  const economy = await PersistentResourceEconomy.open(directory);
  await economy.mint("agent:offline", "model_tokens", 10_000);
  const before = economy.balance("agent:offline", "model_tokens");
  const agent = new FakeAgent("agent:offline", { objective: "think" });
  const loop = new MeteredCognitiveLoop(
    economy,
    { async complete() { throw new Error("transport refused"); } },
    { providerAccount: "provider:x", reserveOutputTokens: 100 },
  );

  await assert.rejects(() => loop.think(agent), /transport refused/);

  assert.equal(economy.balance("agent:offline", "model_tokens"), before);
  assert.equal(economy.balance("provider:x", "model_tokens"), 0);
  assert.equal(economy.assertConserved("model_tokens"), true);
});
