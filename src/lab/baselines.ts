/**
 * Control arms for Genesis experiments.
 *
 * The self-organizing arm alone cannot answer the question the lab exists to
 * ask. If the neutral population reaches 95% task success, that number means
 * nothing until it stands next to what a centrally dispatched population, a
 * human-designed role hierarchy, and the same network with parts of its
 * freedom removed achieve on the same seed and the same task stream. These
 * baselines are those comparisons.
 *
 * Every baseline is a deterministic {@link LogicalPolicy} with a
 * manifest-bound identity, so a control run produces evidence of exactly the
 * same grade as the treatment: hash-chained, replayable, and verified by the
 * same protocol verifier that regenerates the decision stream. A control
 * whose evidence is weaker than the treatment's would not be a control.
 *
 * The arms follow the experiment plan's §33:
 *
 *   A — the self-organizing network (the neutral policy; not defined here)
 *   B — no metaagents: not applicable to the logical engine, which has none
 *   C — no resource economy: a config transform, {@link zeroCostConfig}
 *   D — no link adaptation: {@link NoLinkAdaptationPolicy}
 *   E — central orchestrator: {@link CentralDispatchPolicy}
 *   F — preassigned human roles: {@link FixedRolesPolicy}
 *
 * Roles and dispatch tables live entirely inside the policies. Genesis agents
 * stay role-neutral state, exactly like an org chart lives in management's
 * heads rather than in the employees' genomes — and exactly what
 * `assertRoleNeutralGenesis` continues to enforce.
 */

import { compareCodeUnits, hashValue } from "./canonical.js";
import {
  BASELINE_CENTRAL_DISPATCH_ID,
  BASELINE_FIXED_ROLES_ID,
  BASELINE_NO_LINKS_ID,
  LAB_POLICY_ID,
} from "./manifest.js";
import { NeutralPolicy, solveTask } from "./neutral-policy.js";
import type { NeutralPolicyRandomSource } from "./neutral-policy.js";
import type { LogicalPolicy } from "./policy-schedule.js";
import type {
  GenesisConfig,
  LabAgentState,
  Observation,
  ResourceVector,
  SubmissionObservation,
  TaskObservation,
  WorldAction,
} from "./types.js";

/**
 * Instantiate the deterministic policy a manifest names.
 *
 * The protocol verifier uses this to regenerate a baseline run's decision
 * stream the same way it regenerates the neutral one, so baseline evidence is
 * checked, not trusted. Unknown identities fail closed.
 */
export function createLogicalPolicyById(policyId: string): LogicalPolicy {
  switch (policyId) {
    case LAB_POLICY_ID:
      return new NeutralPolicy();
    case BASELINE_CENTRAL_DISPATCH_ID:
      return new CentralDispatchPolicy();
    case BASELINE_FIXED_ROLES_ID:
      return new FixedRolesPolicy();
    case BASELINE_NO_LINKS_ID:
      return new NoLinkAdaptationPolicy();
    default:
      throw new Error(`Unknown logical policy ${policyId}`);
  }
}

/**
 * Arm C: the same world with the economy switched off.
 *
 * Every action becomes free. Balances, rewards and the treasury remain — the
 * ablation removes the *pressure* of scarcity, not the bookkeeping, so the
 * metrics stay comparable. The transform changes the config hash, which gives
 * the run its own identity; nothing else distinguishes it from arm A.
 */
