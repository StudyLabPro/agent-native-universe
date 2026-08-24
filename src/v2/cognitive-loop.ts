import { randomUUID } from "node:crypto";
import { PersistentResourceEconomy } from "./persistent-market.js";
import type {
  AgentCognitivePort,
  CognitiveAction,
  CognitiveDecision,
  JsonObject,
  JsonValue,
  LlmCompletionPort,
  LlmRequest,
  LlmResponse,
} from "./types.js";

export interface CognitiveBillingPolicy {
  providerAccount: string;
  reserveOutputTokens?: number;
  tokenSafetyFactor?: number;
  inputCreditsPerThousand?: number;
  outputCreditsPerThousand?: number;
  /**
   * How to treat usage that exceeds the reservation.
   *
   * `"topUp"` (default) draws the difference from the agent's balance. It keeps
   * the thought alive, but it also means a reservation bounds nothing at all
   * for a solvent agent — providers that ignore the requested output cap can
   * spend arbitrarily beyond it.
   *
   * `"reject"` treats the reservation as a real ceiling. The reserved amount is
   * still settled to the provider — the work was genuinely performed and must
   * be paid for — and {@link CognitiveOverrunError} is raised so the caller
   * learns the bound was breached instead of silently absorbing the cost.
   */
  overrunPolicy?: "topUp" | "reject";
}

export type MeteredResource = "model_tokens" | "credits";

/** A reservation that real usage exceeded. Reported whether or not it was honoured. */
export interface ReservationOverrun {
  resource: MeteredResource;
  reserved: number;
  required: number;
  /** Drawn from the agent's balance to cover the excess; 0 under `"reject"`. */
  toppedUp: number;
}

/** Usage a provider really delivered that the ledger could not bill in full. */
export interface UnbilledUsage {
  resource: MeteredResource;
  delivered: number;
  billed: number;
}

export class CognitiveOverrunError extends Error {
  readonly unbilled: UnbilledUsage[];

  constructor(
    readonly thoughtId: string,
    readonly overrun: ReservationOverrun,
    unbilled: UnbilledUsage[] = [],
  ) {
    super(
      `Thought ${thoughtId} required ${overrun.required} ${overrun.resource} but reserved only ${overrun.reserved}`,
    );
    this.name = "CognitiveOverrunError";
    this.unbilled = unbilled;
  }
}

export interface ThoughtResult {
  id: string;
  agentId: string;
  response: LlmResponse;
  decision: CognitiveDecision;
  chargedModelTokens: number;
  chargedCredits: number;
  actions: CognitiveAction[];
  /** Reservations that real usage exceeded. Empty when everything fit. */
  overruns: ReservationOverrun[];
  startedAt: number;
  completedAt: number;
}

export interface ThoughtOptions {
  input?: JsonObject;
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  providerPolicy?: { require?: string[]; prefer?: string[]; maxEstimatedCost?: number };
  actionHandler?: (agent: AgentCognitivePort, action: CognitiveAction) => void | Promise<void>;
  signal?: AbortSignal;
}

export class MeteredCognitiveLoop {
  constructor(
    readonly economy: PersistentResourceEconomy,
    readonly llm: LlmCompletionPort,
    readonly billing: CognitiveBillingPolicy,
  ) {}

