/**
 * Live cognition port (design §4.D; phase L1b).
 *
 * `LiveCognition` is cohort `C`'s live counterpart of `LlmCognition`
 * (`../cognition.ts`), with three differences the design requires:
 *
 *  - every active agent is consulted, every tick, concurrently — not a fixed
 *    `agentsPerTick` slice;
 *  - consultations are split across three thinking tiers (`fast`, `standard`,
 *    `deliberate`), each its own model, budget and concurrency limit, and the
 *    tier for an agent's NEXT consultation is a pure function
 *    ({@link expectedTier}) of what it asked for last time and what it can
 *    now afford — a starved agent (unaffordable even at the cheapest tier)
 *    gets no consultation that tick, not a failed one;
 *  - the prompt asks for `nextTier` in the answer and the observation handed
 *    to the model is bounded ({@link LIVE_OBSERVATION_BUDGET}) regardless of
 *    population size, so one consultation's cost cannot grow with the world.
 *
 * Like `LlmCognition`, this port never throws: every consultation attempt —
 * whether it starts at all, times out, or the provider errors — resolves to
 * exactly one `CognitionRecord` (an `unavailable` one on failure) or, for a
 * starved agent, to no record at all. `propose()` itself only ever resolves.
 *
 * Import discipline (enforced by `.github/scripts/check-live-isolation.mjs`):
 * nothing under `src/lab/live/` may import `src/core/*` runtime code,
 * `src/runtime/*` or `src/v2/*`. `src/v1/*` is not restricted — the same
 * place `runner.ts` already imports `OpenAICompatibleProvider`/`LlmRouter`
 * from for cohort B/C.
 */
import { assertRequestOverrides } from "../../v1/economy-llm.js";
import type { JsonObject, JsonValue } from "../../core/types.js";
import { canonicalJson, sha256Hex } from "../canonical.js";
import {
  DEFAULT_COGNITION_CONTENT_BYTE_BUDGET,
  MAX_COGNITION_CONTENT_BYTE_BUDGET,
  boundUtf8,
  parseCognitiveActions,
  type CognitionPort,
  type CognitionRecord,
  type CognitionRequest,
  type CohortId,
  type CompletionLike,
} from "../cognition.js";
import {
  LIVE_THINK_TIERS,
  PPM,
  type LiveThinkTier,
  type TaskObservation,
  type WorldAction,
} from "../types.js";

/* ------------------------------------------------------------------ */
/* Tier configuration                                                  */
/* ------------------------------------------------------------------ */

/**
 * One tier's technical treatment: which model answers, how much it may say,
 * how long it gets and how many of its consultations run at once. `pricePpm`
 * is the control plane's price for this tier (design invariant 4: the agent
 * picks the tier, control plane only sets prices) — the SAME rate the live
 * engine's reducer charges `llmTokens` for (design §4.E); it is carried here
 * too because this port has to predict affordability itself
 * ({@link expectedTier}) before a consultation is even attempted, from
 * nothing but the agent's balance in its own request.
 */
export interface LiveTierConfig {
  model: string;
  maxTokens: number;
  timeoutMs: number;
  concurrency: number;
  pricePpm: number;
  /** e.g. `{"reasoning_effort":"low"}` — the L1a mechanism, reused verbatim. */
  requestOverrides?: JsonObject;
}

export type LiveTiersSpec = Record<LiveThinkTier, LiveTierConfig>;

const TIER_CONFIG_FIELDS = ["model", "maxTokens", "timeoutMs", "concurrency", "pricePpm", "requestOverrides"];

/**
 * Validates and normalizes a tiers spec (used both by the constructor and by
 * `runner.ts`'s `ANU_LIVE_TIERS` parser, so the two can never disagree about
 * what is acceptable).
 */
