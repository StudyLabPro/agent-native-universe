/**
 * The live epoch rules, as pure functions.
 *
 * Genesis-Live is the fourth identity of this engine, not a second runtime:
 * the world (`world.ts`) and the protocol verifier (`protocol-verifier.ts`)
 * must reach the same conclusions from the same inputs, so every rule that
 * differs between a bounded logical run and a live epoch lives here once and
 * is called from both. A rule duplicated in two places is exactly the drift
 * the design refuses.
 *
 * This module deliberately sits in `src/lab/` and not in `src/lab/live/`: the
 * verifier is reachable from `genesis.ts`, and the science guard forbids the
 * scientific instruments from reaching anything under `src/lab/live/`.
 */
import { compareCodeUnits, hashValue } from "./canonical.js";
import { PUBLIC_INBOX_WINDOW, PUBLIC_SUBMISSION_WINDOW } from "./environment.js";
import {
  ResourcePhysics,
  fixedMultiplyCeil,
  multiplyDivideFloor,
} from "./resource-physics.js";
import {
  PPM,
  type GenesisConfig,
  type LabTaskState,
  type LiveArchiveConfig,
  type LiveCompaction,
  type LiveExhaustionCheckpoint,
  type LiveGenesisFrom,
  type LiveInheritedGenesis,
  type LiveTaskFamily,
  type LiveThinkTier,
  type TaskFamily,
  type PhysicsState,
  type ResourceKind,
  type ResourceVector,
  type RunManifest,
  type WorldState,
} from "./types.js";

/** True for a manifest whose evidence is a Genesis-Live epoch. */
export function isLiveMode(manifest: Pick<RunManifest, "mode">): boolean {
  return manifest.mode === "live";
}

/** The parent epoch this one continues, or `undefined` for epoch 0. */
export function liveGenesisFrom(
  manifest: Pick<RunManifest, "mode">,
  config: GenesisConfig,
): LiveGenesisFrom | undefined {
  return isLiveMode(manifest) ? config.live?.genesisFrom : undefined;
}

/**
 * Absolute tick of a run's genesis: `0` for every bounded run and for live
 * epoch 0, the parent's final tick for an inherited epoch. Ticks never restart
 * across a live chain, so deadlines, latencies and the reducer's monotonic
 * time rule keep working across the boundary.
 */
export function genesisTickOf(manifest: Pick<RunManifest, "mode">, config: GenesisConfig): number {
  return liveGenesisFrom(manifest, config)?.tick ?? 0;
}

/** The `inherited` block of an inherited epoch's `run.started`. */
export function inheritedGenesisOf(genesisFrom: LiveGenesisFrom): LiveInheritedGenesis {
  return {
    parentRunId: genesisFrom.runId,
    parentEventHash: genesisFrom.eventHash,
    parentStateHash: genesisFrom.stateHash,
    genesisStateHash: genesisFrom.genesisStateHash,
    startTick: genesisFrom.tick,
  };
}

/**
 * How many calibration tasks a tick may generate.
 *
 * A calibration task carries a hidden oracle that exists only in the running
 * evaluator's memory, so it must never be open when the epoch ends. Generation
 * therefore stops `deadlineTicks + 1` ticks before the final tick: the last
 * task generated still expires by deadline *inside* the epoch. The final
 * upkeep sweeps whatever is somehow still open
 * (`task.expired{reason:"epoch_boundary"}`).
 *
 * Outside live mode this is the identity function, so the scientific track
 * generates exactly what it always did.
 */
export function calibrationTaskCount(
  manifest: Pick<RunManifest, "mode">,
  config: GenesisConfig,
  tick: number,
  count: number,
): number {
  if (!isLiveMode(manifest)) return count;
  return tick > lastCalibrationTick(config) ? 0 : count;
}

/** The last tick of a live epoch on which a calibration task may be created. */
export function lastCalibrationTick(config: GenesisConfig): number {
  return config.ticks - config.taskStream.deadlineTicks - 1;
}