export function zeroCostConfig(config: GenesisConfig): GenesisConfig {
  const zero: ResourceVector = { credits: 0, llmTokens: 0, computeMs: 0, storageBytes: 0, bandwidthBytes: 0 };
  const next = structuredClone(config);
  for (const action of Object.keys(next.costs) as Array<keyof GenesisConfig["costs"]>) {
    next.costs[action] = structuredClone(zero);
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* Arm E — central orchestrator                                        */
/* ------------------------------------------------------------------ */

/**
 * A stationary dispatcher decides who works on what; nobody discovers,
 * negotiates, or connects. Each task is routed to exactly one agent by a fixed
 * hash of its id over the sorted roster, which removes claim races entirely —
 * the whole point of a central planner — and with them every coordination
 * cost the self-organizing arm has to pay.
 *
 * Stateless and RNG-free: a designed architecture has nothing to explore.
 */
export class CentralDispatchPolicy implements LogicalPolicy {
  readonly id = BASELINE_CENTRAL_DISPATCH_ID;

  decide(observation: Observation, agent: LabAgentState, _rng: NeutralPolicyRandomSource): WorldAction[] {
    if (observation.agentId !== agent.id) throw new Error("Observation belongs to another agent");
    if (!agent.active) return [];

    const work = continueClaimedWork(observation, agent);
    if (work) return [work];

    const roster = sortedRoster(observation);
    const mine = roster.indexOf(agent.id);
    if (mine === -1) return [];
    const assigned = availableTasks(observation)
      .filter((task) => dispatchIndex(task.id, roster.length) === mine)
      .sort((left, right) => compareCodeUnits(left.id, right.id));
    return assigned.length > 0 ? [{ type: "claimTask", taskId: assigned[0]!.id }] : [];
  }
}

/* ------------------------------------------------------------------ */
/* Arm F — preassigned human roles                                     */
/* ------------------------------------------------------------------ */

/**
 * The fully designed organization: both the roles and the routing are fixed
 * in advance. Roles are frozen from the first tick's roster — every fourth
 * agent is a verifier forever, everyone else a solver forever — so pressures
 * that retire agents thin a role out but never re-deal it. That rigidity is
 * the treatment being measured, and it also makes an author-verifier
 * impossible: an agent whose frozen role is verifier never submits.
 *
 * The frozen roster is instance state, which is safe for the same reason the
 * neutral policy's RNG streams are: the protocol verifier drives a fresh
 * instance through the identical call sequence, so it freezes the identical
 * roster. Baseline runs never resume, so the state never has to survive a
 * checkpoint.
 *
 * Verifiers recompute the public result of every submission dispatched to
 * them from the previous tick and attest to each one. They only target
 * submissions whose task already completed: the world would reject anything
 * else, and a designed QA role does not knowingly file rejectable paperwork.
 * They never see evaluator truth, so their verdicts stay exactly as blind as
 * any agent's.
 */
export class FixedRolesPolicy implements LogicalPolicy {
  readonly id = BASELINE_FIXED_ROLES_ID;
  #frozenRoster: string[] | undefined;

  decide(observation: Observation, agent: LabAgentState, _rng: NeutralPolicyRandomSource): WorldAction[] {
    if (observation.agentId !== agent.id) throw new Error("Observation belongs to another agent");
    if (!agent.active) return [];

    // The first observation any agent produces carries the complete genesis
    // population; every later tick may only shrink it.
    this.#frozenRoster ??= sortedRoster(observation);
    const roster = this.#frozenRoster;
    const mine = roster.indexOf(agent.id);
    if (mine === -1) return [];

    const alive = new Set(sortedRoster(observation));
    const verifiers = roster.filter((id, index) => isVerifierIndex(index) && alive.has(id));
    const solvers = roster.filter((id, index) => !isVerifierIndex(index) && alive.has(id));

    if (isVerifierIndex(mine)) {
      // Dispatch over the surviving verifiers, so a retirement narrows the
      // rota instead of orphaning its share of submissions.
      const rank = verifiers.indexOf(agent.id);
      if (rank === -1) return [];
      return lastTickSubmissions(observation)
        .filter((submission) => submission.agentId !== agent.id)
        .filter((submission) => submission.task.status === "completed")
        .filter((submission) => dispatchIndex(submission.id, verifiers.length) === rank)
        .sort((left, right) => compareCodeUnits(left.id, right.id))
        .map((submission) => {
          const computedResult = solveTask(submission.task);
          return {
            type: "verify" as const,
            submissionId: submission.id,
            computedResult,
            verdict: hashValue(computedResult) === hashValue(submission.result),
          };
        });
    }

    const work = continueClaimedWork(observation, agent);
    if (work) return [work];
    const rank = solvers.indexOf(agent.id);
    if (rank === -1) return [];
    const assigned = availableTasks(observation)
      .filter((task) => dispatchIndex(task.id, solvers.length) === rank)
      .sort((left, right) => compareCodeUnits(left.id, right.id));
    return assigned.length > 0 ? [{ type: "claimTask", taskId: assigned[0]!.id }] : [];
  }
}

/* ------------------------------------------------------------------ */
/* Arm D — no link adaptation                                          */
/* ------------------------------------------------------------------ */

/**
 * The neutral network with its relational freedom removed: identical task
 * behavior, identical randomness, but every topology action is suppressed
 * after the fact. The wrapped policy still draws from the same RNG streams,
 * so arm D differs from arm A in exactly one thing — no links ever form —
 * and any metric gap between them is attributable to the graph.
 */
export class NoLinkAdaptationPolicy implements LogicalPolicy {
  readonly id = BASELINE_NO_LINKS_ID;
  readonly #inner = new NeutralPolicy();

  decide(observation: Observation, agent: LabAgentState, rng: NeutralPolicyRandomSource): WorldAction[] {
    return this.#inner
      .decide(observation, agent, rng)
      .filter((action) => action.type !== "connect" && action.type !== "disconnect" && action.type !== "send");
  }
}

/* ------------------------------------------------------------------ */
/* Shared deterministic machinery                                      */
/* ------------------------------------------------------------------ */

/** Work an already-claimed task exactly the way the neutral policy does. */
function continueClaimedWork(observation: Observation, agent: LabAgentState): WorldAction | undefined {
  const claimed = observation.tasks
    .filter((task) => task.deadlineTick >= observation.tick)
    .filter((task) => task.status === "claimed" && task.claimedBy === agent.id)
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  const task = claimed[0];
  if (task === undefined) return undefined;
  const resultKey = NeutralPolicy.resultMemoryKey(task.id);
  if (Object.hasOwn(agent.memory, resultKey)) {
    return { type: "submit", taskId: task.id, result: structuredClone(agent.memory[resultKey]!) };
  }
  return { type: "execute", taskId: task.id, result: solveTask(task) };
}

function availableTasks(observation: Observation): TaskObservation[] {
  return observation.tasks.filter(
    (task) => task.status === "available" && task.deadlineTick >= observation.tick,
  );
}

/**
 * Submissions exactly one tick old: visible AT MOST once through this filter,
 * so no verifier state is needed and no duplicate verification is possible.
 * The guarantee is bounded by the observation physics — the public window
 * shows the last PUBLIC_SUBMISSION_WINDOW submissions, so any tick producing
 * more than that evicts the overflow before its only verifiable tick. At the
 * lab's population scales one submission per agent per tick stays far below
 * the window; the bound is recorded in the comparison artifact's caveats.
 */
function lastTickSubmissions(observation: Observation): SubmissionObservation[] {
  return observation.submissions.filter((submission) => submission.submittedTick === observation.tick - 1);
}

function sortedRoster(observation: Observation): string[] {
  const roster = new Set(observation.visibleAgents);
  roster.add(observation.agentId);
  return [...roster].sort(compareCodeUnits);
}

function isVerifierIndex(index: number): boolean {
  return index % 4 === 3;
}

/**
 * Fixed routing: a stable hash of the work item over a roster. Arbitrary by
 * construction and deliberately so — a dispatcher's table does not have to be
 * clever, it has to be unambiguous.
 */
function dispatchIndex(id: string, rosterSize: number): number {
  if (rosterSize < 1) throw new Error("Dispatch requires a non-empty roster");
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) % 2_147_483_647;
  }
  return hash % rosterSize;
}