export function assertLiveTiersSpec(value: unknown): LiveTiersSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Live cognition tiers must be a JSON object keyed by fast, standard and deliberate");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(LIVE_THINK_TIERS as readonly string[]).includes(key)) {
      throw new Error(`Live cognition tiers contains unknown tier ${key}`);
    }
  }
  const result = {} as Record<LiveThinkTier, LiveTierConfig>;
  for (const tier of LIVE_THINK_TIERS) {
    const raw = record[tier];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`Live cognition tiers is missing tier ${tier}`);
    }
    const config = raw as Record<string, unknown>;
    for (const field of Object.keys(config)) {
      if (!TIER_CONFIG_FIELDS.includes(field)) {
        throw new Error(`Live cognition tier ${tier} contains unknown field ${field}`);
      }
    }
    const model = config.model;
    if (typeof model !== "string" || model.length === 0 || /\s/.test(model)) {
      throw new Error(`Live cognition tier ${tier}.model must be a non-empty whitespace-free string`);
    }
    result[tier] = {
      model,
      maxTokens: positiveInteger(config.maxTokens, `${tier}.maxTokens`),
      timeoutMs: positiveInteger(config.timeoutMs, `${tier}.timeoutMs`),
      concurrency: positiveInteger(config.concurrency, `${tier}.concurrency`),
      pricePpm: positiveInteger(config.pricePpm, `${tier}.pricePpm`),
      ...(config.requestOverrides === undefined
        ? {}
        : { requestOverrides: assertRequestOverrides(config.requestOverrides) }),
    };
  }
  return result;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Live cognition ${name} must be a positive safe integer`);
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* expectedTier — pure, independently verifiable                       */
/* ------------------------------------------------------------------ */

const LIVE_TIER_RANK: Readonly<Record<LiveThinkTier, number>> = Object.freeze({
  fast: 0,
  standard: 1,
  deliberate: 2,
});
const LIVE_TIERS_BY_RANK: readonly LiveThinkTier[] = Object.freeze(["fast", "standard", "deliberate"]);

/**
 * The tier an agent is actually consulted at this tick, given what it asked
 * for last time and what it can now afford.
 *
 * Pure and side-effect-free by design: a verifier must be able to call this
 * with nothing but the recorded `nextTier` of an agent's previous
 * `cognition.recorded` event, its current `llmTokens` balance and the tier
 * price table, and reproduce exactly which tier (if any) the live engine
 * consulted it at — without running a model or reading the rest of the world.
 *
 * `prices` is keyed by tier and gives the `llmTokens` an agent must hold to
 * afford ONE consultation at that tier — `LiveCognition` computes this as
 * `ceil(tier.maxTokens * tier.pricePpm / PPM)`, the worst-case cost the live
 * economy could charge for it (design §4.E: `resource.spent` uses the same
 * `pricePpm` against the tokens a consultation actually used).
 *
 * Downgrades toward the cheapest affordable tier at or below what was asked
 * for; never upgrades. `"starved"` means even `fast` is unaffordable: the
 * agent gets no consultation this tick, not a failed one.
 */
export function expectedTier(
  nextTier: LiveThinkTier,
  balance: number,
  prices: Readonly<Record<LiveThinkTier, number>>,
): LiveThinkTier | "starved" {
  const startRank = LIVE_TIER_RANK[nextTier];
  for (let rank = startRank; rank >= 0; rank -= 1) {
    const tier = LIVE_TIERS_BY_RANK[rank]!;
    if (balance >= prices[tier]) return tier;
  }
  return "starved";
}

/* ------------------------------------------------------------------ */
/* Prompt v2 and observation budget                                    */
/* ------------------------------------------------------------------ */

/**
 * Hard per-consultation caps on how much of an agent's observation reaches
 * the model, independent of population size (design §4.D, critic #6). Every
 * count here is a slice of what `Observation` (`../environment.ts`) already
 * handed the agent — this module only ever narrows it further, never widens
 * it, so the honesty and no-oracle-leak guarantees `environment.ts` already
 * provides carry over unchanged.
 *
 * `maxNeighbors` is not in the design's enumerated budget (design text: "the
 * neighbors" — no cap, since link formation already costs resources and a
 * live agent's neighbor count stays small in practice). It is included here
 * anyway, as a defensive bound: without SOME cap, the 24 KiB prompt-size
 * guarantee this budget exists to provide would depend on that economic
 * argument holding forever rather than being true by construction.
 */
export const LIVE_OBSERVATION_BUDGET = Object.freeze({
  maxTasks: 16,
  maxSubmissions: 8,
  maxInbox: 8,
  maxVisibleAgentsSample: 16,
  maxNeighbors: 64,
  maxCapabilities: 8,
  maxMemoryKeys: 8,
});
export type LiveObservationBudget = typeof LIVE_OBSERVATION_BUDGET;

const LIVE_PROMPT_VERSION = "v2";

/**
 * Hashes a prompt and an observation budget into a short, stable id. Exported
 * so a verifier — or this module's own tests — can prove that changing
 * either one changes the id, without having to actually edit the constants
 * below to demonstrate it.
 */
export function computePromptId(prompt: string, budget: unknown): string {
  return `${LIVE_PROMPT_VERSION}-${sha256Hex(canonicalJson({ prompt, budget })).slice(0, 16)}`;
}

/**
 * Deliberately role-neutral, like `COGNITION_SYSTEM_PROMPT` in
 * `../cognition.ts` — but not that string: this prompt additionally asks for
 * `nextTier`, states the observation budget, and describes a world that
 * keeps running in epochs rather than ending after one measured run. The
 * action grammar below is reproduced verbatim from `COGNITION_SYSTEM_PROMPT`
 * on purpose: `parseCognitiveActions`/`validateAction` (`../cognition.ts`)
 * accept exactly this vocabulary and have not changed, so describing a
 * different one here would just make the model's answers less usable.
 */
export const LIVE_COGNITION_SYSTEM_PROMPT = [
  "You are the decision process of one bounded agent in a resource-limited world that keeps running indefinitely, in epochs, rather than ending after this one.",
  "Your observation this turn is bounded, however large the population is: at most 16 tasks (including any you already claimed), at most 8 recent submissions, at most 8 inbox messages, your neighbors, a sample of the other agents you can see, and at most 8 capabilities. Other agents are pursuing the same objective with the same primitives.",
  "Return one valid JSON object only, of the form {\"actions\":[...],\"nextTier\":\"fast\"|\"standard\"|\"deliberate\"} with at most 4 actions.",
  "Every action must be one of these exact shapes:",
  '{"type":"observe"}',
  '{"type":"reason","subject":string}',
  '{"type":"claimTask","taskId":string}',
  '{"type":"execute","taskId":string,"result":any}',
  '{"type":"submit","taskId":string,"result":any}',
  '{"type":"verify","submissionId":string,"computedResult":any,"verdict":boolean}',
  '{"type":"send","targetId":string,"payload":object}',
  '{"type":"connect","targetId":string}',
  '{"type":"disconnect","targetId":string}',
  '{"type":"store","key":string,"value":any}',
  '{"type":"retrieve","key":string}',
  '{"type":"useCapability","capabilityId":string,"input":any}',
  '{"type":"transfer","targetId":string,"resource":string,"amount":integer}',
  '{"type":"reserve","resource":string,"amount":integer}',
  '{"type":"trade","resource":string,"amount":integer,"credits":integer}',
  'Resources are named exactly: credits, llmTokens, computeMs, storageBytes, bandwidthBytes.',
  'A task must be claimed with claimTask before it can be executed or submitted.',
  "nextTier is your request for how much you want to think on your NEXT consultation, not this one: \"fast\", \"standard\" or \"deliberate\", cheapest to most expensive. The world charges your llmTokens balance for what THIS consultation actually used; a next tier you cannot afford is silently downgraded, and if even the cheapest tier is unaffordable you are not consulted that turn at all.",
  "A contested task claim is resolved in a shuffled order each turn; losing one costs nothing beyond the attempt, but acting on a task you do not hold does.",
  "Every action costs resources. Acting without means ends you.",
  "Do not invent action types. Do not claim a task was solved correctly; only an external evaluator decides that.",
].join("\n");

const LIVE_PROMPT_ID = computePromptId(LIVE_COGNITION_SYSTEM_PROMPT, LIVE_OBSERVATION_BUDGET);

/* ------------------------------------------------------------------ */
/* Port identity                                                       */
/* ------------------------------------------------------------------ */

export interface LiveCognitionIdInput {
  tiers: LiveTiersSpec;
  promptId: string;
  /**
   * The gateway/deployment this port intends to consult, the same way
   * `LlmCognition.model` binds a treatment identity into the id — e.g. the
   * gateway's `@gateway-v1-<sha>` from `/identity` (`runner.ts`,
   * `resolveCognitionTreatmentIdentity`, L1a). Never a secret.
   */
  gatewayIdentity: string;
  contentByteBudget: number;
}

/**
 * Everything that changes what the three tiers actually contribute — their
 * models, token budgets, prices and request overrides, the exact prompt and
 * observation-budget version, and the gateway identity — is hashed into the
 * id, exactly the way `LlmCognition.id` binds model/budget/overrides
 * (`../cognition.ts`). Operational knobs (`timeoutMs`, `concurrency`) stay
 * out, for the same reason they stay out there: they change pacing, not
 * treatment.
 */
export function computeLiveCognitionId(input: LiveCognitionIdInput): string {
  const tiersForHash: Record<string, unknown> = {};
  for (const tier of LIVE_THINK_TIERS) {
    const config = input.tiers[tier];
    tiersForHash[tier] = {
      model: config.model,
      maxTokens: config.maxTokens,
      pricePpm: config.pricePpm,
      requestOverrides: config.requestOverrides ?? null,
    };
  }
  const digest = sha256Hex(canonicalJson({
    tiers: tiersForHash,
    promptId: input.promptId,
    gatewayIdentity: input.gatewayIdentity,
  })).slice(0, 24);
  const id = `cognition-live-v1:${digest}:cb${input.contentByteBudget}`;
  if (id.length > 128) throw new Error("Live cognition id exceeds 128 characters");
  return id;
}

/* ------------------------------------------------------------------ */
/* The port                                                            */
/* ------------------------------------------------------------------ */

export interface LiveCognitionOptions {
  /**
   * Single completion surface for all three tiers (mirrors
   * `LlmCognitionOptions.completion`). The recommended wiring
   * (`runner.ts#createLiveCognition`) registers one `OpenAICompatibleProvider`
   * per tier in one shared `LlmRouter`, each advertising a `tier:<name>`
   * capability tag so `require: ["chat","json","tier:<name>"]` routes a
   * consultation to exactly its own tier's model — never a different one,
   * even if that model's own circuit is open (the request then fails, which
   * is what should happen, rather than silently answering from the wrong
   * model). This port does not care how `completion` achieves that; a fake
   * with one `complete()` per test is all that is needed to exercise it.
   */
  completion: CompletionLike;
  tiers: LiveTiersSpec;
  gatewayIdentity: string;
  /** Same meaning and same default as `LlmCognitionOptions.contentByteBudget`. */
  contentByteBudget?: number;
  /** 429 `too_many_in_flight`/`rate_limited` retries before giving up on an agent this tick. */
  maxRetries?: number;
  /** Linear backoff between retries, in ms; not part of the id (pacing only). */
  retryBackoffMs?: number;
}