/**
 * Ids of the tasks the final upkeep of a live epoch expires, in id order.
 * External tasks (phase L3b) have no oracle and are left to cross the
 * boundary; everything else that is still available or claimed is closed.
 */
export function epochBoundaryExpiries(
  manifest: Pick<RunManifest, "mode">,
  config: GenesisConfig,
  tick: number,
  state: WorldState,
): string[] {
  if (!isLiveMode(manifest) || tick !== config.ticks) return [];
  return Object.values(state.tasks)
    .filter((task) => (
      (task.status === "available" || task.status === "claimed")
      && (task.family as LiveTaskFamily) !== "external"
    ))
    .map((task) => task.id)
    .sort(compareCodeUnits);
}

/* ------------------------------------------------------------------------ */
/* Phase L3c: the bounded world                                              */
/*                                                                           */
/* A universe that runs indefinitely must not grow indefinitely. Settled      */
/* records — tasks nobody can still act on, submissions nobody can still      */
/* verify, mail nobody can still read — leave the live state once they are    */
/* older than the configured window. They do not leave the evidence: every    */
/* one of them is still in the append-only event log of the epoch that        */
/* created it, and a replay of the chain from epoch 0 reconstructs the whole  */
/* history. The live state is a working set, the chain is the record.        */
/* ------------------------------------------------------------------------ */

/** The ids one upkeep archives, each list in id order. */
export interface LiveArchivePlan {
  submissions: string[];
  tasks: string[];
  messages: string[];
}

export function emptyLiveArchivePlan(): LiveArchivePlan {
  return { submissions: [], tasks: [], messages: [] };
}

export function isEmptyLiveArchivePlan(plan: LiveArchivePlan): boolean {
  return plan.submissions.length === 0 && plan.tasks.length === 0 && plan.messages.length === 0;
}

/**
 * The tick a task settled on.
 *
 * A completed task carries its own `completedTick`. An expired one carries
 * nothing, because expiry is regenerated rather than asserted — but a task
 * expires exactly when its deadline has passed, so the deadline IS the settle
 * tick. A task swept at an epoch boundary keeps a deadline in the future and
 * therefore waits out its own deadline before the window starts, which is
 * bounded and needs no special case.
 */
export function liveTaskSettledTick(task: LabTaskState): number {
  return task.completedTick ?? task.deadlineTick;
}

/**
 * What an upkeep at `tick` archives out of `state`, given the windows.
 *
 * Pure, and a fixpoint: applying the plan and recomputing yields an empty
 * plan, which is what lets the protocol verifier demand that a tick's archival
 * is complete by regenerating the plan from the state the archived events
 * left behind.
 *
 * Three ordering rules make the result safe to apply:
 *
 *  - the newest `PUBLIC_SUBMISSION_WINDOW` submissions and the newest
 *    `PUBLIC_INBOX_WINDOW` messages of each inbox are what an observation is
 *    built from, so they are never archived while they are still observable;
 *  - a submission is archived only once its task has settled;
 *  - a task is archived only once every submission naming it is archived in
 *    the same plan, so the observation frame can never reach a task that is
 *    no longer there.
 */
