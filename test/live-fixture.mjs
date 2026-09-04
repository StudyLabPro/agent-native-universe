/**
 * Shared fixture for the Genesis-Live epoch tests.
 *
 * Not a `*.test.mjs` file on purpose: it is imported by the epoch tests and by
 * the crash driver that the boundary test spawns and kills.
 */
import { DEFAULT_GENESIS_CONFIG } from "../dist/lab/config.js";
import { computeEventHash } from "../dist/lab/events.js";

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
