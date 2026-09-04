/**
 * Shared fixture for the Genesis-Live epoch tests.
 *
 * Not a `*.test.mjs` file on purpose: it is imported by the epoch tests and by
 * the crash driver that the boundary test spawns and kills.
 */
import { DEFAULT_GENESIS_CONFIG } from "../dist/lab/config.js";
import { computeEventHash } from "../dist/lab/events.js";
import { deterministicId } from "../dist/lab/ids.js";

export const LIVE_TEST_COGNITION_ID = "cognition-live-test-v1:scripted:cb65536";

/**
 * A live universe small enough to run three epochs in a test: four agents,
 * 50-tick epochs, a five-tick task deadline (so calibration generation stops
 * six ticks before an epoch ends) and no configured pressure schedule — a live
 * universe takes its physics from recorded operator input instead.
 */
export function liveTestConfig(overrides = {}) {
  return {
    ...structuredClone(DEFAULT_GENESIS_CONFIG),
    experimentId: "genesis-live",
    seed: "genesis-live-test",
    agents: 4,
    ticks: 50,
    metricEvery: 10,
    checkpointEvery: 10,
    pressures: [],
    taskStream: {
      ...structuredClone(DEFAULT_GENESIS_CONFIG.taskStream),
      tasksPerTick: 2,
      deadlineTicks: 5,
    },
    live: {
      epochTicks: 50,
      tiers: {
        fast: { pricePpm: 1_000_000 },
        standard: { pricePpm: 3_000_000 },
        deliberate: { pricePpm: 8_000_000 },
      },
      exhaustion: { minThinkTokens: 1_000, graceTicks: 10 },
      archive: { taskTicks: 200, messageTicks: 200, submissionTicks: 200 },
      fsyncEveryTick: true,
    },
    ...overrides,
  };
}

/**
 * A deterministic stand-in for `LiveCognition`: no provider, no network, but
 * the same contract — one recorded answer per active agent, whose actions the
 * world applies through the same `CohortPolicy` a real live epoch uses.
 *
 * `silent: true` returns no records at all, which is how the tests prove that
 * an unsteered live agent idles instead of receiving a computed answer.
 */
export function scriptedLiveCognition({
  id = LIVE_TEST_COGNITION_ID,
  silent = false,
  tier = "fast",
} = {}) {
  return {
    id,
    cohort: "C",
    async propose(requests) {
      if (silent) return [];
      return requests.map((request) => {
        const available = request.observation.tasks.filter((task) => task.status === "available");
        const mine = request.observation.tasks.filter(
          (task) => task.status === "claimed" && task.claimedBy === request.agentId,
        );
        const actions = mine.length > 0
          ? [{ type: "submit", taskId: mine[0].id, result: mine[0].input }]
          : available.length > 0
            ? [{ type: "claimTask", taskId: available[0].id }]
            : [{ type: "observe" }];
        return {
          tick: request.tick,
          agentId: request.agentId,
          cohort: "C",
          provider: "scripted",
          model: "scripted-live",
          content: JSON.stringify({ actions }),
          usage: { inputTokens: 8, outputTokens: 8, totalTokens: 16 },
          latencyMs: 1,
          actions,
          // A live record states the tier it was consulted at: the world
          // charges `llmTokens` for the thought at that tier's price.
          tier,
        };
      });
    },
  };
}

/**
 * Re-link and re-sign a tampered event list so the hash chain is internally
 * consistent again.
 *
 * Without this a forged event is caught by the chain before the protocol
 * verifier ever looks at it, and a test that expected the verifier to refuse
 * the forgery would pass for the wrong reason. Re-signing removes the cheap
 * refusal and leaves only the expensive one: whether the rules regenerate what
 * the events claim.
 */
export function resignEventChain(events) {
  const resigned = [];
  let previousHash = events[0].previousHash;
  for (const event of events) {
    const next = { ...structuredClone(event), previousHash };
    delete next.hash;
    next.hash = computeEventHash(next);
    previousHash = next.hash;
    resigned.push(next);
  }
  return resigned;
}

/**
 * A live cognition that consults a rotating subset of the population, the way
 * a real `LiveCognition` does (`agentsPerTick`), and whose agents do enough to
 * exercise every archived record kind: they connect to a neighbour, send it
 * mail, claim work and submit it.
 *
 * Deterministic in the tick and the agent id alone — no clock, no randomness —
 * so a replay of the recorded answers reproduces the run exactly.
 */