export function archivableRecords(
  windows: LiveArchiveConfig,
  tick: number,
  state: WorldState,
): LiveArchivePlan {
  const observableSubmissions = new Set(state.submissionOrder.slice(-PUBLIC_SUBMISSION_WINDOW));
  const archivedSubmissions = new Set<string>();
  const submissions: string[] = [];
  for (const id of Object.keys(state.submissions).sort(compareCodeUnits)) {
    if (observableSubmissions.has(id)) continue;
    const submission = state.submissions[id]!;
    if (submission.submittedTick > tick - windows.submissionTicks) continue;
    const task = state.tasks[submission.taskId];
    if (task !== undefined && task.status !== "completed" && task.status !== "expired") continue;
    submissions.push(id);
    archivedSubmissions.add(id);
  }

  const referenced = new Set<string>();
  for (const submission of Object.values(state.submissions)) {
    if (!archivedSubmissions.has(submission.id)) referenced.add(submission.taskId);
  }
  const tasks = Object.values(state.tasks)
    .filter((task) => (
      (task.status === "completed" || task.status === "expired")
      && liveTaskSettledTick(task) <= tick - windows.taskTicks
      && !referenced.has(task.id)
    ))
    .map((task) => task.id)
    .sort(compareCodeUnits);

  const observableMessages = new Set<string>();
  for (const agent of Object.values(state.agents)) {
    for (const id of agent.inbox.slice(-PUBLIC_INBOX_WINDOW)) observableMessages.add(id);
  }
  const messages = Object.values(state.messages)
    .filter((message) => (
      message.deliveredTick !== undefined
      && message.deliveredTick <= tick - windows.messageTicks
      && !observableMessages.has(message.id)
    ))
    .map((message) => message.id)
    .sort(compareCodeUnits);

  return { submissions, tasks, messages };
}

/** The archive windows of a live epoch; `undefined` outside live mode. */
export function liveArchiveWindows(
  manifest: Pick<RunManifest, "mode">,
  config: GenesisConfig,
): LiveArchiveConfig | undefined {
  if (!isLiveMode(manifest)) return undefined;
  const archive = config.live?.archive;
  if (archive === undefined) throw new Error("A live epoch requires live.archive windows");
  return archive;
}

/** What the upkeep of `tick` archives — the rule the world applies and the verifier regenerates. */
export function planLiveArchive(
  manifest: Pick<RunManifest, "mode">,
  config: GenesisConfig,
  tick: number,
  state: WorldState,
): LiveArchivePlan {
  const windows = liveArchiveWindows(manifest, config);
  if (windows === undefined) return emptyLiveArchivePlan();
  return archivableRecords(windows, tick, state);
}

/* The three removals, written once. The reducer applies them event by event
 * and `compactWorldState` applies them in bulk at a boundary; a second
 * implementation of "what archiving a record means" is exactly the drift the
 * single-embodiment invariant forbids. */

export function removeArchivedTask(state: WorldState, taskId: string): void {
  delete state.tasks[taskId];
}

export function removeArchivedSubmission(state: WorldState, submissionId: string): void {
  delete state.submissions[submissionId];
  state.submissionOrder = state.submissionOrder.filter((id) => id !== submissionId);
  // A verification is a statement about one submission; without the submission
  // it cannot be read, so it leaves with it.
  for (const [id, verification] of Object.entries(state.verifications)) {
    if (verification.submissionId === submissionId) delete state.verifications[id];
  }
}

export function removeArchivedMessage(state: WorldState, messageId: string): void {
  const message = state.messages[messageId];
  delete state.messages[messageId];
  if (message === undefined) return;
  const recipient = state.agents[message.recipientId];
  if (recipient !== undefined && recipient.inbox.includes(messageId)) {
    recipient.inbox = recipient.inbox.filter((id) => id !== messageId);
  }
}

/**
 * Derive the genesis state of epoch `k+1` from the final state of epoch `k`.
 *
 * The rule is part of `config.live.genesisFrom.compaction`, so it is inside
 * `configHash` and therefore inside the child's `runId`: a child can never
 * inherit a differently-derived world than its identity claims.
 *
 * `none` is the identity rule. `windows` is the bounded-world rule: the same
 * archive windows the epoch's own upkeep applies, applied once more at the
 * parent's final tick. In a universe whose epochs archived as they ran it is a
 * fixpoint — that is the point, the child's genesis is provably bounded either
 * way — and it is the rule that bounds a genesis inherited from an epoch that
 * did not archive. The windows travel inside the rule rather than being read
 * back out of the parent's config, so `verifyLiveChain` re-derives the genesis
 * from the link alone.
 */
