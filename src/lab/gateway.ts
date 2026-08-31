import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { isIP } from "node:net";
import { dirname } from "node:path";

/**
 * The LLM gateway (experiment plan §20): the single controlled egress point
 * between a universe and an OpenAI-compatible model provider.
 *
 * The isolation argument is structural, not behavioural. Universe workers do
 * not hold the provider credential and have no direct egress route. The
 * gateway owns the credential, a narrow HTTP surface, bounded concurrency,
 * operational metering and a metadata-only audit trail.
 *
 * `maxTotalTokens` is deliberately a post-response stop threshold rather than
 * a claimed hard spend cap. A non-streaming proxy learns authoritative usage
 * only after the provider has performed the work, and some compatible
 * providers ignore requested output limits. Provider-side billing limits are
 * therefore the hard financial boundary; this process stops subsequent work
 * once accounted usage reaches or crosses its local threshold.
 */

export interface LlmGatewayOptions {
  /** OpenAI-compatible base URL, e.g. `https://host/v1`. */
  upstreamUrl: string;
  /** Upstream credential. Never logged, echoed or forwarded back. */
  apiKey?: string;
  /** Bearer token clients must present. Required for non-loopback binds. */
  authToken?: string;
  /** When set, requests for any other model are refused. */
  allowedModels?: readonly string[];
  /** Process-lifetime cap on requests accepted for forwarding. */
  maxRequests?: number;
  /** Post-response circuit breaker on accounted `usage.total_tokens`. */
  maxTotalTokens?: number;
  /** Sliding one-minute cap on requests accepted for forwarding. */
  ratePerMinute?: number;
  /** Maximum simultaneous upstream requests. Defaults to 4. */
  maxInFlight?: number;
  /** Maximum decompressed upstream response body. Defaults to 8 MiB. */
  maxResponseBytes?: number;
  /** Maximum audit file size before the gateway fails closed. Defaults to 64 MiB. */
  maxAuditBytes?: number;
  /** Append-only JSONL audit file containing metadata only. */
  auditPath?: string;
  /** Upstream timeout per request. */
  timeoutMs?: number;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

export interface LlmGatewayStats {
  requests: number;
  forwarded: number;
  denied: number;
  inFlight: number;
  totalTokens: number;
  ready: boolean;
}

export interface LlmGatewayIdentity {
  schemaVersion: 1;
  id: string;
  models: readonly string[] | "any";
}

const MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_MAX_RESPONSE_BYTES = 8_388_608;
const DEFAULT_MAX_AUDIT_BYTES = 67_108_864;
const DEFAULT_MAX_IN_FLIGHT = 4;
const MAX_PENDING_AUDITS = 1_024;
const MIN_AUTH_TOKEN_BYTES = 32;
const MAX_AUTH_TOKEN_BYTES = 4_096;
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

interface GatewayDecisionLog {
  at: string;
  decision: "attempted" | "forwarded" | "denied";
  requestId?: string;
  reason?: string;
  model?: string;
  status?: number;
  latencyMs?: number;
  requestBytes?: number;
  responseBytes?: number;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export class LlmGateway {
  readonly #options: LlmGatewayOptions;
  readonly #upstreamUrl: string;
  readonly #authDigest: Buffer | undefined;
  readonly #now: () => number;
  readonly #identity: LlmGatewayIdentity;
  readonly #instanceId = randomUUID();
  readonly #activeRequests = new Set<AbortController>();
  readonly #activeHandlers = new Set<Promise<void>>();
  #server: Server | undefined;
  #requests = 0;
  #forwarded = 0;
  #denied = 0;
  #inFlight = 0;
  #totalTokens = 0;
  #recent: number[] = [];
  #auditReady: Promise<void> = Promise.resolve();
  #auditBytes = 0;
  #pendingAudits = 0;
  #auditFailed = false;
  #meteringFailed = false;

  constructor(options: LlmGatewayOptions) {
    this.#upstreamUrl = validateUpstreamUrl(options.upstreamUrl);
    for (const [name, value] of Object.entries({
      maxRequests: options.maxRequests,
      maxTotalTokens: options.maxTotalTokens,
      ratePerMinute: options.ratePerMinute,
      maxInFlight: options.maxInFlight,
      maxResponseBytes: options.maxResponseBytes,
      maxAuditBytes: options.maxAuditBytes,
      timeoutMs: options.timeoutMs,
    })) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
        throw new Error(`Gateway ${name} must be a positive safe integer`);
      }
    }
    if (options.apiKey !== undefined && options.apiKey.length === 0) {
      throw new Error("Gateway apiKey must not be empty");
    }
    if (options.allowedModels !== undefined) {
      if (options.allowedModels.length === 0) {
        throw new Error("Gateway allowedModels must not be an empty list");
      }
      if (options.allowedModels.some((model) => !isValidModel(model))) {
        throw new Error("Gateway allowedModels must contain unique non-empty printable model names");
      }
      if (new Set(options.allowedModels).size !== options.allowedModels.length) {
        throw new Error("Gateway allowedModels must contain unique non-empty printable model names");
      }
    }
    const storedOptions: LlmGatewayOptions = {
      ...options,
      upstreamUrl: this.#upstreamUrl,
      ...(options.allowedModels === undefined ? {} : { allowedModels: [...options.allowedModels] }),
    };
    delete storedOptions.authToken;
    this.#options = storedOptions;
    this.#authDigest = createAuthDigest(options.authToken);
    this.#now = options.now ?? Date.now;
    this.#identity = Object.freeze({
      schemaVersion: 1,
      id: `gateway-v1-${createHash("sha256").update(this.#upstreamUrl, "utf8").digest("hex").slice(0, 32)}`,
      models: options.allowedModels === undefined ? "any" : Object.freeze([...options.allowedModels]),
    });
  }

  async listen(port: number, host = "127.0.0.1"): Promise<{ host: string; port: number }> {
    if (this.#server !== undefined) throw new Error("Gateway is already listening");
    if (!isLoopbackHost(host) && this.#authDigest === undefined) {
      throw new Error("Gateway refuses a non-loopback bind without client Bearer authentication");
    }
    if (this.#options.auditPath !== undefined) {
      await mkdir(dirname(this.#options.auditPath), { recursive: true });
      await appendFile(this.#options.auditPath, "", { encoding: "utf8", mode: 0o600, flag: "a" });
      this.#auditBytes = (await stat(this.#options.auditPath)).size;
      if (this.#auditBytes > (this.#options.maxAuditBytes ?? DEFAULT_MAX_AUDIT_BYTES)) {
        throw new Error("Gateway audit file already exceeds its configured size limit");
      }
    }

    const dispatch = (request: IncomingMessage, response: ServerResponse): void => {
      const handling = this.#handle(request, response).catch(() => {
        try {
          if (!response.headersSent && !response.writableEnded) {
            sendJson(response, this.#auditFailed ? 503 : 500, {
              error: this.#auditFailed ? "audit_unavailable" : "internal_error",
            });
          } else if (!response.writableEnded) {
            response.destroy();
          }
        } catch {
          response.destroy();
        }
      });
      this.#trackHandler(handling);
    };
    const server = createServer(
      { maxHeaderSize: 16_384, requireHostHeader: true },
      dispatch,
    );
    server.on("checkContinue", (request, response) => {
      const requestId = this.#nextRequestId();
      response.setHeader("connection", "close");
      const contentLength = declaredContentLength(request);
      const handling = this.#deny(response, 417, "expectation_failed", {
        requestId,
        ...(contentLength === undefined ? {} : { requestBytes: contentLength }),
      }).catch(() => {
        try {
          if (!response.headersSent && !response.writableEnded) {
            sendJson(response, 503, { error: "audit_unavailable" });
          }
        } catch {
          response.destroy();
        }
      });
      this.#trackHandler(handling);
    });
    server.headersTimeout = 5_000;
    server.requestTimeout = 15_000;
    server.keepAliveTimeout = 5_000;
    server.maxHeadersCount = 100;
    server.maxRequestsPerSocket = 100;
    this.#server = server;

    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.once("error", rejectPromise);
        server.listen(port, host, () => {
          server.removeListener("error", rejectPromise);
          resolvePromise();
        });
      });
    } catch (error) {
      this.#server = undefined;
      server.closeAllConnections();
      throw error;
    }

    const address = server.address();
    const boundPort = address !== null && typeof address === "object" ? address.port : port;
    return { host, port: boundPort };
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    for (const controller of this.#activeRequests) controller.abort();
    if (server !== undefined) {
      server.closeAllConnections();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
    await Promise.allSettled([...this.#activeHandlers]);
    await this.#auditReady;
  }

  stats(): LlmGatewayStats {
    return {
      requests: this.#requests,
      forwarded: this.#forwarded,
      denied: this.#denied,
      inFlight: this.#inFlight,
      totalTokens: this.#totalTokens,
      ready: !this.#auditFailed && !this.#meteringFailed,
    };
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "GET" && request.url === "/healthz") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (request.method === "GET" && request.url === "/readyz") {
      const ready = !this.#auditFailed && !this.#meteringFailed;
      sendJson(response, ready ? 200 : 503, { status: ready ? "ready" : "degraded" });
      return;
    }
    if (request.method === "GET" && request.url === "/identity") {
      sendJson(response, 200, this.#identity);
      return;
    }

    const requestId = this.#nextRequestId();
    if (request.method !== "POST" || request.url !== CHAT_COMPLETIONS_PATH) {
      await this.#deny(response, 404, "unknown_path", { requestId });
      return;
    }
    if (!this.#authorized(request)) {
      response.setHeader("WWW-Authenticate", 'Bearer realm="anu-llm-gateway"');
      await this.#deny(response, 401, "unauthorized", { requestId });
      return;
    }
    if (this.#auditFailed) {
      sendJson(response, 503, { error: "audit_unavailable" });
      return;
    }
    if (this.#meteringFailed) {
      await this.#deny(response, 503, "metering_unavailable", { requestId });
      return;
    }
    if (this.#inFlight >= (this.#options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT)) {
      await this.#deny(response, 429, "too_many_in_flight", { requestId });
      return;
    }
    this.#inFlight += 1;

    try {
      const body = await readRequestBody(request, MAX_REQUEST_BYTES);
      if (body === undefined) {
        response.setHeader("connection", "close");
        await this.#deny(response, 413, "request_too_large", { requestId });
        return;
      }
      let parsed: Record<string, unknown>;
      try {
        const candidate: unknown = JSON.parse(body.toString("utf8"));
        if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
          throw new Error("not an object");
        }
        parsed = candidate as Record<string, unknown>;
      } catch {
        await this.#deny(response, 400, "invalid_json", { requestId, requestBytes: body.length });
        return;
      }

      const model = typeof parsed.model === "string" ? parsed.model : undefined;
      const log: Partial<GatewayDecisionLog> = {
        requestId,
        requestBytes: body.length,
        ...(model === undefined ? {} : { model }),
      };
      if (model === undefined || !isValidModel(model)) {
        await this.#deny(response, 400, "model_required", log);
        return;
      }
      if (parsed.stream !== undefined && parsed.stream !== false) {
        await this.#deny(response, 400, "streaming_not_supported", log);
        return;
      }
      if (this.#options.allowedModels !== undefined && !this.#options.allowedModels.includes(model)) {
        await this.#deny(response, 403, "model_not_allowed", log);
        return;
      }
      if (this.#options.maxRequests !== undefined && this.#forwarded >= this.#options.maxRequests) {
        await this.#deny(response, 429, "request_budget_exhausted", log);
        return;
      }
      if (this.#options.maxTotalTokens !== undefined && this.#totalTokens >= this.#options.maxTotalTokens) {
        await this.#deny(response, 429, "token_stop_threshold_reached", log);
        return;
      }
      if (!this.#withinRate()) {
        await this.#deny(response, 429, "rate_limited", log);
        return;
      }

      // Reservation is synchronous with the checks above, so request, rate and
      // concurrency limits cannot be raced by other callbacks on this process.
      this.#forwarded += 1;
      if (this.#options.ratePerMinute !== undefined) this.#recent.push(this.#now());
      const started = this.#now();
      const controller = new AbortController();
      this.#activeRequests.add(controller);
      let upstreamSucceeded = false;

      try {
        await this.#audit({
          at: new Date(this.#now()).toISOString(),
          decision: "attempted",
          ...log,
        });
        const timeout = AbortSignal.timeout(this.#options.timeoutMs ?? 180_000);
        const upstream = await fetch(`${this.#upstreamUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.#options.apiKey === undefined ? {} : { authorization: `Bearer ${this.#options.apiKey}` }),
          },
          body: new Uint8Array(body),
          redirect: "manual",
          signal: AbortSignal.any([controller.signal, timeout]),
        });
        upstreamSucceeded = upstream.ok;
        if (upstream.status >= 300 && upstream.status < 400) {
          await upstream.body?.cancel();
          await this.#forwardingFailure(response, 502, "upstream_redirect_refused", log, started);
          return;
        }

        const payload = await readResponseBody(
          upstream,
          this.#options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
        );
        if (payload === undefined) {
          if (upstream.ok) this.#meteringFailed = true;
          await this.#forwardingFailure(response, 502, "upstream_response_too_large", log, started);
          return;
        }

        const usage = extractUsage(payload);
        if (upstream.ok && usage === undefined) {
          this.#meteringFailed = true;
          await this.#forwardingFailure(
            response,
            502,
            "upstream_usage_invalid",
            { ...log, responseBytes: payload.length },
            started,
          );
          return;
        }
        if (usage !== undefined) {
          const nextTotal = this.#totalTokens + usage.totalTokens;
          if (!Number.isSafeInteger(nextTotal)) {
            this.#meteringFailed = true;
            await this.#forwardingFailure(response, 502, "upstream_usage_invalid", log, started);
            return;
          }
          this.#totalTokens = nextTotal;
        }

        const thresholdCrossed = usage !== undefined
          && this.#options.maxTotalTokens !== undefined
          && this.#totalTokens >= this.#options.maxTotalTokens;
        await this.#audit({
          at: new Date(this.#now()).toISOString(),
          decision: "forwarded",
          ...(thresholdCrossed ? { reason: "token_stop_threshold_reached" } : {}),
          ...log,
          status: upstream.status,
          latencyMs: this.#now() - started,
          responseBytes: payload.length,
          ...(usage === undefined ? {} : { usage }),
        });
        response.writeHead(upstream.status, {
          "cache-control": "no-store",
          "content-type": upstream.headers.get("content-type") ?? "application/json",
          "x-anu-gateway-identity": this.#identity.id,
          "x-content-type-options": "nosniff",
        });
        response.end(payload);
      } catch (error) {
        if (this.#auditFailed) throw error;
        if (upstreamSucceeded) this.#meteringFailed = true;
        const timedOut = timeoutError(error);
        await this.#forwardingFailure(
          response,
          timedOut ? 504 : 502,
          timedOut ? "upstream_timeout" : "upstream_unreachable",
          log,
          started,
        );
      } finally {
        this.#activeRequests.delete(controller);
      }
    } finally {
      this.#inFlight -= 1;
    }
  }

  #authorized(request: IncomingMessage): boolean {
    if (this.#authDigest === undefined) return true;
    const values = request.headersDistinct.authorization;
    const candidate = values?.length === 1 ? values[0] ?? "" : "";
    const digest = createHash("sha256").update(candidate, "utf8").digest();
    const authorized = values?.length === 1 && timingSafeEqual(digest, this.#authDigest);
    digest.fill(0);
    return authorized === true;
  }

  #withinRate(): boolean {
    const limit = this.#options.ratePerMinute;
    if (limit === undefined) return true;
    const cutoff = this.#now() - 60_000;
    this.#recent = this.#recent.filter((at) => at > cutoff);
    return this.#recent.length < limit;
  }

  #nextRequestId(): string {
    this.#requests += 1;
    return `${this.#instanceId}:${this.#requests}`;
  }

  #trackHandler(handler: Promise<void>): void {
    this.#activeHandlers.add(handler);
    void handler.then(
      () => this.#activeHandlers.delete(handler),
      () => this.#activeHandlers.delete(handler),
    );
  }

  async #forwardingFailure(
    response: ServerResponse,
    status: number,
    reason: string,
    log: Partial<GatewayDecisionLog>,
    started: number,
  ): Promise<void> {
    await this.#audit({
      at: new Date(this.#now()).toISOString(),
      decision: "forwarded",
      reason,
      ...log,
      status,
      latencyMs: this.#now() - started,
    });
    if (!response.headersSent && !response.writableEnded) sendJson(response, status, { error: reason });
  }

  async #deny(
    response: ServerResponse,
    status: number,
    reason: string,
    log: Partial<GatewayDecisionLog>,
  ): Promise<void> {
    this.#denied += 1;
    await this.#audit({ at: new Date(this.#now()).toISOString(), decision: "denied", reason, ...log, status });
    if (!response.headersSent && !response.writableEnded) sendJson(response, status, { error: reason });
  }

  async #audit(entry: GatewayDecisionLog): Promise<void> {
    const path = this.#options.auditPath;
    if (path === undefined) return;
    if (this.#auditFailed) throw new Error("Gateway audit is unavailable");
    if (this.#pendingAudits >= MAX_PENDING_AUDITS) {
      this.#auditFailed = true;
      throw new Error("Gateway audit queue limit reached");
    }

    const line = `${JSON.stringify(entry)}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    this.#pendingAudits += 1;
    const write = this.#auditReady.then(async () => {
      if (this.#auditBytes + bytes > (this.#options.maxAuditBytes ?? DEFAULT_MAX_AUDIT_BYTES)) {
        throw new Error("Gateway audit size limit reached");
      }
      await appendFile(path, line, { encoding: "utf8", mode: 0o600, flag: "a" });
      this.#auditBytes += bytes;
    });
    this.#auditReady = write.catch(() => {
      this.#auditFailed = true;
    });
    try {
      await write;
    } finally {
      this.#pendingAudits -= 1;
    }
  }
}

function validateUpstreamUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Gateway upstream must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Gateway upstream must be an absolute http(s) URL");
  }
  if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
    throw new Error("Gateway upstream must not contain credentials, a query or a fragment");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error("Gateway upstream must use HTTPS unless it is a loopback address");
  }
  return url.toString().replace(/\/$/, "");
}

function createAuthDigest(token: string | undefined): Buffer | undefined {
  if (token === undefined) return undefined;
  const tokenBytes = Buffer.byteLength(token, "utf8");
  if (
    tokenBytes < MIN_AUTH_TOKEN_BYTES
    || tokenBytes > MAX_AUTH_TOKEN_BYTES
    || !/^[A-Za-z0-9\-._~+/]+=*$/.test(token)
  ) {
    throw new TypeError(
      `Gateway auth token must be ${MIN_AUTH_TOKEN_BYTES}..${MAX_AUTH_TOKEN_BYTES} bytes of token68 data`,
    );
  }
  return createHash("sha256").update(`Bearer ${token}`, "utf8").digest();
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) !== 4) return false;
  return normalized.split(".", 1)[0] === "127";
}

function isValidModel(model: string): boolean {
  return model.length > 0
    && model.length <= 256
    && model.trim() === model
    && !/\s/u.test(model)
    && !/[\u0000-\u001f\u007f]/u.test(model);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

function declaredContentLength(request: IncomingMessage): number | undefined {
  const raw = request.headers["content-length"];
  if (raw === undefined || Array.isArray(raw) || !/^(0|[1-9][0-9]*)$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

async function readRequestBody(request: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const declared = declaredContentLength(request);
  if (declared !== undefined && declared > limit) {
    request.resume();
    return undefined;
  }

  return new Promise<Buffer | undefined>((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        settled = true;
        chunks.length = 0;
        resolvePromise(undefined);
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => {
      if (settled) return;
      settled = true;
      resolvePromise(Buffer.concat(chunks, total));
    });
    request.once("aborted", () => fail(new Error("Request body was aborted")));
    request.once("error", fail);
  });
}

async function readResponseBody(response: Response, limit: number): Promise<Buffer | undefined> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^(0|[1-9][0-9]*)$/.test(declared) && Number(declared) > limit) {
    await response.body?.cancel();
    return undefined;
  }
  if (response.body === null) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.length;
      if (total > limit) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function extractUsage(
  payload: Buffer,
): { promptTokens: number; completionTokens: number; totalTokens: number } | undefined {
  try {
    const parsed: unknown = JSON.parse(payload.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const usage = (parsed as { usage?: unknown }).usage;
    if (typeof usage !== "object" || usage === null) return undefined;
    const record = usage as Record<string, unknown>;
    const prompt = record.prompt_tokens;
    const completion = record.completion_tokens;
    const total = record.total_tokens;
    if (
      !Number.isSafeInteger(prompt)
      || !Number.isSafeInteger(completion)
      || !Number.isSafeInteger(total)
      || (prompt as number) < 0
      || (completion as number) < 0
      || (total as number) < (prompt as number) + (completion as number)
    ) {
      return undefined;
    }
    return {
      promptTokens: prompt as number,
      completionTokens: completion as number,
      totalTokens: total as number,
    };
  } catch {
    return undefined;
  }
}

function timeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || /timed?\s*out/i.test(error.message));
}
