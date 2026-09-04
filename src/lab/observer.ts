import { constants } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { lstat, readdir, realpath, type FileHandle } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { join, relative, resolve, sep } from "node:path";
import { canonicalJson, compareCodeUnits, hashValue } from "./canonical.js";
import { validateRunEvidenceAttestation } from "./evidence-attestation-schema.js";
import { openRegularFileNoFollow } from "./event-stream.js";
import { MAX_LAB_EVENT_BYTES, validateLabEvent } from "./events.js";
import { LIVE_UNIVERSE_ID } from "./live/identity.js";
import {
  OBSERVER_UI_ASSETS,
  OBSERVER_UI_HTML,
  type ObserverUiAsset,
} from "./observer-ui.js";
import { applyWorldEventMutable, initialWorldState } from "./reducer.js";
import {
  LAB_LIVE_EXPERIMENT_ID,
  LAB_SCHEMA_VERSION,
  type LabEvent,
  type LabRunMode,
  type RunEvidenceAttestation,
  type RunManifest,
  type WorldState,
} from "./types.js";
import { ANU_VERSION } from "../version.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 1_000;
const MAX_REQUEST_TARGET_BYTES = 4_096;
const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_ENTRIES = 20_000;
const MAX_RUNS = 1_000;
const MAX_JSON_ARTIFACT_BYTES = 1_048_576;
const MAX_OBSERVER_METRICS_BYTES = 8_388_608;
const MAX_EVENT_SCAN_BYTES = 67_108_864;
const MAX_EVENT_RESPONSE_BYTES = 4_194_304;
const MAX_EVENT_INDEX_RUNS = 64;
const MAX_EVENT_INDEX_ENTRIES = 2_048;
const MAX_EVENT_INDEX_PROBES = 48;
const EVENT_INDEX_SEEK_THRESHOLD_BYTES = 1_048_576;
const EVENT_PROBE_CHUNK_BYTES = 65_536;
const EVENT_INDEX_TAIL_ANCHOR_BYTES = 65_536;
const MIN_AUTH_TOKEN_BYTES = 32;
const MAX_AUTH_TOKEN_BYTES = 4_096;
/** Checkpoint artifacts project a whole WorldState; larger than metrics/manifest but still bounded. */
const MAX_STATE_CHECKPOINT_BYTES = 8_388_608;
/** Projected /state responses share the /events response cap: both surface at most one tick's worth of evidence. */
const MAX_STATE_RESPONSE_BYTES = MAX_EVENT_RESPONSE_BYTES;
/** cognitionHealth is computed over this many trailing ticks of the live head's run. */
const LIVE_COGNITION_HEALTH_WINDOW_TICKS = 50;
/** Directory names reserved by the live universe layout; never a run's own directory. */
const LIVE_RESERVED_DIRECTORY_NAMES = new Set(["chain", "anchors", "tasks", "verdicts", "physics"]);

const RUN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const REDACTED = "[REDACTED]";

export interface ObserverServerOptions {
  /** Directory that contains run directories, directly or below experiment directories. */
  dataDir: string;
  /** Used by startObserverServer. Defaults to the loopback interface. */
  host?: string;
  /** Used by startObserverServer. Defaults to 8787; zero requests an ephemeral port. */
  port?: number;
  /** Optional Bearer token. When omitted, evidence routes are unauthenticated and must stay internal. */
  authToken?: string;
}

interface RunRecord {
  directory: string;
  relativeDirectory: string;
  manifest: Record<string, unknown>;
  runId: string;
}

interface RunDiscovery {
  ambiguous: boolean;
  records: RunRecord[];
  truncated: boolean;
}

interface OptionalAttestationArtifact {
  attestation: RunEvidenceAttestation | null;
  status: "invalid" | "missing" | "self_consistent";
}

interface EventFileIdentity {
  ctimeNs: bigint;
  device: bigint;
  inode: bigint;
  mtimeNs: bigint;
  size: bigint;
}

interface EventCheckpoint {
  endOffset: number;
  offset: number;
  seq: number;
}

interface EventIndexEntry {
  checkpoints: EventCheckpoint[];
  headAnchor?: EventContentAnchor;
  identity: EventFileIdentity;
  tailAnchor?: EventContentAnchor;
}

interface EventIndexLease {
  bytesRead: number;
  entry: EventIndexEntry;
}

interface EventContentAnchor {
  digest: string;
  length: number;
  offset: number;
}

interface EventProbe {
  bytesRead: number;
  checkpoint?: EventCheckpoint;
}

interface EventSeek {
  bytesRead: number;
  expectedFirstSeq: number;
  startOffset: number;
}

class EventIndexCache {
  readonly #entries = new Map<string, EventIndexEntry>();