const RETRYABLE_GATEWAY_REASONS = ["too_many_in_flight", "rate_limited"];

function isRetryableGatewayError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (!/\bHTTP 429\b/.test(error.message)) return false;
  return RETRYABLE_GATEWAY_REASONS.some((reason) => error.message.includes(reason));
}

type CompletionResponse = Awaited<ReturnType<CompletionLike["complete"]>>;

/**
 * Cohort C's live port: every active agent, every tick, tiered and
 * concurrent. See the module doc for the full contract; the short version is
 * `propose()` never throws and never returns more than one record per agent
 * per tick.
 */
export class LiveCognition implements CognitionPort {
  readonly id: string;
  readonly cohort: CohortId = "C";
  readonly #completion: CompletionLike;
  readonly #tiers: LiveTiersSpec;
  readonly #tierCost: Readonly<Record<LiveThinkTier, number>>;
  readonly #contentByteBudget: number;
  readonly #maxRetries: number;
  readonly #retryBackoffMs: number;
  /**
   * The tier each agent asked for on its last successful consultation. Live,
   * in-memory only: a resumed process reconstructs it by replaying the last
   * `cognition.recorded.nextTier` per agent from the event stream (L3), the
   * same way every other piece of Genesis-Live runtime state is recovered
   * from disk rather than carried across a restart in memory.
   */
  readonly #lastNextTier = new Map<string, LiveThinkTier>();