  async think(agent: AgentCognitivePort, options: ThoughtOptions = {}): Promise<ThoughtResult> {
    const startedAt = Date.now();
    const thoughtId = `thought:${randomUUID()}`;
    const snapshot = agent.snapshot();
    const request = buildRequest(snapshot, options);
    const inputEstimate = estimateTokens(request.messages.map((message) => message.content).join("\n"));
    const outputReserve = options.maxTokens ?? this.billing.reserveOutputTokens ?? 1024;
    const tokenReserve = Math.max(1, Math.ceil((inputEstimate + outputReserve) * (this.billing.tokenSafetyFactor ?? 1.15)));
    const creditReserve = estimateCreditCharge(
      inputEstimate,
      outputReserve,
      this.billing.inputCreditsPerThousand ?? 0,
      this.billing.outputCreditsPerThousand ?? 0,
    );

    const tokenReservation = await this.economy.reserve(
      agent.id,
      "model_tokens",
      tokenReserve,
      `${thoughtId}:tokens`,
      "LLM thought token reserve",
    );
    let creditReservation: { reservationId: string; account: string } | undefined;
    const overrunPolicy = this.billing.overrunPolicy ?? "topUp";
    const overruns: ReservationOverrun[] = [];
    /** Set once the provider has answered; from then on the spend is real. */
    let completion: LlmResponse | undefined;
    let tokensSettled = false;
    let creditsSettled = false;
    try {
      if (creditReserve > 0) {
        creditReservation = await this.economy.reserve(
          agent.id,
          "credits",
          creditReserve,
          `${thoughtId}:credits`,
          "LLM thought credit reserve",
        );
      }

      const response = await this.llm.complete(
        request,
        { require: ["chat", "json"], ...(options.providerPolicy ?? {}) },
        options.signal,
      );
      // From here on the provider has really executed the completion: the cost
      // exists in the outside world whatever happens next in this function.
      completion = response;

      const deliveredModelTokens = Math.max(1, response.usage.totalTokens || estimateTokens(response.content));
      const tokenOverrun = await reconcileReservation(
        this.economy,
        agent.id,
        tokenReservation.account,
        "model_tokens",
        deliveredModelTokens,
        tokenReserve,
        thoughtId,
        overrunPolicy,
      );
      if (tokenOverrun) overruns.push(tokenOverrun);
      const rejectedTokens = tokenOverrun !== undefined && tokenOverrun.toppedUp === 0;
      const chargedModelTokens = rejectedTokens ? tokenReserve : deliveredModelTokens;
      await this.economy.settleReservation(
        tokenReservation.reservationId,
        this.billing.providerAccount,
        "model_tokens",
        chargedModelTokens,
        agent.id,
        "LLM token usage settlement",
      );
      tokensSettled = true;
      if (rejectedTokens) {
        throw new CognitiveOverrunError(thoughtId, tokenOverrun, [
          { resource: "model_tokens", delivered: deliveredModelTokens, billed: chargedModelTokens },
        ]);
      }

      const deliveredCredits = estimateCreditCharge(
        response.usage.inputTokens,
        response.usage.outputTokens,
        this.billing.inputCreditsPerThousand ?? 0,
        this.billing.outputCreditsPerThousand ?? 0,
      );
      let chargedCredits = deliveredCredits;
      if (creditReservation) {
        const creditOverrun = await reconcileReservation(
          this.economy,
          agent.id,
          creditReservation.account,
          "credits",
          deliveredCredits,
          creditReserve,
          thoughtId,
          overrunPolicy,
        );
        if (creditOverrun) overruns.push(creditOverrun);
        const rejectedCredits = creditOverrun !== undefined && creditOverrun.toppedUp === 0;
        chargedCredits = rejectedCredits ? creditReserve : deliveredCredits;
        if (chargedCredits > 0) {
          await this.economy.settleReservation(
            creditReservation.reservationId,
            this.billing.providerAccount,
            "credits",
            chargedCredits,
            agent.id,
            "LLM credit usage settlement",
          );
        } else {
          await this.economy.refundReservation(creditReservation.reservationId, agent.id, "credits");
        }
        creditsSettled = true;
        if (rejectedCredits) {
          throw new CognitiveOverrunError(thoughtId, creditOverrun, [
            { resource: "credits", delivered: deliveredCredits, billed: chargedCredits },
          ]);
        }
      } else if (chargedCredits > 0) {
        await this.economy.transfer(
          agent.id,
          this.billing.providerAccount,
          "credits",
          chargedCredits,
          "LLM credit usage settlement",
          thoughtId,
        );
      }

      agent.consumeBudget?.("tokens", chargedModelTokens);
      agent.consumeBudget?.("latencyMs", response.latencyMs);
      const decision = parseDecision(response.content);
      applyDecision(agent, decision);
      const actions = decision.actions ?? [];
      for (const action of actions) await options.actionHandler?.(agent, action);
      const completedAt = Date.now();
      agent.setEphemeral?.({
        lastThought: {
          id: thoughtId,
          provider: response.provider,
          model: response.model,
          chargedModelTokens,
          chargedCredits,
          startedAt,
          completedAt,
          summary: decision.summary ?? "",
        },
      });
      return {
        id: thoughtId,
        agentId: agent.id,
        response,
        decision,
        chargedModelTokens,
        chargedCredits,
        actions,
        overruns,
        startedAt,
        completedAt,
      };
    } catch (error) {
      // A completion that already came back was really executed and really
      // cost tokens. Refunding it would erase spend that has happened in the
      // outside world, leaving a ledger that quietly under-reports the truth.
      // Only a thought that never reached the provider may be refunded whole.
      const unbilled: UnbilledUsage[] = [];
      if (!tokensSettled) {
        if (completion) {
          const delivered = Math.max(1, completion.usage.totalTokens || estimateTokens(completion.content));
          const shortfall = await settleDelivered(
            this.economy,
            tokenReservation.reservationId,
            this.billing.providerAccount,
            "model_tokens",
            delivered,
            agent.id,
            tokenReserve,
          );
          if (shortfall) unbilled.push(shortfall);
        } else {
          await this.economy.refundReservation(tokenReservation.reservationId, agent.id, "model_tokens");
        }
      }
      if (creditReservation && !creditsSettled) {
        await this.economy.refundReservation(creditReservation.reservationId, agent.id, "credits");
      }
      if (unbilled.length > 0 && error instanceof Error && !(error instanceof CognitiveOverrunError)) {
        Object.defineProperty(error, "unbilled", { value: unbilled, enumerable: true, configurable: true });
      }
      throw error;
    }
  }
}