export function compactWorldState(state: WorldState, rule: LiveCompaction): WorldState {
  const compacted = structuredClone(state);
  if (rule.kind === "none") return compacted;
  if (rule.kind !== "windows") {
    throw new Error(`Unsupported live compaction rule ${String((rule as { kind: string }).kind)}`);
  }
  const plan = archivableRecords(rule.archive, compacted.tick, compacted);
  for (const id of plan.submissions) removeArchivedSubmission(compacted, id);
  for (const id of plan.tasks) removeArchivedTask(compacted, id);
  for (const id of plan.messages) removeArchivedMessage(compacted, id);
  return compacted;
}

/* ------------------------------------------------------------------------ */
/* Phase L3b: recorded inputs, the economy of thinking, and exhaustion       */
/*                                                                           */
/* Everything below is a pure rule the world (`world.ts`) applies and the    */
/* protocol verifier (`protocol-verifier.ts`) regenerates. Neither owns it.  */
/* ------------------------------------------------------------------------ */

/** The live-only task family of work that entered the world as a recorded input. */
export const LIVE_EXTERNAL_FAMILY = "external" as const;
/** `input.kind` of an external task — the discriminator inside the task payload. */
export const LIVE_EXTERNAL_INPUT_KIND = "external" as const;
/** Bound on every recorded external string, so one inbox line cannot unbound the world. */
export const LIVE_EXTERNAL_FIELD_MAX_BYTES = 8_192;

/** The body of an external task: a slug, a prompt and the rubric it is graded by. */
export interface LiveExternalTaskInput {
  kind: typeof LIVE_EXTERNAL_INPUT_KIND;
  slug: string;
  prompt: string;
  rubric: string;
}

export function isExternalTask(task: Pick<LabTaskState, "family">): boolean {
  return (task.family as LiveTaskFamily) === LIVE_EXTERNAL_FAMILY;
}

/**
 * The learning key of a family, or `undefined` for external work.
 *
 * `AgentLearningState` and `taskCounts` are keyed by the frozen eight families
 * and specialization is measured over exactly those, so external work is
 * counted in `WorldState.counters` and nowhere else. This function is the one
 * place that decision.
 */
export function learningFamilyOf(family: LiveTaskFamily): TaskFamily | undefined {
  return family === LIVE_EXTERNAL_FAMILY ? undefined : family;
}

/**
 * The id of an external task is a commitment to its own content.
 *
 * That is what makes a recorded task verifiable at replay without the inbox
 * file: the verifier recomputes the id from the payload the event carries, so
 * an event cannot claim a task body other than the one its id names, and two
 * identical records cannot be admitted twice (the reducer refuses a duplicate
 * task id).
 */
export function externalTaskId(
  createdTick: number,
  deadlineTick: number,
  input: LiveExternalTaskInput,
): string {
  return `task:ext:${hashValue({
    domain: "agent-native-universe/lab/live/external-task/v1",
    createdTick,
    deadlineTick,
    input,
  })}`;
}

/**
 * Validate an external task exactly as both the world and the verifier must.
 * Throws with a caller-supplied message prefix; returns the canonical task.
 */