  constructor(options: LiveCognitionOptions) {
    this.#completion = options.completion;
    this.#tiers = assertLiveTiersSpec(options.tiers);
    this.#contentByteBudget = requirePositive(
      options.contentByteBudget ?? DEFAULT_COGNITION_CONTENT_BYTE_BUDGET,
      "contentByteBudget",
    );
    if (this.#contentByteBudget > MAX_COGNITION_CONTENT_BYTE_BUDGET) {
      throw new Error(`contentByteBudget must not exceed ${MAX_COGNITION_CONTENT_BYTE_BUDGET} bytes`);
    }
    this.#maxRetries = requireNonNegative(options.maxRetries ?? 2, "maxRetries");
    this.#retryBackoffMs = requireNonNegative(options.retryBackoffMs ?? 250, "retryBackoffMs");
    const gatewayIdentity = typeof options.gatewayIdentity === "string" ? options.gatewayIdentity.trim() : "";
    if (gatewayIdentity.length === 0 || /\s/.test(gatewayIdentity)) {
      throw new Error("LiveCognition requires a non-empty whitespace-free gatewayIdentity");
    }
    const cost: Record<string, number> = {};
    for (const tier of LIVE_THINK_TIERS) {
      const config = this.#tiers[tier];
      // Worst case: the consultation uses the entire maxTokens budget. Using
      // anything smaller would let `expectedTier` admit an agent whose
      // consultation the live economy then cannot fully charge for.
      cost[tier] = Math.ceil((config.maxTokens * config.pricePpm) / PPM);
    }
    this.#tierCost = Object.freeze(cost) as Record<LiveThinkTier, number>;
    this.id = computeLiveCognitionId({
      tiers: this.#tiers,
      promptId: LIVE_PROMPT_ID,
      gatewayIdentity,
      contentByteBudget: this.#contentByteBudget,
    });
  }

  async propose(requests: readonly CognitionRequest[], signal?: AbortSignal): Promise<CognitionRecord[]> {
    const groups: Record<LiveThinkTier, CognitionRequest[]> = { fast: [], standard: [], deliberate: [] };
    for (const request of [...requests].sort((left, right) => compare(left.agentId, right.agentId))) {
      const lastTier = this.#lastNextTier.get(request.agentId) ?? "fast";
      const balance = request.agent.resources.llmTokens;
      const tier = expectedTier(lastTier, balance, this.#tierCost);
      // A starved agent gets no LLM call this tick — not a failed one.
      if (tier === "starved") continue;
      groups[tier].push(request);
    }

    const settled = await Promise.all(
      LIVE_THINK_TIERS.map((tier) => mapWithConcurrency(
        groups[tier],
        this.#tiers[tier].concurrency,
        (request) => this.#consultOne(request, tier, signal),
      )),
    );
    const records = settled.flat();
    for (const record of records) {
      if (record.nextTier !== undefined) this.#lastNextTier.set(record.agentId, record.nextTier);
    }
    // Stable output order, exactly like `LlmCognition.propose`.
    return records.sort((left, right) => compare(left.agentId, right.agentId));
  }

  /** Never throws: every path returns a `CognitionRecord`, successful or `unavailable`. */
  async #consultOne(request: CognitionRequest, tier: LiveThinkTier, signal?: AbortSignal): Promise<CognitionRecord> {
    const config = this.#tiers[tier];
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      if (signal?.aborted) break;
      if (attempt > 0) await sleep(this.#retryBackoffMs * attempt);
      const timeout = AbortSignal.timeout(config.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const response: CompletionResponse = await this.#completion.complete(
          {
            messages: [
              { role: "system", content: LIVE_COGNITION_SYSTEM_PROMPT },
              { role: "user", content: JSON.stringify(liveCognitionContext(request, tier, this.#tiers)) },
            ],
            responseFormat: "json",
            maxTokens: config.maxTokens,
            temperature: 0,
            metadata: { purpose: "genesis-live-cognition", cohort: this.cohort, tier },
            ...(config.requestOverrides === undefined ? {} : { extra: config.requestOverrides }),
          },
          { require: ["chat", "json", `tier:${tier}`] },
          combined,
        );
        return this.#toRecord(request, tier, response);
      } catch (error) {
        lastError = error;
        if (signal?.aborted || attempt === this.#maxRetries || !isRetryableGatewayError(error)) break;
      }
    }
    return unavailableRecord(request, tier, lastError, signal);
  }

  #toRecord(request: CognitionRequest, tier: LiveThinkTier, response: CompletionResponse): CognitionRecord {
    const parsed = parseLiveResponse(response.content, request);
    // Bounding the actions is the difference between a bloated answer being
    // recorded as unusable and the tick failing at the event size cap —
    // reproduced from `LlmCognition.#consult` verbatim.
    const overflow = Buffer.byteLength(canonicalJson(parsed.actions), "utf8") > this.#contentByteBudget;
    const actions = overflow ? [] : parsed.actions;
    const rejected = overflow ? `actions exceeded the ${this.#contentByteBudget}-byte budget` : parsed.rejected;
    const content = boundUtf8(response.content, this.#contentByteBudget);
    const reasoningTokens = response.reasoningTokens;
    const finishReason = response.finishReason;
    return {
      tick: request.tick,
      agentId: request.agentId,
      cohort: this.cohort,
      provider: response.provider,
      model: response.model,
      content: content.text,
      usage: response.usage,
      latencyMs: response.latencyMs,
      actions,
      tier,
      ...(rejected === undefined ? {} : { rejected }),
      ...(parsed.nextTier === undefined ? {} : { nextTier: parsed.nextTier }),
      ...(typeof reasoningTokens === "number" && Number.isSafeInteger(reasoningTokens) && reasoningTokens >= 0
        ? { reasoningTokens }
        : {}),
      ...(typeof finishReason === "string" && finishReason.length > 0
        ? { finishReason: finishReason.slice(0, 64) }
        : {}),
      ...(content.truncated ? { truncated: true } : {}),
    };
  }
}

function unavailableRecord(
  request: CognitionRequest,
  tier: LiveThinkTier,
  error: unknown,
  signal: AbortSignal | undefined,
): CognitionRecord {
  const message = error instanceof Error ? error.message : String(error);
  const reason = signal?.aborted ? `consultation aborted: ${message}` : `provider failure: ${message}`;
  return {
    tick: request.tick,
    agentId: request.agentId,
    cohort: "C",
    provider: "unavailable",
    model: "unavailable",
    content: "",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    latencyMs: 0,
    actions: [],
    tier,
    rejected: reason.slice(0, 300),
  };
}

/* ------------------------------------------------------------------ */
/* Bounded observation context (the observationBudget)                 */
/* ------------------------------------------------------------------ */

interface ParsedLiveResponse {
  actions: WorldAction[];
  rejected?: string;
  nextTier?: LiveThinkTier;
}

function parseLiveResponse(content: string, request: CognitionRequest): ParsedLiveResponse {
  // Reuses the science-track parser/validator verbatim: the action grammar it
  // accepts has not changed, only the prompt asking for it has.
  const parsed = parseCognitiveActions(content, request);
  let nextTier: LiveThinkTier | undefined;
  try {
    const raw: unknown = JSON.parse(content);
    if (
      isPlainObject(raw)
      && typeof raw.nextTier === "string"
      && (LIVE_THINK_TIERS as readonly string[]).includes(raw.nextTier)
    ) {
      nextTier = raw.nextTier as LiveThinkTier;
    }
  } catch {
    // Invalid JSON is already reflected in `parsed.rejected`.
  }
  return {
    actions: parsed.actions,
    ...(parsed.rejected === undefined ? {} : { rejected: parsed.rejected }),
    ...(nextTier === undefined ? {} : { nextTier }),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function selectTasks(tasks: readonly TaskObservation[], agentId: string, limit: number): TaskObservation[] {
  // Own claimed work first — that is what the agent most needs to see to keep
  // making progress on it — then the nearest deadlines among the rest.
  const claimed = tasks.filter((task) => task.claimedBy === agentId);
  const rest = tasks
    .filter((task) => task.claimedBy !== agentId)
    .sort((left, right) => left.deadlineTick - right.deadlineTick || compare(left.id, right.id));
  return [...claimed, ...rest].slice(0, limit);
}

/**
 * A deterministic sample of `limit` visible agents, ranked by a hash of
 * `(tick, agentId, candidateId)` rather than by id order — otherwise the
 * lowest-sorting ids would be the only ones ever sampled.
 */
function sampleVisibleAgents(
  tick: number,
  agentId: string,
  visibleAgents: readonly string[],
  limit: number,
): string[] {
  if (visibleAgents.length <= limit) return [...visibleAgents].sort(compare);
  return visibleAgents
    .map((candidate) => ({ candidate, rank: sha256Hex(`${tick}:${agentId}:${candidate}`) }))
    .sort((left, right) => compare(left.rank, right.rank))
    .slice(0, limit)
    .map((entry) => entry.candidate)
    .sort(compare);
}

function liveCognitionContext(request: CognitionRequest, tier: LiveThinkTier, tiers: LiveTiersSpec): JsonObject {
  const { observation, agent, tick, agentId } = request;
  const tierPricesPpm: Record<string, number> = {};
  for (const candidate of LIVE_THINK_TIERS) tierPricesPpm[candidate] = tiers[candidate].pricePpm;
  return {
    tick,
    agentId,
    assignedTier: tier,
    tierPricesPpm: tierPricesPpm as unknown as JsonValue,
    resources: agent.resources as unknown as JsonValue,
    memoryKeys: Object.keys(agent.memory).slice(0, LIVE_OBSERVATION_BUDGET.maxMemoryKeys),
    visibleAgentsCount: observation.visibleAgents.length,
    tasks: selectTasks(observation.tasks, agentId, LIVE_OBSERVATION_BUDGET.maxTasks) as unknown as JsonValue,
    submissions: observation.submissions.slice(0, LIVE_OBSERVATION_BUDGET.maxSubmissions) as unknown as JsonValue,
    inbox: observation.inbox.slice(0, LIVE_OBSERVATION_BUDGET.maxInbox) as unknown as JsonValue,
    neighbors: [...observation.neighbors].slice(0, LIVE_OBSERVATION_BUDGET.maxNeighbors),
    visibleAgentsSample: sampleVisibleAgents(
      tick,
      agentId,
      observation.visibleAgents,
      LIVE_OBSERVATION_BUDGET.maxVisibleAgentsSample,
    ),
    capabilities: observation.capabilities.slice(0, LIVE_OBSERVATION_BUDGET.maxCapabilities) as unknown as JsonValue,
    physics: observation.physics as unknown as JsonValue,
  };
}

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => { setTimeout(resolve, ms); });
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requirePositive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function requireNonNegative(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}