export interface ScheduledMind {
  agent: AgentCognitivePort;
  intervalMs: number;
  input?: () => JsonObject | Promise<JsonObject>;
  options?: Omit<ThoughtOptions, "input" | "signal">;
  onResult?: (result: ThoughtResult) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
}

export class CognitiveScheduler {
  readonly #minds = new Map<string, ScheduledMind>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #running = new Set<string>();
  #stopped = true;

  constructor(readonly loop: MeteredCognitiveLoop) {}

  register(mind: ScheduledMind): void {
    if (!Number.isFinite(mind.intervalMs) || mind.intervalMs < 1) throw new Error("Cognitive interval must be positive");
    this.#minds.set(mind.agent.id, mind);
    if (!this.#stopped) this.#schedule(mind.agent.id, 0);
  }

  unregister(agentId: string): void {
    this.#minds.delete(agentId);
    const timer = this.#timers.get(agentId);
    if (timer) clearTimeout(timer);
    this.#timers.delete(agentId);
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    for (const id of this.#minds.keys()) this.#schedule(id, 0);
  }

  stop(): void {
    this.#stopped = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  async runOnce(agentId: string): Promise<ThoughtResult> {
    const mind = this.#minds.get(agentId);
    if (!mind) throw new Error(`Unknown scheduled mind ${agentId}`);
    if (this.#running.has(agentId)) throw new Error(`Mind ${agentId} is already thinking`);
    this.#running.add(agentId);
    try {
      const input = await mind.input?.();
      const result = await this.loop.think(mind.agent, { ...(mind.options ?? {}), ...(input ? { input } : {}) });
      await mind.onResult?.(result);
      return result;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      await mind.onError?.(normalized);
      throw normalized;
    } finally {
      this.#running.delete(agentId);
    }
  }

  wake(agentId: string): void {
    if (!this.#minds.has(agentId)) throw new Error(`Unknown scheduled mind ${agentId}`);
    const timer = this.#timers.get(agentId);
    if (timer) clearTimeout(timer);
    this.#schedule(agentId, 0);
  }

  #schedule(agentId: string, delay?: number): void {
    if (this.#stopped) return;
    const mind = this.#minds.get(agentId);
    if (!mind) return;
    const timer = setTimeout(() => {
      this.#timers.delete(agentId);
      void this.runOnce(agentId)
        .catch(() => undefined)
        .finally(() => this.#schedule(agentId, mind.intervalMs));
    }, delay ?? mind.intervalMs);
    timer.unref?.();
    this.#timers.set(agentId, timer);
  }
}

function buildRequest(snapshot: ReturnType<AgentCognitivePort["snapshot"]>, options: ThoughtOptions): LlmRequest {
  const system = options.systemPrompt ?? [
    "You are the cognitive process of a bounded autonomous NanoAgent.",
    "Return one valid JSON object only.",
    "Allowed keys: privateState, exposedState, durableState, ephemeralState, actions, summary.",
    "Each state value must be a JSON object. actions is an array of {type,payload}.",
    "Do not claim to have executed actions; only request them through actions.",
  ].join("\n");
  const context: JsonObject = {
    objective: (snapshot.objective ?? {}) as unknown as JsonValue,
    capabilities: (snapshot.capabilities ?? []) as unknown as JsonValue,
    privateState: snapshot.privateState ?? {},
    exposedState: snapshot.exposedState ?? {},
    durableState: snapshot.durableState ?? {},
    ephemeralState: snapshot.ephemeralState ?? {},
    input: options.input ?? {},
  };
  return {
    ...(options.model ? { model: options.model } : {}),
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(context) },
    ],
    responseFormat: "json",
    maxTokens: options.maxTokens ?? 1024,
    temperature: 0,
    metadata: { purpose: "nanoagent-thought" },
  };
}

function parseDecision(content: string): CognitiveDecision {
  const parsed = JSON.parse(content) as CognitiveDecision;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("LLM cognitive result must be a JSON object");
  for (const key of ["privateState", "exposedState", "durableState", "ephemeralState"] as const) {
    const value = parsed[key];
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
      throw new Error(`${key} must be a JSON object`);
    }
  }
  if (parsed.actions !== undefined) {
    if (!Array.isArray(parsed.actions)) throw new Error("actions must be an array");
    for (const action of parsed.actions) {
      if (!action || typeof action.type !== "string" || !action.payload || typeof action.payload !== "object" || Array.isArray(action.payload)) {
        throw new Error("Each cognitive action must contain a string type and object payload");
      }
    }
  }
  return parsed;
}

function applyDecision(agent: AgentCognitivePort, decision: CognitiveDecision): void {
  if (decision.privateState) agent.think?.(decision.privateState);
  if (decision.exposedState) agent.expose?.(decision.exposedState);
  if (decision.durableState) agent.remember?.(decision.durableState);
  if (decision.ephemeralState) agent.setEphemeral?.(decision.ephemeralState);
}

/**
 * Reconcile a reservation with the usage a provider actually delivered.
 *
 * Returns the overrun whenever one happened, even when it is absorbed: an
 * overrun nobody can observe is indistinguishable from a bound that works.
 */
async function reconcileReservation(
  economy: PersistentResourceEconomy,
  owner: string,
  reservationAccount: string,
  resource: MeteredResource,
  required: number,
  reserved: number,
  reference: string,
  policy: "topUp" | "reject",
): Promise<ReservationOverrun | undefined> {
  if (required <= reserved) return undefined;
  if (policy === "reject") return { resource, reserved, required, toppedUp: 0 };
  const shortfall = required - reserved;
  await economy.transfer(owner, reservationAccount, resource, shortfall, "LLM reservation top-up", reference);
  return { resource, reserved, required, toppedUp: shortfall };
}

/**
 * Settle usage a provider already delivered, capped by what the reservation
 * holds. Returns the part that could not be billed so the caller can report a
 * ledger that knowingly under-records real spend rather than hiding it.
 */
async function settleDelivered(
  economy: PersistentResourceEconomy,
  reservationId: string,
  beneficiary: string,
  resource: MeteredResource,
  delivered: number,
  owner: string,
  reserved: number,
): Promise<UnbilledUsage | undefined> {
  const billable = Math.min(delivered, reserved);
  if (billable <= 0) {
    await economy.refundReservation(reservationId, owner, resource);
    return { resource, delivered, billed: 0 };
  }
  await economy.settleReservation(
    reservationId,
    beneficiary,
    resource,
    billable,
    owner,
    "LLM usage settlement after failed thought",
  );
  return billable < delivered ? { resource, delivered, billed: billable } : undefined;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function estimateCreditCharge(inputTokens: number, outputTokens: number, inputRate: number, outputRate: number): number {
  const raw = (inputTokens * inputRate + outputTokens * outputRate) / 1000;
  if (raw <= 0) return 0;
  return Math.max(1, Math.ceil(raw));
}