  async acquire(key: string, identity: EventFileIdentity, file: FileHandle): Promise<EventIndexLease> {
    const existing = this.#entries.get(key);
    if (existing !== undefined && sameEventFileIdentity(existing.identity, identity)) {
      this.#touch(key, existing);
      return { bytesRead: 0, entry: existing };
    }
    if (
      existing !== undefined
      && sameEventFileNode(existing.identity, identity)
      && identity.size > existing.identity.size
      && existing.headAnchor !== undefined
      && existing.tailAnchor !== undefined
    ) {
      let headAnchor: EventContentAnchor;
      let tailAnchor: EventContentAnchor;
      try {
        headAnchor = await readEventContentAnchor(
          file,
          existing.headAnchor.offset,
          existing.headAnchor.length,
        );
        tailAnchor = existing.tailAnchor.offset === existing.headAnchor.offset
          && existing.tailAnchor.length === existing.headAnchor.length
          ? headAnchor
          : await readEventContentAnchor(
            file,
            existing.tailAnchor.offset,
            existing.tailAnchor.length,
          );
      } catch (error) {
        if (this.#entries.get(key) === existing) this.#entries.delete(key);
        throw error;
      }
      const bytesRead = headAnchor.length + (tailAnchor === headAnchor ? 0 : tailAnchor.length);
      if (
        headAnchor.digest === existing.headAnchor.digest
        && tailAnchor.digest === existing.tailAnchor.digest
      ) {
        existing.identity = identity;
        this.#touch(key, existing);
        return { bytesRead, entry: existing };
      }
      if (this.#entries.get(key) === existing) this.#entries.delete(key);
      return { bytesRead, entry: this.#create(key, identity) };
    }
    if (existing !== undefined) this.#entries.delete(key);
    return { bytesRead: 0, entry: this.#create(key, identity) };
  }

  invalidate(key: string, expected?: EventIndexEntry): void {
    if (expected === undefined || this.#entries.get(key) === expected) this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  async retainStable(
    key: string,
    expected: EventIndexEntry,
    identity: EventFileIdentity,
    file: FileHandle,
  ): Promise<void> {
    if (this.#entries.get(key) !== expected) return;
    const anchorLength = Math.min(EVENT_INDEX_TAIL_ANCHOR_BYTES, Number(identity.size));
    const anchorOffset = Number(identity.size) - anchorLength;
    expected.headAnchor = await readEventContentAnchor(file, 0, anchorLength);
    expected.tailAnchor = anchorOffset === 0
      ? expected.headAnchor
      : await readEventContentAnchor(file, anchorOffset, anchorLength);
    expected.identity = identity;
    this.#touch(key, expected);
  }

  #create(key: string, identity: EventFileIdentity): EventIndexEntry {
    const created: EventIndexEntry = { checkpoints: [], identity };
    this.#entries.set(key, created);
    while (this.#entries.size > MAX_EVENT_INDEX_RUNS) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    return created;
  }

  #touch(key: string, entry: EventIndexEntry): void {
    this.#entries.delete(key);
    this.#entries.set(key, entry);
  }
}

class ObserverHttpError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string) {
    super(code);
    this.name = "ObserverHttpError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Create a read-only evidence server without binding a socket.
 *
 * The server never follows child symlinks and never exposes artifact paths or
 * exception messages. Callers that need a listening socket can use
 * startObserverServer instead.
 */
export function createObserverServer(options: ObserverServerOptions): Server {
  const configuredDataDir = validateDataDir(options.dataDir);
  const authHeaderDigest = createAuthHeaderDigest(options.authToken);
  const eventIndexes = new EventIndexCache();
  const server = createServer(
    {
      maxHeaderSize: 16_384,
      requireHostHeader: true,
    },
    (request, response) => {
      void handleRequest(configuredDataDir, authHeaderDigest, eventIndexes, request, response).catch((error: unknown) => {
        if (response.headersSent || response.writableEnded) {
          response.destroy();
          return;
        }
        if (error instanceof ObserverHttpError) {
          sendJson(response, error.status, { error: error.code });
          return;
        }
        sendJson(response, 500, { error: "internal_error" });
      });
    },
  );

  // Reject Expect: 100-continue without inviting a request body first.
  server.on("checkContinue", (request, response) => {
    void handleRequest(configuredDataDir, authHeaderDigest, eventIndexes, request, response).catch((error: unknown) => {
      if (response.headersSent || response.writableEnded) {
        response.destroy();
        return;
      }
      if (error instanceof ObserverHttpError) {
        sendJson(response, error.status, { error: error.code });
        return;
      }
      sendJson(response, 500, { error: "internal_error" });
    });
  });

  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.maxRequestsPerSocket = 100;
  server.on("close", () => {
    eventIndexes.clear();
    authHeaderDigest?.fill(0);
  });
  return server;
}

/** Create and bind a read-only evidence server. */
export async function startObserverServer(options: ObserverServerOptions): Promise<Server> {
  const host = validateHost(options.host ?? DEFAULT_HOST);
  const port = validatePort(options.port ?? DEFAULT_PORT);
  const server = createObserverServer(options);

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port });
  });

  return server;
}

async function handleRequest(
  configuredDataDir: string,
  authHeaderDigest: Buffer | undefined,
  eventIndexes: EventIndexCache,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  if (request.headers["content-length"] !== undefined || request.headers["transfer-encoding"] !== undefined) {
    sendJson(response, 400, { error: "request_body_not_allowed" });
    return;
  }

  const target = request.url ?? "/";
  if (Buffer.byteLength(target, "utf8") > MAX_REQUEST_TARGET_BYTES) {
    sendJson(response, 414, { error: "request_target_too_long" });
    return;
  }
  rejectTraversalTarget(target);

  let url: URL;
  try {
    url = new URL(target, "http://observer.invalid");
  } catch {
    throw new ObserverHttpError(400, "invalid_request_target");
  }

  if (url.pathname === "/") {
    ensureNoQuery(url);
    sendText(response, 200, OBSERVER_UI_HTML, "text/html; charset=utf-8");
    return;
  }

  const uiAsset = OBSERVER_UI_ASSETS[url.pathname];
  if (uiAsset !== undefined) {
    ensureNoQuery(url);
    sendUiAsset(response, uiAsset);
    return;
  }

  if (url.pathname === "/api") {
    ensureNoQuery(url);
    sendJson(response, 200, {
      service: "agent-native-universe-observer",
      version: ANU_VERSION,
      status: "read-only",
      links: {
        ui: "/",
        health: "/healthz",
        readiness: "/readyz",
        runs: "/api/runs",
      },
    });
    return;
  }

  if (url.pathname === "/healthz") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (url.pathname === "/readyz") {
    try {
      await resolveDataRoot(configuredDataDir);
      sendJson(response, 200, { status: "ready" });
    } catch {
      sendJson(response, 503, { status: "not_ready" });
    }
    return;
  }

  if (url.pathname === "/api/runs") {
    if (!authorizeEvidenceRequest(request, response, authHeaderDigest)) return;
    ensureNoQuery(url);
    const root = await resolveDataRootOr503(configuredDataDir);
    const discovery = await discoverRuns(root);
    assertCompleteRunDiscovery(discovery);
    const runs = [];
    for (const record of discovery.records) {
      let summary: Record<string, unknown> | null = null;
      try {
        summary = await readOptionalJsonArtifact(record.directory, "summary.json", root);
      } catch {
        // Keep one damaged run from making the full read-only catalogue unavailable.
      }
      runs.push(runListItem(record.manifest, summary));
    }
    sendJson(response, 200, {
      count: runs.length,
      runs,
      truncated: false,
    });
    return;
  }

  const metricsMatch = /^\/api\/runs\/([^/]+)\/metrics$/.exec(url.pathname);
  if (metricsMatch !== null) {
    if (!authorizeEvidenceRequest(request, response, authHeaderDigest)) return;
    ensureNoQuery(url);
    const runId = decodeRunId(metricsMatch[1]);
    const root = await resolveDataRootOr503(configuredDataDir);
    const record = await findRun(root, runId);
    if (record === undefined) throw new ObserverHttpError(404, "run_not_found");
    const metrics = await readMetricSeries(record.directory, root);
    sendJson(response, 200, {
      runId,
      count: metrics.length,
      metrics,
    });
    return;
  }

  const eventsMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(url.pathname);
  if (eventsMatch !== null) {
    if (!authorizeEvidenceRequest(request, response, authHeaderDigest)) return;
    const runId = decodeRunId(eventsMatch[1]);
    const { after, limit } = parseEventQuery(url);
    const root = await resolveDataRootOr503(configuredDataDir);
    const record = await findRun(root, runId);
    if (record === undefined) throw new ObserverHttpError(404, "run_not_found");
    const etag = await peekEventFileEtag(record.directory, root);
    if (etag !== undefined && matchesIfNoneMatch(request, etag)) {
      send304(response, etag);
      return;
    }
    const page = await readEventPage(record, root, eventIndexes, after, limit);
    if (etag !== undefined) response.setHeader("ETag", etag);
    sendJson(response, 200, {
      runId,
      after,
      limit,
      events: page.events,
      nextAfter: page.nextAfter,
      hasMore: page.hasMore,
    });
    return;
  }

  const headMatch = /^\/api\/runs\/([^/]+)\/head$/.exec(url.pathname);
  if (headMatch !== null) {
    if (!authorizeEvidenceRequest(request, response, authHeaderDigest)) return;
    ensureNoQuery(url);
    const runId = decodeRunId(headMatch[1]);
    const root = await resolveDataRootOr503(configuredDataDir);
    const record = await findRun(root, runId);
    if (record === undefined) throw new ObserverHttpError(404, "run_not_found");
    const etag = await peekEventFileEtag(record.directory, root);
    if (etag !== undefined && matchesIfNoneMatch(request, etag)) {
      send304(response, etag);
      return;
    }
    const head = await readRunHead(record, root);
    if (etag !== undefined) response.setHeader("ETag", etag);
    sendJson(response, 200, { runId, ...head });
    return;
  }

  const stateMatch = /^\/api\/runs\/([^/]+)\/state$/.exec(url.pathname);
  if (stateMatch !== null) {
    if (!authorizeEvidenceRequest(request, response, authHeaderDigest)) return;
    ensureNoQuery(url);
    const runId = decodeRunId(stateMatch[1]);
    const root = await resolveDataRootOr503(configuredDataDir);
    const record = await findRun(root, runId);
    if (record === undefined) throw new ObserverHttpError(404, "run_not_found");
    const etag = await peekEventFileEtag(record.directory, root);
    if (etag !== undefined && matchesIfNoneMatch(request, etag)) {
      send304(response, etag);
      return;
    }
    const projection = await projectRunState(record, root, eventIndexes);
    const body = { runId, tick: projection.tick, seq: projection.seq, state: projection.state };
    const size = Buffer.byteLength(JSON.stringify(redactEvidence(body)), "utf8");
    if (size > MAX_STATE_RESPONSE_BYTES) throw new ObserverHttpError(413, "state_too_large");
    if (etag !== undefined) response.setHeader("ETag", etag);
    sendJson(response, 200, body);
    return;
  }

  if (url.pathname === "/api/live") {
    if (!authorizeEvidenceRequest(request, response, authHeaderDigest)) return;
    ensureNoQuery(url);
    const root = await resolveDataRootOr503(configuredDataDir);
    const live = await readLiveHead(root, eventIndexes);
    sendJson(response, 200, live);
    return;
  }

  const runMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
  if (runMatch !== null) {
    if (!authorizeEvidenceRequest(request, response, authHeaderDigest)) return;
    ensureNoQuery(url);
    const runId = decodeRunId(runMatch[1]);
    const root = await resolveDataRootOr503(configuredDataDir);
    const record = await findRun(root, runId);
    if (record === undefined) throw new ObserverHttpError(404, "run_not_found");
    const summary = await readOptionalJsonArtifact(record.directory, "summary.json", root);
    const attestationResult = await readOptionalAttestationArtifact(record, root);
    sendJson(response, 200, {
      runId,
      manifest: record.manifest,
      summary,
      attestation: attestationResult.attestation,
      attestationStatus: attestationResult.status,
    });
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

function createAuthHeaderDigest(token: string | undefined): Buffer | undefined {
  if (token === undefined) return undefined;
  const tokenBytes = Buffer.byteLength(token, "utf8");
  if (
    tokenBytes < MIN_AUTH_TOKEN_BYTES
    || tokenBytes > MAX_AUTH_TOKEN_BYTES
    || !/^[A-Za-z0-9\-._~+/]+=*$/.test(token)
  ) {
    throw new TypeError(
      `Observer auth token must be ${MIN_AUTH_TOKEN_BYTES}..${MAX_AUTH_TOKEN_BYTES} bytes of token68 data`,
    );
  }
  return createHash("sha256").update(`Bearer ${token}`, "utf8").digest();
}

function authorizeEvidenceRequest(
  request: IncomingMessage,
  response: ServerResponse,
  expectedDigest: Buffer | undefined,
): boolean {
  if (expectedDigest === undefined) return true;

  const authorizationValues = request.headersDistinct.authorization;
  const candidate = authorizationValues?.length === 1 ? authorizationValues[0] ?? "" : "";
  const candidateDigest = createHash("sha256").update(candidate, "utf8").digest();
  const authorized = authorizationValues?.length === 1
    && timingSafeEqual(candidateDigest, expectedDigest);
  candidateDigest.fill(0);
  if (authorized) return true;

  response.setHeader("WWW-Authenticate", 'Bearer realm="anu-lab-observer"');
  sendJson(response, 401, { error: "unauthorized" });
  return false;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(redactEvidence(value));
  sendText(response, status, body, "application/json; charset=utf-8", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
}

function sendUiAsset(response: ServerResponse, asset: ObserverUiAsset): void {
  sendText(response, 200, asset.body, asset.contentType);
}

function sendText(
  response: ServerResponse,
  status: number,
  body: string,
  contentType: string,
  contentSecurityPolicy = [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "script-src 'self'",
    "style-src 'self'",
  ].join("; "),
): void {
  response.statusCode = status;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", Buffer.byteLength(body, "utf8"));
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", contentSecurityPolicy);
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-DNS-Prefetch-Control", "off");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.end(body);
}

function validateDataDir(dataDir: string): string {
  if (typeof dataDir !== "string" || dataDir.trim().length === 0 || dataDir.includes("\0")) {
    throw new TypeError("Observer dataDir must be a non-empty path");
  }
  return resolve(dataDir);
}

function validateHost(host: string): string {
  if (host.trim().length === 0 || host.includes("\0") || host.length > 255) {
    throw new TypeError("Observer host must be a non-empty host name or address");
  }
  return host;
}

function validatePort(port: number): number {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError("Observer port must be an integer from 0 through 65535");
  }
  return port;
}

async function resolveDataRoot(configuredDataDir: string): Promise<string> {
  const root = await realpath(configuredDataDir);
  const info = await lstat(root);
  if (!info.isDirectory()) throw new Error("not a directory");
  return root;
}

async function resolveDataRootOr503(configuredDataDir: string): Promise<string> {
  try {
    return await resolveDataRoot(configuredDataDir);
  } catch {
    throw new ObserverHttpError(503, "not_ready");
  }
}

async function discoverRuns(root: string): Promise<RunDiscovery> {
  const pending: Array<{ directory: string; depth: number; relativeDirectory: string }> = [
    { directory: root, depth: 0, relativeDirectory: "" },
  ];
  const found: RunRecord[] = [];
  let entriesSeen = 0;
  let truncated = false;

  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined) break;

    let entries;
    try {
      entries = await readdir(current.directory, { withFileTypes: true });
    } catch (error) {
      if (current.directory === root) throw error;
      truncated = true;
      continue;
    }
    entries.sort((left, right) => compareCodeUnits(left.name, right.name));

    if (entriesSeen + entries.length > MAX_SCAN_ENTRIES) {
      entries = entries.slice(0, Math.max(0, MAX_SCAN_ENTRIES - entriesSeen));
      truncated = true;
    }
    entriesSeen += entries.length;

    const manifestEntry = entries.find((entry) => entry.name === "manifest.json" && entry.isFile());
    if (manifestEntry !== undefined) {
      try {
        const manifest = await readJsonArtifact(current.directory, manifestEntry.name, root);
        const runId = readRunId(manifest);
        if (runId !== undefined) {
          found.push({
            directory: current.directory,
            relativeDirectory: current.relativeDirectory,
            manifest,
            runId,
          });
        }
      } catch {
        // A malformed or oversized manifest is not evidence and is not listed.
      }
      if (found.length > MAX_RUNS) {
        truncated = true;
        break;
      }
    }

    if (current.depth >= MAX_SCAN_DEPTH || entriesSeen >= MAX_SCAN_ENTRIES) {
      if (current.depth >= MAX_SCAN_DEPTH && entries.some((entry) => entry.isDirectory())) truncated = true;
      if (entriesSeen >= MAX_SCAN_ENTRIES && entries.some((entry) => entry.isDirectory())) {
        truncated = true;
      }
      continue;
    }

    for (const entry of entries) {
      if (
        !entry.isDirectory()
        || entry.isSymbolicLink()
        || entry.name.startsWith(".")
        || entry.name === "populations"
        || LIVE_RESERVED_DIRECTORY_NAMES.has(entry.name)
        || (manifestEntry !== undefined && entry.name === "checkpoints")
      ) continue;
      const child = join(current.directory, entry.name);
      let canonicalChild: string;
      try {
        canonicalChild = await realpath(child);
      } catch {
        truncated = true;
        continue;
      }
      if (!isWithin(root, canonicalChild)) {
        truncated = true;
        continue;
      }
      pending.push({
        directory: canonicalChild,
        depth: current.depth + 1,
        relativeDirectory:
          current.relativeDirectory.length === 0
            ? entry.name
            : `${current.relativeDirectory}/${entry.name}`,
      });
    }
  }

  found.sort((left, right) => {
    const byRunId = compareCodeUnits(left.runId, right.runId);
    return byRunId !== 0
      ? byRunId
      : compareCodeUnits(left.relativeDirectory, right.relativeDirectory);
  });

  const occurrences = new Map<string, number>();
  for (const record of found) {
    occurrences.set(record.runId, (occurrences.get(record.runId) ?? 0) + 1);
  }
  const unique = found.filter((record) => occurrences.get(record.runId) === 1);
  return { ambiguous: unique.length !== found.length, records: unique, truncated };
}

async function findRun(root: string, runId: string): Promise<RunRecord | undefined> {
  const discovery = await discoverRuns(root);
  assertCompleteRunDiscovery(discovery);
  return discovery.records.find((record) => record.runId === runId);
}

function assertCompleteRunDiscovery(discovery: RunDiscovery): void {
  if (discovery.truncated) {
    throw new ObserverHttpError(503, "run_discovery_incomplete");
  }
  if (discovery.ambiguous) {
    throw new ObserverHttpError(409, "ambiguous_run_evidence");
  }
}

function readRunId(manifest: Record<string, unknown>): string | undefined {
  const runId = manifest.runId;
  return typeof runId === "string" && isSafeRunId(runId) ? runId : undefined;
}

function runListItem(
  manifest: Record<string, unknown>,
  summary: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    runId: manifest.runId,
    experimentId: scalarOrNull(manifest.experimentId),
    universeId: scalarOrNull(manifest.universeId),
    schemaVersion: scalarOrNull(manifest.schemaVersion),
    completed: summary !== null,
    ticks: summary === null ? null : scalarOrNull(summary.ticks),
    events: summary === null ? null : scalarOrNull(summary.events),
    summaryAvailable: summary !== null,
  };
}