export function assertExternalTask(task: LabTaskState, tick: number): void {
  if (!isExternalTask(task)) throw new Error("An external task must carry family external");
  const input = task.input as Partial<LiveExternalTaskInput> | null;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("External task input must be an object");
  }
  if (input.kind !== LIVE_EXTERNAL_INPUT_KIND) {
    throw new Error(`External task input.kind must be ${LIVE_EXTERNAL_INPUT_KIND}`);
  }
  for (const field of ["slug", "prompt", "rubric"] as const) {
    const value = input[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`External task input.${field} must be a non-empty string`);
    }
    if (Buffer.byteLength(value, "utf8") > LIVE_EXTERNAL_FIELD_MAX_BYTES) {
      throw new Error(`External task input.${field} exceeds ${LIVE_EXTERNAL_FIELD_MAX_BYTES} bytes`);
    }
  }
  for (const key of Object.keys(input)) {
    if (!["kind", "slug", "prompt", "rubric"].includes(key)) {
      throw new Error(`External task input contains unknown field ${key}`);
    }
  }
  if (task.status !== "available") throw new Error("A recorded external task must start available");
  if (task.createdTick !== tick) throw new Error("External task createdTick must equal the tick it enters on");
  // Deadline >= tick is the recorded-input rule; the reducer's own
  // `deadlineTick > createdTick` still applies on top of it.
  if (!Number.isSafeInteger(task.deadlineTick) || task.deadlineTick < tick) {
    throw new Error("External task deadlineTick must be a safe integer at or after its tick");
  }
  if (
    task.claimedBy !== undefined
    || task.submittedBy !== undefined
    || task.completedTick !== undefined
    || task.evaluationEventId !== undefined
  ) {
    throw new Error("A recorded external task cannot carry lifecycle fields");
  }
  const expectedId = externalTaskId(task.createdTick, task.deadlineTick, input as LiveExternalTaskInput);
  if (task.id !== expectedId) throw new Error("External task id is not the commitment to its own content");
}

/** Open (still occupying backlog) tasks — the capacity both sides count. */
export function openTaskBacklog(state: WorldState): number {
  return Object.values(state.tasks)
    .filter((task) => task.status !== "completed" && task.status !== "expired").length;
}

/**
 * The `llmTokens` an agent owes for one recorded consultation.
 *
 * The world charges it immediately after the `cognition.recorded` event; the
 * verifier recomputes it from the same recorded usage, the same tier price and
 * the same physics. `costs.reason` supplies the other four resources: thinking
 * is an action of the world like any other, priced by the control plane.
 */
export function liveThinkingCost(
  config: GenesisConfig,
  physics: PhysicsState,
  tier: LiveThinkTier,
  totalTokens: number,
): ResourceVector {
  const tierPhysics = config.live?.tiers[tier];
  if (tierPhysics === undefined) throw new Error(`Live physics has no thinking tier ${tier}`);
  if (!Number.isSafeInteger(totalTokens) || totalTokens < 0) {
    throw new Error("Recorded token usage must be a non-negative safe integer");
  }
  const base: ResourceVector = {
    ...config.costs.reason,
    llmTokens: fixedMultiplyCeil(totalTokens, tierPhysics.pricePpm) + config.costs.reason.llmTokens,
  };
  return new ResourcePhysics().scaledCost(base, physics);
}

/**
 * What the world actually debits, given the balance the agent holds.
 *
 * A balance that cannot cover the price is not a refusal to charge: the
 * consultation already happened and the tokens were already burned outside the
 * world. The agent is charged down to zero and the shortfall is recorded as a
 * violation, so the evidence says the world overdrew rather than silently
 * forgiving the debt.
 */
export interface LiveThinkingDebit {
  cost: ResourceVector;
  overdraft: boolean;
}

export function liveThinkingDebit(
  config: GenesisConfig,
  physics: PhysicsState,
  tier: LiveThinkTier,
  totalTokens: number,
  balance: ResourceVector,
): LiveThinkingDebit {
  const full = liveThinkingCost(config, physics, tier, totalTokens);
  const cost = { ...full };
  let overdraft = false;
  for (const resource of LIVE_RESOURCE_KINDS) {
    if (cost[resource] > balance[resource]) {
      cost[resource] = balance[resource];
      overdraft = true;
    }
  }
  return { cost, overdraft };
}

/** The reason string of the violation an overdrawn consultation records. */
export const LIVE_COGNITION_OVERDRAFT_REASON = "cognition overdraft";

const LIVE_RESOURCE_KINDS: readonly ResourceKind[] = Object.freeze([
  "credits", "llmTokens", "computeMs", "storageBytes", "bandwidthBytes",
]);