export function rotatingLiveCognition({
  id = LIVE_TEST_COGNITION_ID,
  agentsPerTick = 4,
  tier = "fast",
} = {}) {
  return {
    id,
    cohort: "C",
    async propose(requests) {
      const ordered = [...requests].sort((left, right) => (left.agentId < right.agentId ? -1 : 1));
      if (ordered.length === 0) return [];
      const tick = ordered[0].tick;
      const offset = (tick * agentsPerTick) % ordered.length;
      const consulted = [];
      for (let index = 0; index < Math.min(agentsPerTick, ordered.length); index += 1) {
        consulted.push(ordered[(offset + index) % ordered.length]);
      }
      return consulted.map((request, index) => {
        const observation = request.observation;
        const mine = observation.tasks.filter(
          (task) => task.status === "claimed" && task.claimedBy === request.agentId,
        );
        const available = observation.tasks.filter((task) => task.status === "available");
        const neighbours = observation.neighbors;
        const strangers = observation.visibleAgents.filter((agent) => !neighbours.includes(agent));
        // Each consulted agent takes a different task, so a tick's consultations
        // do not collide on the same one, and it claims and submits within the
        // same tick so the world reaches its steady state early instead of
        // spending the first epochs filling up. Mail goes out alongside, so all
        // three archivable record kinds occur.
        const work = mine.length > 0
          ? [{ type: "submit", taskId: mine[0].id, result: mine[0].input }]
          : available.length > 0
            ? [
              { type: "claimTask", taskId: available[index % available.length].id },
              { type: "submit", taskId: available[index % available.length].id, result: available[index % available.length].input },
            ]
            : [];
        const social = neighbours.length === 0 && strangers.length > 0
          ? [{ type: "connect", targetId: strangers[index % strangers.length] }]
          : neighbours.length > 0
            ? [{ type: "send", targetId: neighbours[0], payload: { tick } }]
            : [];
        const actions = [...work, ...social];
        if (actions.length === 0) actions.push({ type: "observe" });
        return {
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
        };
      });
    },
  };
}

/**
 * A provider that is down: one record per requested agent, every one of them
 * `unavailable`, which is exactly what `LiveCognition` returns when the gateway
 * refuses. The world still records them — an outage is evidence, not a gap —
 * and every agent then idles through `LiveIdlePolicy`.
 */
export function failingLiveCognition({ id = LIVE_TEST_COGNITION_ID } = {}) {
  return {
    id,
    cohort: "C",
    async propose(requests) {
      return requests.map((request) => ({
        tick: request.tick,
        agentId: request.agentId,
        cohort: "C",
        provider: "unavailable",
        model: "unavailable",
        content: "",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        latencyMs: 0,
        actions: [],
        tier: "fast",
        rejected: "provider failure: injected outage",
      }));
    },
  };
}

/**
 * Renumber a contiguous slice of a chain densely from its first sequence, then
 * re-sign it.
 *
 * `eventId` is `deterministicId("event", runId, universeId, seq)`, so removing
 * or inserting an event invalidates every later id as well as every later
 * hash. Renumbering is only sound where nothing that survives refers to a
 * shifted event — no `causationId` pointing across the edit, no payload that
 * embedded its own `seq` (`message.sent`, `task.submitted`) — which is the
 * caller's responsibility to establish, usually by editing near the end of a
 * truncated prefix.
 */
export function resequenceEventChain(events, manifest) {
  const first = events[0].seq;
  return resignEventChain(events.map((event, index) => ({
    ...structuredClone(event),
    seq: first + index,
    eventId: deterministicId("event", manifest.runId, manifest.universeId, first + index),
  })));
}

/**
 * A live cognition that builds one star of links and then posts mail into it:
 * every agent connects to the lexicographically first one and sends to it from
 * then on. One inbox therefore passes `PUBLIC_INBOX_WINDOW` quickly, which is
 * what lets the message archive window bite inside a short epoch.
 */
export function messagingLiveCognition({ id = LIVE_TEST_COGNITION_ID, tier = "fast" } = {}) {
  return {
    id,
    cohort: "C",
    async propose(requests) {
      return requests.map((request) => {
        const observation = request.observation;
        const hub = [...observation.visibleAgents].sort()[0];
        const actions = hub === undefined
          ? [{ type: "observe" }]
          : observation.neighbors.includes(hub)
            ? [{ type: "send", targetId: hub, payload: { tick: request.tick } }]
            : [{ type: "connect", targetId: hub }];
        return {
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
        };
      });
    },
  };
}