function scalarOrNull(value: unknown): string | number | boolean | null {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;
}

async function readJsonArtifact(
  directory: string,
  fileName: string,
  root: string,
): Promise<Record<string, unknown>> {
  const text = await readBoundedFile(directory, fileName, root, MAX_JSON_ARTIFACT_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ObserverHttpError(422, "invalid_artifact");
  }
  if (!isJsonObject(parsed)) throw new ObserverHttpError(422, "invalid_artifact");
  return parsed;
}

async function readOptionalJsonArtifact(
  directory: string,
  fileName: string,
  root: string,
): Promise<Record<string, unknown> | null> {
  try {
    return await readJsonArtifact(directory, fileName, root);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function readMetricSeries(
  directory: string,
  root: string,
): Promise<Record<string, unknown>[]> {
  let text: string;
  try {
    text = await readBoundedFile(directory, "metrics.jsonl", root, MAX_OBSERVER_METRICS_BYTES);
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  if (text.length === 0) return [];
  if (!text.endsWith("\n") || text.includes("\r")) {
    throw new ObserverHttpError(422, "invalid_metrics");
  }

  const lines = text.slice(0, -1).split("\n");
  const metrics: Record<string, unknown>[] = [];
  let priorTick = -1;
  for (const line of lines) {
    if (line.length === 0 || Buffer.byteLength(line, "utf8") > MAX_JSON_ARTIFACT_BYTES) {
      throw new ObserverHttpError(422, "invalid_metrics");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new ObserverHttpError(422, "invalid_metrics");
    }
    if (
      !isJsonObject(parsed)
      || !Number.isSafeInteger(parsed.tick)
      || (parsed.tick as number) < 0
      || (parsed.tick as number) <= priorTick
      || canonicalJson(parsed as never) !== line
    ) {
      throw new ObserverHttpError(422, "invalid_metrics");
    }
    priorTick = parsed.tick as number;
    metrics.push(parsed);
  }
  return metrics;
}

async function readOptionalAttestationArtifact(
  record: RunRecord,
  root: string,
): Promise<OptionalAttestationArtifact> {
  let value: Record<string, unknown> | null;
  try {
    value = await readOptionalJsonArtifact(
      record.directory,
      "attestations/final.json",
      root,
    );
  } catch (error) {
    if (error instanceof ObserverHttpError && (error.status === 413 || error.status === 422)) {
      return { attestation: null, status: "invalid" };
    }
    throw error;
  }
  if (value === null) return { attestation: null, status: "missing" };
  try {
    validateRunEvidenceAttestation(value);
  } catch {
    return { attestation: null, status: "invalid" };
  }
  const expectedSubject = {
    experimentId: record.manifest.experimentId,
    runId: record.runId,
    universeId: record.manifest.universeId,
    engineVersion: record.manifest.engineVersion,
    policyId: record.manifest.policyId,
    taskGeneratorId: record.manifest.taskGeneratorId,
  };
  if (Object.entries(expectedSubject).some(
    ([key, expected]) => typeof expected !== "string" || value.subject[key as keyof typeof value.subject] !== expected,
  )) {
    return { attestation: null, status: "invalid" };
  }
  return { attestation: value, status: "self_consistent" };
}

async function readBoundedFile(
  directory: string,
  fileName: string,
  root: string,
  maxBytes: number,
): Promise<string> {
  const file = await openSafeArtifact(directory, fileName, root);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new ObserverHttpError(422, "invalid_artifact");
    if (info.size > maxBytes) throw new ObserverHttpError(413, "artifact_too_large");

    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset <= maxBytes) {
      const result = await file.read(buffer, offset, maxBytes + 1 - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > maxBytes) throw new ObserverHttpError(413, "artifact_too_large");
    const content = buffer.subarray(0, offset);
    if (!isUtf8(content)) throw new ObserverHttpError(422, "invalid_artifact");
    return content.toString("utf8");
  } finally {
    await file.close();
  }
}

async function openSafeArtifact(directory: string, fileName: string, root: string) {
  const candidate = resolve(directory, fileName);
  if (!isWithin(root, candidate) || !isWithin(directory, candidate)) {
    throw new ObserverHttpError(422, "invalid_artifact");
  }
  try {
    return await openRegularFileNoFollow(candidate, constants.O_RDONLY);
  } catch (error) {
    if (isMissingFile(error)) throw error;
    throw new ObserverHttpError(422, "invalid_artifact");
  }
}

async function readEventPage(
  record: RunRecord,
  root: string,
  eventIndexes: EventIndexCache,
  after: number,
  limit: number,
): Promise<{ events: Record<string, unknown>[]; nextAfter: number; hasMore: boolean }> {
  const indexKey = join(record.directory, "events.jsonl");
  let file;
  try {
    file = await openSafeArtifact(record.directory, "events.jsonl", root);
  } catch (error) {
    if (isMissingFile(error)) {
      eventIndexes.invalidate(indexKey);
      return { events: [], nextAfter: after, hasMore: false };
    }
    throw error;
  }

  let index: EventIndexEntry | undefined;
  let initialIdentity: EventFileIdentity | undefined;
  const selected: Record<string, unknown>[] = [];
  let selectedBytes = 0;
  let hasMore = false;
  let scannedBytes: number;
  let pending: Buffer = Buffer.alloc(0);
  let pendingOffset: number;
  let expectedSeq: number;

  const consumeLine = (rawLine: Buffer, offset: number, endOffset: number): boolean => {
    if (!isUtf8(rawLine) || rawLine.at(-1) === 0x0d) {
      throw new ObserverHttpError(422, "invalid_event_log");
    }
    const line = rawLine.toString("utf8");
    if (line.length === 0) throw new ObserverHttpError(422, "invalid_event_log");
    if (Buffer.byteLength(line, "utf8") > MAX_LAB_EVENT_BYTES) {
      throw new ObserverHttpError(413, "event_line_too_large");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new ObserverHttpError(422, "invalid_event_log");
    }
    if (
      !isJsonObject(parsed)
      || !Number.isSafeInteger(parsed.seq)
      || (parsed.seq as number) !== expectedSeq
    ) {
      throw new ObserverHttpError(422, "invalid_event_log");
    }
    const seq = parsed.seq as number;
    expectedSeq = seq + 1;
    if (index === undefined) throw new ObserverHttpError(500, "internal_error");
    rememberEventCheckpoint(index, { endOffset, offset, seq });
    if (seq <= after) return false;

    if (selected.length >= limit) {
      hasMore = true;
      return true;
    }
    const redacted = redactEvidence(parsed) as Record<string, unknown>;
    const eventBytes = Buffer.byteLength(JSON.stringify(redacted), "utf8");
    if (selectedBytes + eventBytes > MAX_EVENT_RESPONSE_BYTES) {
      hasMore = true;
      return true;
    }
    selected.push(redacted);
    selectedBytes += eventBytes;
    return false;
  };

  try {
    initialIdentity = await eventFileIdentity(file);
    const fileSize = Number(initialIdentity.size);
    const terminatorBytes = await validateEventLogTerminator(file, fileSize);
    const lease = await eventIndexes.acquire(indexKey, initialIdentity, file);
    index = lease.entry;
    const seek = await findEventScanStart(file, fileSize, after, index);
    scannedBytes = terminatorBytes + lease.bytesRead + seek.bytesRead;
    if (scannedBytes > MAX_EVENT_SCAN_BYTES) {
      throw new ObserverHttpError(413, "event_scan_limit_exceeded");
    }
    pendingOffset = seek.startOffset;
    expectedSeq = seek.expectedFirstSeq;

    let readOffset = seek.startOffset;
    while (readOffset < fileSize && !hasMore) {
      const chunk = await readFileWindow(
        file,
        readOffset,
        Math.min(EVENT_PROBE_CHUNK_BYTES, fileSize - readOffset),
      );
      if (chunk.length === 0) break;
      readOffset += chunk.length;
      scannedBytes += chunk.length;
      if (scannedBytes > MAX_EVENT_SCAN_BYTES) {
        throw new ObserverHttpError(413, "event_scan_limit_exceeded");
      }
      pending = Buffer.concat([pending, chunk], pending.length + chunk.length);

      let newline = pending.indexOf(0x0a);
      while (newline >= 0) {
        const line = pending.subarray(0, newline);
        const lineOffset = pendingOffset;
        const lineEndOffset = lineOffset + newline + 1;
        pending = pending.subarray(newline + 1);
        pendingOffset = lineEndOffset;
        if (consumeLine(line, lineOffset, lineEndOffset)) break;
        newline = pending.indexOf(0x0a);
      }
      if (hasMore) break;
      if (pending.length > MAX_LAB_EVENT_BYTES + 1) {
        throw new ObserverHttpError(413, "event_line_too_large");
      }
    }
    if (!hasMore && pending.length > 0) throw new ObserverHttpError(422, "invalid_event_log");

    const finalIdentity = await eventFileIdentity(file);
    if (!sameEventFileIdentity(initialIdentity, finalIdentity)) {
      eventIndexes.invalidate(indexKey, index);
    } else {
      await eventIndexes.retainStable(indexKey, index, finalIdentity, file);
    }
  } catch (error) {
    eventIndexes.invalidate(indexKey, index);
    throw error;
  } finally {
    await file.close();
  }

  return {
    events: selected,
    nextAfter: selected.length === 0 ? after : (selected.at(-1)?.seq as number),
    hasMore,
  };
}

async function eventFileIdentity(file: FileHandle): Promise<EventFileIdentity> {
  const info = await file.stat({ bigint: true });
  if (!info.isFile()) throw new ObserverHttpError(422, "invalid_event_log");
  if (info.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ObserverHttpError(413, "event_scan_limit_exceeded");
  }
  return {
    ctimeNs: info.ctimeNs,
    device: info.dev,
    inode: info.ino,
    mtimeNs: info.mtimeNs,
    size: info.size,
  };
}

async function validateEventLogTerminator(file: FileHandle, fileSize: number): Promise<number> {
  if (fileSize === 0) return 0;
  const terminator = await readFileWindow(file, fileSize - 1, 1);
  if (terminator.length !== 1 || terminator[0] !== 0x0a) {
    throw new ObserverHttpError(422, "invalid_event_log");
  }
  return 1;
}

async function readEventContentAnchor(
  file: FileHandle,
  offset: number,
  length: number,
): Promise<EventContentAnchor> {
  const content = await readFileWindow(file, offset, length);
  if (content.length !== length) throw new ObserverHttpError(422, "invalid_event_log");
  return {
    digest: createHash("sha256").update(content).digest("hex"),
    length,
    offset,
  };
}

function sameEventFileIdentity(left: EventFileIdentity, right: EventFileIdentity): boolean {
  return left.ctimeNs === right.ctimeNs
    && left.device === right.device
    && left.inode === right.inode
    && left.mtimeNs === right.mtimeNs
    && left.size === right.size;
}

function sameEventFileNode(left: EventFileIdentity, right: EventFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function rememberEventCheckpoint(index: EventIndexEntry, checkpoint: EventCheckpoint): void {
  let low = 0;
  let high = index.checkpoints.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const existing = index.checkpoints[middle];
    if (existing === undefined || existing.offset < checkpoint.offset) low = middle + 1;
    else high = middle;
  }

  const sameOffset = index.checkpoints[low];
  if (sameOffset?.offset === checkpoint.offset) {
    if (sameOffset.endOffset !== checkpoint.endOffset || sameOffset.seq !== checkpoint.seq) {
      throw new ObserverHttpError(422, "invalid_event_log");
    }
    return;
  }

  const previous = index.checkpoints[low - 1];
  const next = index.checkpoints[low];
  if (
    checkpoint.offset < 0
    || checkpoint.endOffset <= checkpoint.offset
    || (previous !== undefined && (previous.endOffset > checkpoint.offset || previous.seq >= checkpoint.seq))
    || (next !== undefined && (checkpoint.endOffset > next.offset || checkpoint.seq >= next.seq))
  ) {
    throw new ObserverHttpError(422, "invalid_event_log");
  }

  index.checkpoints.splice(low, 0, checkpoint);
  if (index.checkpoints.length <= MAX_EVENT_INDEX_ENTRIES) return;

  const checkpoints = index.checkpoints;
  const compacted: EventCheckpoint[] = [];
  for (let position = 0; position < MAX_EVENT_INDEX_ENTRIES; position += 1) {
    const source = Math.floor((position * (checkpoints.length - 1)) / (MAX_EVENT_INDEX_ENTRIES - 1));
    const retained = checkpoints[source];
    if (retained !== undefined) compacted.push(retained);
  }
  index.checkpoints = compacted;
}

async function findEventScanStart(
  file: FileHandle,
  fileSize: number,
  after: number,
  index: EventIndexEntry,
): Promise<EventSeek> {
  if (after === 0 || fileSize === 0) {
    return { bytesRead: 0, expectedFirstSeq: 1, startOffset: 0 };
  }

  let floor: EventCheckpoint | undefined;
  let ceiling: EventCheckpoint | undefined;
  for (const checkpoint of index.checkpoints) {
    if (checkpoint.seq <= after) floor = checkpoint;
    else {
      ceiling = checkpoint;
      break;
    }
  }

  let lowOffset = floor?.endOffset ?? 0;
  let highOffset = ceiling?.offset ?? fileSize;
  if (floor === undefined && highOffset <= EVENT_INDEX_SEEK_THRESHOLD_BYTES) {
    return { bytesRead: 0, expectedFirstSeq: 1, startOffset: 0 };
  }

  let bytesRead = 0;
  for (
    let probeCount = 0;
    probeCount < MAX_EVENT_INDEX_PROBES
      && highOffset - lowOffset > EVENT_INDEX_SEEK_THRESHOLD_BYTES;
    probeCount += 1
  ) {
    const targetOffset = lowOffset + Math.floor((highOffset - lowOffset) / 2);
    const probe = await probeEventCheckpoint(file, targetOffset, fileSize);
    bytesRead += probe.bytesRead;
    if (bytesRead > MAX_EVENT_SCAN_BYTES) {
      throw new ObserverHttpError(413, "event_scan_limit_exceeded");
    }

    const checkpoint = probe.checkpoint;
    if (checkpoint === undefined) {
      highOffset = targetOffset;
      continue;
    }
    rememberEventCheckpoint(index, checkpoint);

    if (checkpoint.seq <= after) {
      if (floor === undefined || checkpoint.seq > floor.seq) floor = checkpoint;
      lowOffset = Math.max(lowOffset + 1, checkpoint.endOffset);
    } else {
      ceiling = checkpoint;
      highOffset = checkpoint.offset <= lowOffset ? lowOffset : checkpoint.offset;
    }
  }

  return {
    bytesRead,
    expectedFirstSeq: floor?.seq ?? 1,
    startOffset: floor?.offset ?? 0,
  };
}

async function probeEventCheckpoint(
  file: FileHandle,
  targetOffset: number,
  fileSize: number,
): Promise<EventProbe> {
  if (fileSize === 0 || targetOffset >= fileSize) return { bytesRead: 0 };

  let bytesRead = 0;
  let lineStart = 0;
  let cursor = targetOffset;
  let searchedBackward = 0;
  while (cursor > 0) {
    const remainingAllowance = MAX_LAB_EVENT_BYTES + 2 - searchedBackward;
    if (remainingAllowance <= 0) throw new ObserverHttpError(413, "event_line_too_large");
    const length = Math.min(EVENT_PROBE_CHUNK_BYTES, cursor, remainingAllowance);
    const position = cursor - length;
    const chunk = await readFileWindow(file, position, length);
    bytesRead += chunk.length;
    const newline = chunk.lastIndexOf(0x0a);
    if (newline >= 0) {
      lineStart = position + newline + 1;
      break;
    }
    searchedBackward += chunk.length;
    cursor = position;
    if (chunk.length < length) throw new ObserverHttpError(422, "invalid_event_log");
  }

  let nextLineStart = lineStart;
  while (nextLineStart < fileSize) {
    const length = Math.min(MAX_LAB_EVENT_BYTES + 3, fileSize - nextLineStart);
    const chunk = await readFileWindow(file, nextLineStart, length);
    bytesRead += chunk.length;
    if (bytesRead > MAX_EVENT_SCAN_BYTES) {
      throw new ObserverHttpError(413, "event_scan_limit_exceeded");
    }

    const newline = chunk.indexOf(0x0a);
    const rawLength = newline >= 0 ? newline : chunk.length;
    if (newline < 0 && nextLineStart + chunk.length < fileSize) {
      throw new ObserverHttpError(413, "event_line_too_large");
    }
    const raw = chunk.subarray(0, rawLength);
    if (!isUtf8(raw) || raw.at(-1) === 0x0d) {
      throw new ObserverHttpError(422, "invalid_event_log");
    }
    const line = raw.toString("utf8");
    if (Buffer.byteLength(line, "utf8") > MAX_LAB_EVENT_BYTES) {
      throw new ObserverHttpError(413, "event_line_too_large");
    }
    const endOffset = nextLineStart + rawLength + (newline >= 0 ? 1 : 0);
    if (line.length === 0) throw new ObserverHttpError(422, "invalid_event_log");

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new ObserverHttpError(422, "invalid_event_log");
    }
    if (!isJsonObject(parsed) || !Number.isSafeInteger(parsed.seq) || (parsed.seq as number) <= 0) {
      throw new ObserverHttpError(422, "invalid_event_log");
    }
    return {
      bytesRead,
      checkpoint: {
        endOffset,
        offset: nextLineStart,
        seq: parsed.seq as number,
      },
    };
  }
  return { bytesRead };
}

async function readFileWindow(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const result = await file.read(buffer, offset, length - offset, position + offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  return buffer.subarray(0, offset);
}

/** Deterministic ETag over an event log's identity; never over its content. */
function eventFileEtag(identity: EventFileIdentity): string {
  const digest = hashValue({
    domain: "agent-native-universe/lab/observer-etag/v1",
    device: identity.device.toString(),
    inode: identity.inode.toString(),
    size: identity.size.toString(),
    mtimeNs: identity.mtimeNs.toString(),
    ctimeNs: identity.ctimeNs.toString(),
  });
  return `"${digest}"`;
}

/** Stat-only identity peek so a matching If-None-Match can short-circuit before any scan. */
async function peekEventFileEtag(directory: string, root: string): Promise<string | undefined> {
  let file;
  try {
    file = await openSafeArtifact(directory, "events.jsonl", root);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
  try {
    return eventFileEtag(await eventFileIdentity(file));
  } finally {
    await file.close();
  }
}

function matchesIfNoneMatch(request: IncomingMessage, etag: string): boolean {
  const values = request.headersDistinct["if-none-match"];
  if (values === undefined) return false;
  for (const value of values) {
    for (const candidate of value.split(",")) {
      const trimmed = candidate.trim();
      if (trimmed === "*" || trimmed === etag) return true;
    }
  }
  return false;
}

function send304(response: ServerResponse, etag: string): void {
  response.statusCode = 304;
  response.setHeader("ETag", etag);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.end();
}

/** Read just the final JSONL line without scanning the rest of the file. */
async function readLastEventRecord(
  file: FileHandle,
  fileSize: number,
): Promise<{ seq: number; tick: number } | null> {
  if (fileSize === 0) return null;
  const terminator = await readFileWindow(file, fileSize - 1, 1);
  if (terminator.length !== 1 || terminator[0] !== 0x0a) {
    throw new ObserverHttpError(422, "invalid_event_log");
  }
  const windowLength = Math.min(fileSize, MAX_LAB_EVENT_BYTES + 2);
  const windowStart = fileSize - windowLength;
  const chunk = await readFileWindow(file, windowStart, windowLength);
  if (chunk.length !== windowLength) throw new ObserverHttpError(422, "invalid_event_log");
  const finalNewline = windowLength - 1;
  const priorNewline = chunk.lastIndexOf(0x0a, finalNewline - 1);
  if (priorNewline < 0 && windowStart > 0) {
    throw new ObserverHttpError(413, "event_line_too_large");
  }
  const lineStart = priorNewline >= 0 ? priorNewline + 1 : 0;
  const rawLine = chunk.subarray(lineStart, finalNewline);
  if (rawLine.length === 0 || !isUtf8(rawLine) || rawLine.at(-1) === 0x0d) {
    throw new ObserverHttpError(422, "invalid_event_log");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine.toString("utf8")) as unknown;
  } catch {
    throw new ObserverHttpError(422, "invalid_event_log");
  }
  if (
    !isJsonObject(parsed)
    || !Number.isSafeInteger(parsed.seq) || (parsed.seq as number) <= 0
    || !Number.isSafeInteger(parsed.tick) || (parsed.tick as number) < 0
  ) {
    throw new ObserverHttpError(422, "invalid_event_log");
  }
  return { seq: parsed.seq as number, tick: parsed.tick as number };
}

/** Latest checkpoint tick from filenames alone; never opens a checkpoint file. */
async function findLatestCheckpointTick(directory: string, root: string): Promise<number | null> {
  const candidate = resolve(directory, "checkpoints");
  if (!isWithin(directory, candidate)) return null;
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  if (!isWithin(root, canonical) || !isWithin(directory, canonical)) return null;
  let entries;
  try {
    entries = await readdir(canonical, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  let latest: number | null = null;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const match = /^(0|[1-9][0-9]*)\.json$/.exec(entry.name);
    if (match === null) continue;
    const tick = Number(match[1]);
    if (Number.isSafeInteger(tick) && (latest === null || tick > latest)) latest = tick;
  }
  return latest;
}

interface RunHead {
  lastSeq: number | null;
  lastTick: number | null;
  eventsBytes: number;
  latestCheckpointTick: number | null;
  completed: boolean;
}

async function readRunHead(record: RunRecord, root: string): Promise<RunHead> {
  const latestCheckpointTick = await findLatestCheckpointTick(record.directory, root);
  const completed = (await readOptionalJsonArtifact(record.directory, "summary.json", root)) !== null;

  let file;
  try {
    file = await openSafeArtifact(record.directory, "events.jsonl", root);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    return { lastSeq: null, lastTick: null, eventsBytes: 0, latestCheckpointTick, completed };
  }
  try {
    const identity = await eventFileIdentity(file);
    const eventsBytes = Number(identity.size);
    const last = await readLastEventRecord(file, eventsBytes);
    return {
      lastSeq: last === null ? null : last.seq,
      lastTick: last === null ? null : last.tick,
      eventsBytes,
      latestCheckpointTick,
      completed,
    };
  } finally {
    await file.close();
  }
}

/**
 * Cast a discovered manifest into the typed RunManifest the reducer needs.
 *
 * Independent of EvidenceStore/assertLabManifestImplementation on purpose:
 * the Observer is read-only and must keep serving mode:"live" heads even
 * before an engine registers support for them (the live surface arrives in
 * L4; the live engine itself lands in L3).
 */
function parseRunManifestForProjection(raw: Record<string, unknown>): RunManifest {
  if (
    raw.schemaVersion !== LAB_SCHEMA_VERSION
    || typeof raw.experimentId !== "string"
    || typeof raw.engineVersion !== "string"
    || (raw.mode !== "logical" && raw.mode !== "cognitive" && raw.mode !== "live")
    || typeof raw.policyId !== "string"
    || typeof raw.taskGeneratorId !== "string"
    || typeof raw.runId !== "string"
    || typeof raw.universeId !== "string"
    || typeof raw.seed !== "string"
    || typeof raw.configHash !== "string"
    || (raw.cognitionId !== undefined && typeof raw.cognitionId !== "string")
  ) {
    throw new ObserverHttpError(422, "invalid_artifact");
  }
  const mode: LabRunMode = raw.mode;
  return {
    schemaVersion: raw.schemaVersion,
    experimentId: raw.experimentId,
    engineVersion: raw.engineVersion,
    mode,
    policyId: raw.policyId,
    taskGeneratorId: raw.taskGeneratorId,
    ...(raw.cognitionId === undefined ? {} : { cognitionId: raw.cognitionId }),
    runId: raw.runId,
    universeId: raw.universeId,
    seed: raw.seed,
    configHash: raw.configHash,
  };
}

/**
 * Forward-scan events strictly after `after`, calling `onEvent` for each one
 * in order. Shares the paginated /events reader's seek index and safety
 * bounds, but applies no response-size cap: callers fold events into their
 * own bounded accumulator (a WorldState projection, a health tally).
 */
async function scanEventsAfter(
  record: RunRecord,
  root: string,
  eventIndexes: EventIndexCache,
  after: number,
  onEvent: (parsed: Record<string, unknown>, seq: number, tick: number) => void,
): Promise<{ lastSeq: number; lastTick: number }> {
  const indexKey = join(record.directory, "events.jsonl");
  let file;
  try {
    file = await openSafeArtifact(record.directory, "events.jsonl", root);
  } catch (error) {
    if (isMissingFile(error)) {
      eventIndexes.invalidate(indexKey);
      return { lastSeq: after, lastTick: 0 };
    }
    throw error;
  }

  let index: EventIndexEntry | undefined;
  let initialIdentity: EventFileIdentity | undefined;
  let scannedBytes: number;
  let lastSeq = after;
  let lastTick = 0;
  let pending: Buffer = Buffer.alloc(0);
  let pendingOffset: number;
  let expectedSeq: number;

  const consumeLine = (rawLine: Buffer, offset: number, endOffset: number): void => {
    if (!isUtf8(rawLine) || rawLine.at(-1) === 0x0d) {
      throw new ObserverHttpError(422, "invalid_event_log");
    }
    const line = rawLine.toString("utf8");
    if (line.length === 0) throw new ObserverHttpError(422, "invalid_event_log");
    if (Buffer.byteLength(line, "utf8") > MAX_LAB_EVENT_BYTES) {
      throw new ObserverHttpError(413, "event_line_too_large");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new ObserverHttpError(422, "invalid_event_log");
    }
    if (
      !isJsonObject(parsed)
      || !Number.isSafeInteger(parsed.seq)
      || (parsed.seq as number) !== expectedSeq
      || !Number.isSafeInteger(parsed.tick)
      || (parsed.tick as number) < 0
    ) {
      throw new ObserverHttpError(422, "invalid_event_log");
    }
    const seq = parsed.seq as number;
    const tick = parsed.tick as number;
    expectedSeq = seq + 1;
    if (index === undefined) throw new ObserverHttpError(500, "internal_error");
    rememberEventCheckpoint(index, { endOffset, offset, seq });
    if (seq <= after) return;
    onEvent(parsed, seq, tick);
    lastSeq = seq;
    lastTick = tick;
  };

  try {
    initialIdentity = await eventFileIdentity(file);
    const fileSize = Number(initialIdentity.size);
    const terminatorBytes = await validateEventLogTerminator(file, fileSize);
    const lease = await eventIndexes.acquire(indexKey, initialIdentity, file);
    index = lease.entry;
    const seek = await findEventScanStart(file, fileSize, after, index);
    scannedBytes = terminatorBytes + lease.bytesRead + seek.bytesRead;
    if (scannedBytes > MAX_EVENT_SCAN_BYTES) {
      throw new ObserverHttpError(413, "event_scan_limit_exceeded");
    }
    pendingOffset = seek.startOffset;
    expectedSeq = seek.expectedFirstSeq;

    let readOffset = seek.startOffset;
    while (readOffset < fileSize) {
      const chunk = await readFileWindow(
        file,
        readOffset,
        Math.min(EVENT_PROBE_CHUNK_BYTES, fileSize - readOffset),
      );
      if (chunk.length === 0) break;
      readOffset += chunk.length;
      scannedBytes += chunk.length;
      if (scannedBytes > MAX_EVENT_SCAN_BYTES) {
        throw new ObserverHttpError(413, "event_scan_limit_exceeded");
      }
      pending = Buffer.concat([pending, chunk], pending.length + chunk.length);

      let newline = pending.indexOf(0x0a);
      while (newline >= 0) {
        const line = pending.subarray(0, newline);
        const lineOffset = pendingOffset;
        const lineEndOffset = lineOffset + newline + 1;
        pending = pending.subarray(newline + 1);
        pendingOffset = lineEndOffset;
        consumeLine(line, lineOffset, lineEndOffset);
        newline = pending.indexOf(0x0a);
      }
      if (pending.length > MAX_LAB_EVENT_BYTES + 1) {
        throw new ObserverHttpError(413, "event_line_too_large");
      }
    }
    if (pending.length > 0) throw new ObserverHttpError(422, "invalid_event_log");

    const finalIdentity = await eventFileIdentity(file);
    if (!sameEventFileIdentity(initialIdentity, finalIdentity)) {
      eventIndexes.invalidate(indexKey, index);
    } else {
      await eventIndexes.retainStable(indexKey, index, finalIdentity, file);
    }
  } catch (error) {
    eventIndexes.invalidate(indexKey, index);
    throw error;
  } finally {
    await file.close();
  }

  return { lastSeq, lastTick };
}

/** Project a run's WorldState from its latest checkpoint (or genesis) plus the event tail. */
async function projectRunState(
  record: RunRecord,
  root: string,
  eventIndexes: EventIndexCache,
): Promise<{ tick: number; seq: number; state: WorldState }> {
  const manifest = parseRunManifestForProjection(record.manifest);
  const latestCheckpointTick = await findLatestCheckpointTick(record.directory, root);

  let state: WorldState;
  let checkpointSeq: number;
  if (latestCheckpointTick === null) {
    state = initialWorldState(manifest);
    checkpointSeq = 0;
  } else {
    const checkpointText = await readBoundedFile(
      record.directory,
      `checkpoints/${latestCheckpointTick}.json`,
      root,
      MAX_STATE_CHECKPOINT_BYTES,
    );
    let parsedCheckpoint: unknown;
    try {
      parsedCheckpoint = JSON.parse(checkpointText) as unknown;
    } catch {
      throw new ObserverHttpError(422, "invalid_artifact");
    }
    if (
      !isJsonObject(parsedCheckpoint)
      || parsedCheckpoint.schemaVersion !== LAB_SCHEMA_VERSION
      || parsedCheckpoint.runId !== manifest.runId
      || parsedCheckpoint.universeId !== manifest.universeId
      || !Number.isSafeInteger(parsedCheckpoint.tick)
      || !Number.isSafeInteger(parsedCheckpoint.seq)
      || !isJsonObject(parsedCheckpoint.state)
    ) {
      throw new ObserverHttpError(422, "invalid_artifact");
    }
    state = parsedCheckpoint.state as unknown as WorldState;
    checkpointSeq = parsedCheckpoint.seq as number;
  }

  try {
    const tail = await scanEventsAfter(record, root, eventIndexes, checkpointSeq, (parsed) => {
      validateLabEvent(parsed);
      applyWorldEventMutable(state, parsed);
    });
    return {
      tick: state.tick,
      seq: tail.lastSeq > checkpointSeq ? tail.lastSeq : checkpointSeq,
      state,
    };
  } catch (error) {
    if (error instanceof ObserverHttpError) throw error;
    throw new ObserverHttpError(422, "invalid_event_log");
  }
}

/** Resolve one reserved live-universe subdirectory (chain, anchors, …), never following a symlink. */
async function resolveLiveSubdirectory(universeRoot: string, root: string, name: string): Promise<string | null> {
  const candidate = resolve(universeRoot, name);
  if (!isWithin(universeRoot, candidate)) return null;
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  if (!isWithin(root, canonical) || !isWithin(universeRoot, canonical)) return null;
  return canonical;
}

interface LiveChainEntry {
  epoch: number;
  runId: string;
  commitment: string;
  engineVersion: string;
  anchoredAt: string | number | boolean | null;
}

/**
 * Read the live universe's epoch index. `chain/` and `anchors/` are written
 * only by phase L3/L5; both may be entirely absent today, in which case this
 * returns an empty chain rather than failing the live head.
 */
async function readChainEntries(universeRoot: string, root: string): Promise<LiveChainEntry[]> {
  const chainDir = await resolveLiveSubdirectory(universeRoot, root, "chain");
  if (chainDir === null) return [];
  let entries;
  try {
    entries = await readdir(chainDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const numbered: Array<{ epoch: number; name: string }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const match = /^(0|[1-9][0-9]*)\.json$/.exec(entry.name);
    if (match === null) continue;
    const epoch = Number(match[1]);
    if (Number.isSafeInteger(epoch)) numbered.push({ epoch, name: entry.name });
  }
  numbered.sort((left, right) => left.epoch - right.epoch);

  const anchorsDir = await resolveLiveSubdirectory(universeRoot, root, "anchors");
  const chain: LiveChainEntry[] = [];
  for (const item of numbered) {
    let parsed: Record<string, unknown>;
    try {
      parsed = await readJsonArtifact(chainDir, item.name, root);
    } catch {
      continue; // A damaged chain entry does not take down the whole live head.
    }
    if (
      !Number.isSafeInteger(parsed.epoch) || (parsed.epoch as number) !== item.epoch
      || typeof parsed.runId !== "string"
      || typeof parsed.commitment !== "string"
      || typeof parsed.engineVersion !== "string"
    ) continue;

    let anchoredAt: string | number | boolean | null = null;
    if (anchorsDir !== null) {
      try {
        const anchor = await readJsonArtifact(anchorsDir, item.name, root);
        const value = anchor.anchoredAt;
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          anchoredAt = value;
        }
      } catch {
        // No recorded anchor yet for this epoch; anchoredAt stays null.
      }
    }
    chain.push({
      epoch: parsed.epoch as number,
      runId: parsed.runId,
      commitment: parsed.commitment,
      engineVersion: parsed.engineVersion,
      anchoredAt,
    });
  }
  return chain;
}

interface LiveCognitionHealth {
  window: number;
  consulted: number;
  unavailable: number;
  starved: number;
}

/** Tally cognition.recorded providers over the trailing LIVE_COGNITION_HEALTH_WINDOW_TICKS ticks. */
async function computeCognitionHealth(
  record: RunRecord,
  root: string,
  eventIndexes: EventIndexCache,
  headTick: number,
): Promise<LiveCognitionHealth> {
  let consulted = 0;
  let unavailable = 0;
  let starved = 0;
  const floorTick = Math.max(0, headTick - LIVE_COGNITION_HEALTH_WINDOW_TICKS + 1);
  await scanEventsAfter(record, root, eventIndexes, 0, (parsed, _seq, tick) => {
    if (parsed.type !== "cognition.recorded" || tick < floorTick) return;
    const data = parsed.data;
    const provider = isJsonObject(data) ? data.provider : undefined;
    if (provider === "unavailable") unavailable += 1;
    else if (provider === "starved") starved += 1;
    else consulted += 1;
  });
  return { window: LIVE_COGNITION_HEALTH_WINDOW_TICKS, consulted, unavailable, starved };
}

/**
 * Universe head for the single live universe (`genesis-live`/`U0001`).
 *
 * Never throws for missing evidence: an unstarted universe, a mid-boundary
 * transition, or an unreadable head run all degrade to null/zeroed fields
 * instead of failing the route, so a dashboard can always render something.
 */
async function readLiveHead(root: string, eventIndexes: EventIndexCache): Promise<Record<string, unknown>> {
  const universeRoot = join(root, LAB_LIVE_EXPERIMENT_ID, LIVE_UNIVERSE_ID);
  const chain = await readChainEntries(universeRoot, root);

  let liveRecords: RunRecord[] = [];
  try {
    const discovery = await discoverRuns(universeRoot);
    if (!discovery.truncated && !discovery.ambiguous) {
      liveRecords = discovery.records.filter(
        (candidate) => candidate.manifest.experimentId === LAB_LIVE_EXPERIMENT_ID
          && candidate.manifest.universeId === LIVE_UNIVERSE_ID,
      );
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const chainedRunIds = new Set(chain.map((entry) => entry.runId));
  const unchained = liveRecords.filter((candidate) => !chainedRunIds.has(candidate.runId));
  let currentRunId: string | null = null;
  let boundary = false;
  if (unchained.length >= 1) {
    unchained.sort((left, right) => compareCodeUnits(right.runId, left.runId));
    const current = unchained[0];
    currentRunId = current?.runId ?? null;
    if (current !== undefined) {
      boundary = (await readOptionalJsonArtifact(current.directory, "summary.json", root)) !== null;
    }
  } else if (chain.length > 0) {
    boundary = true;
  }

  const headRunId = currentRunId ?? (chain.length > 0 ? (chain[chain.length - 1]?.runId ?? null) : null);
  const headRecord = headRunId === null
    ? undefined
    : liveRecords.find((candidate) => candidate.runId === headRunId);

  let lastSeq: number | null = null;
  let lastTick: number | null = null;
  let cognitionHealth: LiveCognitionHealth = {
    window: LIVE_COGNITION_HEALTH_WINDOW_TICKS,
    consulted: 0,
    unavailable: 0,
    starved: 0,
  };
  if (headRecord !== undefined) {
    try {
      const head = await readRunHead(headRecord, root);
      lastSeq = head.lastSeq;
      lastTick = head.lastTick;
    } catch {
      // Evidence for the head run is unreadable; surface null instead of failing the whole endpoint.
    }
    try {
      cognitionHealth = await computeCognitionHealth(headRecord, root, eventIndexes, lastTick ?? 0);
    } catch {
      // Best-effort: an unreadable or oversized tail degrades to a zeroed health window.
    }
  }

  const epoch = currentRunId !== null ? chain.length : (chain.length > 0 ? chain.length - 1 : null);

  return {
    experimentId: LAB_LIVE_EXPERIMENT_ID,
    universeId: LIVE_UNIVERSE_ID,
    currentRunId,
    epoch,
    head: { lastSeq, lastTick },
    boundary,
    cognitionHealth,
    chain,
  };
}

function parseEventQuery(url: URL): { after: number; limit: number } {
  for (const key of url.searchParams.keys()) {
    if (key !== "after" && key !== "limit") throw new ObserverHttpError(400, "invalid_query");
  }
  if (url.searchParams.getAll("after").length > 1 || url.searchParams.getAll("limit").length > 1) {
    throw new ObserverHttpError(400, "invalid_query");
  }

  const after = parseBoundedInteger(url.searchParams.get("after"), 0, Number.MAX_SAFE_INTEGER, 0);
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 1, MAX_EVENT_LIMIT, DEFAULT_EVENT_LIMIT);
  return { after, limit };
}

function parseBoundedInteger(value: string | null, minimum: number, maximum: number, fallback: number): number {
  if (value === null) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new ObserverHttpError(400, "invalid_query");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ObserverHttpError(400, "invalid_query");
  }
  return parsed;
}

function ensureNoQuery(url: URL): void {
  if (url.search.length > 0) throw new ObserverHttpError(400, "invalid_query");
}

function decodeRunId(encoded: string | undefined): string {
  if (encoded === undefined) throw new ObserverHttpError(400, "invalid_run_id");
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    throw new ObserverHttpError(400, "invalid_run_id");
  }
  if (!isSafeRunId(decoded)) throw new ObserverHttpError(400, "invalid_run_id");
  return decoded;
}

function isSafeRunId(runId: string): boolean {
  return RUN_ID_PATTERN.test(runId) && runId !== "." && runId !== "..";
}

function rejectTraversalTarget(target: string): void {
  const rawPath = target.split(/[?#]/u, 1)[0] ?? "";
  if (rawPath.includes("\\") || rawPath.includes("\0")) {
    throw new ObserverHttpError(400, "invalid_request_target");
  }
  for (const encodedSegment of rawPath.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(encodedSegment);
    } catch {
      throw new ObserverHttpError(400, "invalid_request_target");
    }
    if (segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\") || segment.includes("\0")) {
      throw new ObserverHttpError(400, "invalid_request_target");
    }
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== ".." && !pathFromParent.startsWith(sep));
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactEvidence(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((entry) => redactEvidence(entry));
  if (!isJsonObject(value)) return value;

  const redacted: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const entries = Object.entries(value).sort(([left], [right]) => compareCodeUnits(left, right));
  for (const [key, entry] of entries) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    redacted[key] = isSensitiveKey(key) ? REDACTED : redactEvidence(entry);
  }
  return redacted;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized.includes("password")
    || normalized.includes("passwd")
    || normalized.includes("secret")
    || normalized.includes("credential")
    || normalized === "authorization"
    || normalized === "proxyauthorization"
    || normalized === "cookie"
    || normalized === "setcookie"
    || normalized.endsWith("token")
    || normalized.endsWith("jwt")
    || normalized.endsWith("apikey")
    || normalized.endsWith("accesstoken")
    || normalized.endsWith("refreshtoken")
    || normalized.endsWith("idtoken")
    || normalized.endsWith("privatekey");
}

function redactString(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(
      /(^|[^a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi,
      "$1$2[REDACTED]@",
    )
    .replace(
      /(api[_-]?key|client[_-]?secret|password|passwd|(?:access|refresh|session|auth|csrf|bearer|api)?[_-]?token|jwt|authorization)(\s*[=:]\s*)[^\s,;&]+/gi,
      "$1$2[REDACTED]",
    );
}