/**
 * A recorded verdict grades external work on a continuum, so the reward is a
 * fraction of the configured one rather than all-or-nothing. `floor` keeps it
 * integral and never pays more than an oracle-accepted task would.
 */
export function proportionalReward(reward: ResourceVector, qualityPpm: number): ResourceVector {
  if (!Number.isSafeInteger(qualityPpm) || qualityPpm < 0 || qualityPpm > PPM) {
    throw new Error("qualityPpm must be an integer in [0, 1000000]");
  }
  const scaled = { ...reward };
  for (const resource of LIVE_RESOURCE_KINDS) {
    scaled[resource] = multiplyDivideFloor(reward[resource], qualityPpm, PPM);
  }
  return scaled;
}

/**
 * Whether a recorded verdict accepts the work at all. A verdict of zero
 * quality pays nothing and is not an acceptance; any positive quality is a
 * partial acceptance paid in proportion.
 */
export function acceptedByVerdict(qualityPpm: number): boolean {
  return qualityPpm > 0;
}

/**
 * Consecutive ticks each agent has been unable to think.
 *
 * The rule: at the upkeep of every live tick an active agent is *starving*
 * when it holds fewer than `live.exhaustion.minThinkTokens` and is not
 * currently working on a claimed task. `graceTicks` consecutive starving ticks
 * retire it as `exhausted` — a physical boundary, not a punishment: an agent
 * that can no longer be consulted and holds no work can no longer participate.
 *
 * The counter is runtime state, not world state: it is bookkeeping both the
 * world and the verifier rebuild from the same rule over the same states,
 * exactly like the task stream's cursor, and it travels across an epoch
 * boundary inside `genesisFrom.runtime` so the grace period is continuous over
 * the life of the universe.
 */
export class LiveExhaustionTracker {
  readonly #starving = new Map<string, number>();

  /**
   * Advance one tick and return the ids of the agents this upkeep retires, in
   * id order. Call exactly once per tick, with the state as the upkeep phase
   * begins.
   */
  review(manifest: Pick<RunManifest, "mode">, config: GenesisConfig, state: WorldState): string[] {
    if (!isLiveMode(manifest)) return [];
    const exhaustion = config.live?.exhaustion;
    if (exhaustion === undefined) throw new Error("A live epoch requires live.exhaustion physics");
    const claimed = new Set<string>();
    for (const task of Object.values(state.tasks)) {
      if (task.status === "claimed" && task.claimedBy !== undefined) claimed.add(task.claimedBy);
    }
    const retired: string[] = [];
    for (const agentId of Object.keys(state.agents).sort(compareCodeUnits)) {
      const agent = state.agents[agentId]!;
      if (!agent.active) {
        this.#starving.delete(agentId);
        continue;
      }
      const starving = agent.resources.llmTokens < exhaustion.minThinkTokens && !claimed.has(agentId);
      if (!starving) {
        this.#starving.delete(agentId);
        continue;
      }
      const ticks = (this.#starving.get(agentId) ?? 0) + 1;
      if (ticks >= exhaustion.graceTicks) {
        this.#starving.delete(agentId);
        retired.push(agentId);
        continue;
      }
      this.#starving.set(agentId, ticks);
    }
    return retired;
  }

  checkpoint(): LiveExhaustionCheckpoint {
    return {
      starving: [...this.#starving.entries()]
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([agentId, ticks]) => ({ agentId, ticks })),
    };
  }

  restore(checkpoint: LiveExhaustionCheckpoint | undefined): void {
    this.#starving.clear();
    for (const entry of checkpoint?.starving ?? []) {
      if (typeof entry.agentId !== "string" || !Number.isSafeInteger(entry.ticks) || entry.ticks < 0) {
        throw new Error("Live exhaustion checkpoint entries must be {agentId, ticks}");
      }
      this.#starving.set(entry.agentId, entry.ticks);
    }
  }
}
