import { constants } from "node:fs";
import { isUtf8 } from "node:buffer";
import {
  link,
  opendir,
  readdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson, hashValue } from "./canonical.js";
import { validateGenesisConfig } from "./config.js";
import { validateRunEvidenceAttestation } from "./evidence-attestation-schema.js";
import { registerFinalAttestationWriter } from "./evidence-attestation-storage.js";
import {
  registerEvidenceVerificationSnapshotProvider,
  type EvidenceVerificationSnapshot,
} from "./evidence-verification-snapshot.js";
import { LabEventRecorder } from "./event-recorder.js";
import {
  ensureNoSymlinkDirectoryHierarchy,
  openRegularFileNoFollow,
  unlinkEntryNoFollow,
  withAnchoredDirectory,
  withAnchoredParentDirectory,
  type AnchoredDirectory,
} from "./event-stream.js";
import {
  assertLabManifestImplementation,
} from "./manifest.js";
import { readBootId, readProcessStartTicks, requireProcessStartTicks } from "./process-identity.js";
import { ReplayEngine } from "./replay.js";
import type {
  Checkpoint,
  GenesisConfig,
  MetricsSnapshot,
  RunEvidenceAttestation,
  RunManifest,
  RunSummary,
} from "./types.js";

export class EvidenceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceConflictError";
  }
}

const MAX_DISCOVERY_ENTRIES = 10_000;
const MAX_MANIFEST_BYTES = 1_048_576;
const MAX_CONFIG_BYTES = 1_048_576;
const MAX_SUMMARY_BYTES = 1_048_576;
const MAX_METRICS_BYTES = 67_108_864;
const MAX_CHECKPOINT_BYTES = 67_108_864;
const MAX_ATTESTATION_BYTES = 1_048_576;
const MAX_WRITER_LEASE_BYTES = 4_096;

export interface WriterLeaseOptions {
  /**
   * Recover a lock left behind by a crashed writer instead of always failing
   * closed. Staleness is judged by kernel-assigned process identity (boot id
   * and the recorded process's start time), never by `kill(pid, 0)`: a pid is
   * recycled the moment its owner exits, so mere pid existence cannot tell
   * the lease's original writer from an unrelated later process. Omitted or
   * `false` preserves the historical behaviour: any existing lock, live or
   * stale, is always a conflict.
   */
  recoverStale?: boolean;
}

interface WriterLeaseRecord {
  pid: number;
  runId: string;
  bootId: string;
  startTicks: number;
}

export interface EvidenceStoreOptions {
  /** Retain the full event log for synchronous inspection. Disable for long runs. */
  retainEvents?: boolean;
  /** Address evidence by immutable run identity below the universe directory. */
  runId?: string;
}

/**
 * Durable evidence layout rooted at
 * `<runsRoot>/<experiment>/<universe>/<runId>` for new runs. Legacy evidence
 * directly below `<universe>` remains readable through `openExisting`.
 *
 * Scientific JSON is canonical and contains only caller-provided logical
 * values. The store never injects wall-clock timestamps into payloads.
 */
export class EvidenceStore {
  readonly runsRoot: string;
  readonly experimentId: string;
  readonly universeId: string;
  readonly runId: string | undefined;
  readonly directory: string;
  readonly checkpointsDirectory: string;
  readonly attestationsDirectory: string;
  readonly manifestPath: string;
  readonly configPath: string;
  readonly eventsPath: string;
  readonly metricsPath: string;
  readonly summaryPath: string;
  readonly finalAttestationPath: string;

  #recorder: LabEventRecorder | undefined;
  #jsonTail: Promise<void> = Promise.resolve();
  #metricsTail: Promise<void> = Promise.resolve();
  #lastMetricTick = -1;
  readonly #retainEvents: boolean;

  constructor(
    runsRoot: string,
    experimentId: string,
    universeId: string,
    options: EvidenceStoreOptions = {},
  ) {
    if (!runsRoot) throw new TypeError("Evidence runs root must not be empty");
    assertSafeIdentifier(experimentId, "experiment id");
    assertSafeIdentifier(universeId, "universe id");
    if (options.runId !== undefined) assertSafeIdentifier(options.runId, "run id");
    this.runsRoot = resolve(runsRoot);
    this.experimentId = experimentId;
    this.universeId = universeId;
    this.runId = options.runId;
    this.directory = options.runId === undefined
      ? containedPath(this.runsRoot, experimentId, universeId)
      : containedPath(this.runsRoot, experimentId, universeId, options.runId);
    this.checkpointsDirectory = containedPath(this.directory, "checkpoints");
    this.attestationsDirectory = containedPath(this.directory, "attestations");
    this.manifestPath = containedPath(this.directory, "manifest.json");
    this.configPath = containedPath(this.directory, "config.json");
    this.eventsPath = containedPath(this.directory, "events.jsonl");
    this.metricsPath = containedPath(this.directory, "metrics.jsonl");
    this.summaryPath = containedPath(this.directory, "summary.json");
    this.finalAttestationPath = containedPath(this.attestationsDirectory, "final.json");
    this.#retainEvents = options.retainEvents !== false;
    registerFinalAttestationWriter(this, (attestation) => this.#writeFinalAttestation(attestation));
    registerEvidenceVerificationSnapshotProvider(
      this,
      (operation) => this.#withVerificationSnapshot(operation),
    );
  }

  static async initialize(
    runsRoot: string,
    manifest: RunManifest,
    config: GenesisConfig,
    options: EvidenceStoreOptions = {},
  ): Promise<EvidenceStore> {
    if (options.runId !== undefined && options.runId !== manifest.runId) {
      throw new Error("Evidence store run id does not match the manifest");
    }
    const store = new EvidenceStore(
      runsRoot,
      manifest.experimentId,
      manifest.universeId,
      { ...options, runId: manifest.runId },
    );
    await store.initialize(manifest, config);
    return store;
  }

  /**
   * Open already-published evidence without guessing between multiple runs.
   *
   * With an explicit run id, the canonical child directory is selected first
   * and a matching legacy manifest is used only as a compatibility fallback.
   * Without one, exactly one evidence candidate supported by this engine must
   * exist. Directory and artifact symlinks are never followed.
   */
  static async openExisting(
    runsRoot: string,
    experimentId: string,
    universeId: string,
    runId?: string,
  ): Promise<EvidenceStore> {
    if (runId !== undefined) assertSafeIdentifier(runId, "run id");
    const legacy = new EvidenceStore(runsRoot, experimentId, universeId);
    const hierarchyExists = await validateDiscoveryHierarchy(legacy);
    if (!hierarchyExists) {
      throw selectionError(experimentId, universeId, runId);
    }

    if (runId !== undefined) {
      const addressed = new EvidenceStore(runsRoot, experimentId, universeId, { runId });
      const exact = await inspectEvidenceCandidate(addressed, runId);
      if (exact.kind === "supported") return addressed;
      if (exact.kind === "unsupported") throw unsupportedImplementationError(exact);

      const legacyCandidate = await inspectEvidenceCandidate(legacy);
      if (legacyCandidate.kind !== "missing" && legacyCandidate.manifest.runId === runId) {
        if (legacyCandidate.kind === "unsupported") {
          throw unsupportedImplementationError(legacyCandidate);
        }
        return legacy;
      }
      throw selectionError(experimentId, universeId, runId);
    }

    const candidates: EvidenceStore[] = [];
    const legacyCandidate = await inspectEvidenceCandidate(legacy);
    if (legacyCandidate.kind === "supported") candidates.push(legacy);

    const entryNames: string[] = [];
    let entryCount = 0;
    await withAnchoredDirectory(legacy.directory, {}, async (anchored) => {
      const directory = await opendir(anchored.path);
      for await (const entry of directory) {
        entryCount += 1;
        if (entryCount > MAX_DISCOVERY_ENTRIES) {
          throw new Error(
            `Evidence universe exceeds the ${MAX_DISCOVERY_ENTRIES}-entry discovery limit`,
          );
        }
        if (entry.isSymbolicLink()) {
          throw new Error(`Refusing symbolic link evidence entry ${entry.name}`);
        }
        if (!entry.isDirectory() || !isSafeIdentifier(entry.name)) continue;
        entryNames.push(entry.name);
      }
    });
    entryNames.sort(compareCodeUnits);
    for (const entryName of entryNames) {
      const addressed = new EvidenceStore(runsRoot, experimentId, universeId, {
        runId: entryName,
      });
      const candidate = await inspectEvidenceCandidate(addressed, entryName);
      if (candidate.kind === "supported") candidates.push(addressed);
    }

    if (candidates.length !== 1) {
      const available = candidates
        .map((candidate) => candidate.runId ?? (legacyCandidate.kind === "missing"
          ? "legacy"
          : legacyCandidate.manifest.runId))
        .join(", ");
      const detail = available ? ` (${available})` : "";
      if (candidates.length === 0) {
        throw new EvidenceConflictError(
          `No supported evidence runs found for ${experimentId}/${universeId}`,
        );
      }
      throw new EvidenceConflictError(
        `Multiple supported evidence runs found for ${experimentId}/${universeId}${detail}; specify --run-id`,
      );
    }
    return candidates[0]!;
  }

  get events(): LabEventRecorder {
    if (!this.#recorder) throw new Error("EvidenceStore has not been initialized");
    return this.#recorder;
  }

  /**
   * Acquire a cross-process exclusive writer lease for this universe.
   *
   * The lock is operational metadata, not scientific evidence. A process
   * crash intentionally leaves it behind so an operator must inspect the
   * incomplete append-only log before explicitly removing a stale lock —
   * unless `recoverStale` is set, in which case a lock this process can prove
   * stale (by kernel identity, not by `kill(pid, 0)`) is recovered instead.
   */
  async acquireWriterLease(runId: string, options: WriterLeaseOptions = {}): Promise<() => Promise<void>> {
    assertSafeIdentifier(runId, "lease run id");
    await ensureNoSymlinkDirectoryHierarchy(this.directory);
    const path = containedPath(this.directory, ".runner.lock");

    let handle: Awaited<ReturnType<typeof openRegularFileNoFollow>>;
    try {
      handle = await this.#createLeaseFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (options.recoverStale !== true || !(await this.#isWriterLeaseStale(path))) {
        throw new EvidenceConflictError(
          `Universe ${this.universeId} already has an active or stale writer lease`,
        );
      }
      await unlinkEntryNoFollow(path).catch((unlinkError) => {
        if (!isMissing(unlinkError)) throw unlinkError;
      });
      try {
        handle = await this.#createLeaseFile(path);
      } catch (retryError) {
        if ((retryError as NodeJS.ErrnoException).code === "EEXIST") {
          throw new EvidenceConflictError(
            `Universe ${this.universeId} writer lease was recreated concurrently during recovery`,
          );
        }
        throw retryError;
      }
    }

    try {
      const record: WriterLeaseRecord = {
        pid: process.pid,
        runId,
        bootId: await readBootId(),
        startTicks: await requireProcessStartTicks(process.pid),
      };
      await handle.writeFile(canonicalJson(record), "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlinkEntryNoFollow(path).catch(() => undefined);
      throw error;
    }

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await handle.close();
      await unlinkEntryNoFollow(path);
    };
  }

  async #createLeaseFile(path: string): Promise<Awaited<ReturnType<typeof openRegularFileNoFollow>>> {
    return openRegularFileNoFollow(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
  }

  /**
   * A lock is stale exactly when this process can prove its recorded owner
   * cannot be the one holding it: the boot changed under it, no process holds
   * that pid any more, or a process does hold it but started at a different
   * time than the one recorded — the same pid handed to an unrelated later
   * process. An unreadable or malformed lock is never treated as stale: a
   * lease this process cannot positively disprove is left as a conflict.
   */
  async #isWriterLeaseStale(path: string): Promise<boolean> {
    let existing: WriterLeaseRecord;
    try {
      existing = await readCanonicalJson<WriterLeaseRecord>(path, MAX_WRITER_LEASE_BYTES);
    } catch {
      return false;
    }
    if (
      typeof existing.pid !== "number" || !Number.isSafeInteger(existing.pid) || existing.pid <= 0
      || typeof existing.bootId !== "string" || existing.bootId.length === 0
      || typeof existing.startTicks !== "number" || !Number.isSafeInteger(existing.startTicks)
      || existing.startTicks < 0
    ) {
      return false;
    }
    const currentBootId = await readBootId();
    if (existing.bootId !== currentBootId) return true;
    const actualStartTicks = await readProcessStartTicks(existing.pid);
    if (actualStartTicks === undefined) return true;
    return actualStartTicks !== existing.startTicks;
  }

  async initialize(manifest: RunManifest, config: GenesisConfig): Promise<LabEventRecorder> {
    validateManifest(manifest);
    if (manifest.experimentId !== this.experimentId || manifest.universeId !== this.universeId) {
      throw new Error("Manifest does not match the evidence directory");
    }
    if (this.runId !== undefined && manifest.runId !== this.runId) {
      throw new Error("Manifest run id does not match the evidence directory");
    }
    if (config.experimentId !== manifest.experimentId) {
      throw new Error("Config experiment does not match the manifest");
    }
    const computedConfigHash = hashValue(config);
    if (computedConfigHash !== manifest.configHash) {
      throw new Error(`Config hash mismatch: expected ${manifest.configHash}, got ${computedConfigHash}`);
    }

    await ensureNoSymlinkDirectoryHierarchy(this.checkpointsDirectory);
    await ensureNoSymlinkDirectoryHierarchy(this.attestationsDirectory);
    await this.#writeImmutable(this.manifestPath, manifest, "manifest");
    await this.#writeImmutable(this.configPath, config, "config");
    await ensureAppendFile(this.metricsPath);
    this.#lastMetricTick = lastMetricTick(await readCanonicalJsonl<MetricsSnapshot>(
      this.metricsPath,
      MAX_METRICS_BYTES,
    ));
    this.#recorder = await LabEventRecorder.open(this.eventsPath, manifest, {
      retainEvents: this.#retainEvents,
    });
    return this.#recorder;
  }

  async writeSummary(summary: RunSummary): Promise<void> {
    this.#assertInitialized();
    if (summary.runId !== this.events.manifest.runId || summary.universeId !== this.universeId) {
      throw new Error("Summary does not match this evidence run");
    }
    await this.#enqueueJson(() => this.#writeImmutable(this.summaryPath, summary, "summary"));
  }

  async #writeFinalAttestation(attestation: RunEvidenceAttestation): Promise<void> {
    validateRunEvidenceAttestation(attestation);
    const manifest = await this.readManifest();
    if (
      attestation.subject.runId !== manifest.runId
      || attestation.subject.experimentId !== manifest.experimentId
      || attestation.subject.universeId !== manifest.universeId
      || attestation.scope.kind !== "final"
    ) {
      throw new Error("Final attestation does not match this evidence run");
    }
    await this.#enqueueJson(() => this.#writeImmutable(
      this.finalAttestationPath,
      attestation,
      "final attestation",
    ));
  }

  async writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
    this.#assertInitialized();
    validateCheckpoint(checkpoint, this.events.manifest);
    const path = this.checkpointPath(checkpoint.tick);
    await this.#enqueueJson(() => this.#writeImmutable(path, checkpoint, `checkpoint ${checkpoint.tick}`));
  }

  appendMetrics(metrics: MetricsSnapshot): Promise<void> {
    this.#assertInitialized();
    validateMetric(metrics);
    const captured = structuredClone(metrics);
    const operation = this.#metricsTail.then(async () => {
      if (captured.tick <= this.#lastMetricTick) {
        throw new EvidenceConflictError(
          `Metric tick ${captured.tick} does not advance ${this.#lastMetricTick}`,
        );
      }
      await appendCanonicalLine(this.metricsPath, captured);
      this.#lastMetricTick = captured.tick;
    });
    this.#metricsTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async readManifest(): Promise<RunManifest> {
    const manifest = await readCanonicalJson<RunManifest>(this.manifestPath, MAX_MANIFEST_BYTES);
    validateManifest(manifest);
    if (manifest.experimentId !== this.experimentId || manifest.universeId !== this.universeId) {
      throw new Error("Stored manifest does not match its evidence directory");
    }
    if (this.runId !== undefined && manifest.runId !== this.runId) {
      throw new Error("Stored manifest run id does not match its evidence directory");
    }
    return manifest;
  }

  async readConfig(): Promise<GenesisConfig> {
    const config = await readCanonicalJson<GenesisConfig>(this.configPath, MAX_CONFIG_BYTES);
    const manifest = await this.readManifest();
    if (config.experimentId !== this.experimentId || hashValue(config) !== manifest.configHash) {
      throw new Error("Stored config does not match its manifest");
    }
    return config;
  }

  async readSummary(): Promise<RunSummary | undefined> {
    const summary = await readOptionalCanonicalJson<RunSummary>(
      this.summaryPath,
      MAX_SUMMARY_BYTES,
    );
    if (!summary) return undefined;
    const manifest = await this.readManifest();
    if (summary.runId !== manifest.runId || summary.universeId !== this.universeId) {
      throw new Error("Stored summary does not match its manifest");
    }
    return summary;
  }

  async readFinalAttestation(): Promise<RunEvidenceAttestation | undefined> {
    const attestation = await readOptionalCanonicalJson<unknown>(
      this.finalAttestationPath,
      MAX_ATTESTATION_BYTES,
    );
    if (attestation === undefined) return undefined;
    validateRunEvidenceAttestation(attestation);
    const manifest = await this.readManifest();
    if (
      attestation.subject.runId !== manifest.runId
      || attestation.subject.experimentId !== manifest.experimentId
      || attestation.subject.universeId !== manifest.universeId
    ) {
      throw new Error("Stored final attestation does not match its evidence run");
    }
    return attestation;
  }

  async readCheckpoint(tick: number): Promise<Checkpoint | undefined> {
    const checkpoint = await readOptionalCanonicalJson<Checkpoint>(
      this.checkpointPath(tick),
      MAX_CHECKPOINT_BYTES,
    );
    if (!checkpoint) return undefined;
    validateCheckpoint(checkpoint, await this.readManifest());
    return checkpoint;
  }

  async readCheckpoints(): Promise<Checkpoint[]> {
    let entries: string[];
    try {
      entries = await withAnchoredDirectory(
        this.checkpointsDirectory,
        {},
        (directory) => readdir(directory.path),
      );
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const ticks = entries.map((entry) => {
      const match = /^(0|[1-9][0-9]*)\.json$/.exec(entry);
      if (!match) throw new Error(`Unexpected checkpoint artifact ${entry}`);
      const tick = Number(match[1]);
      nonNegativeSafeInteger(tick, "checkpoint filename tick");
      return tick;
    }).sort((left, right) => left - right);
    const checkpoints: Checkpoint[] = [];
    for (const tick of ticks) {
      const checkpoint = await this.readCheckpoint(tick);
      if (!checkpoint) throw new Error(`Checkpoint ${tick} disappeared during read`);
      checkpoints.push(checkpoint);
    }
    return checkpoints;
  }

  async readMetrics(): Promise<MetricsSnapshot[]> {
    const metrics = await readCanonicalJsonl<MetricsSnapshot>(
      this.metricsPath,
      MAX_METRICS_BYTES,
    );
    let prior = -1;
    for (const value of metrics) {
      validateMetric(value);
      if (value.tick <= prior) throw new Error(`Metrics are not strictly ordered at tick ${value.tick}`);
      prior = value.tick;
    }
    return metrics;
  }

  checkpointPath(tick: number): string {
    nonNegativeSafeInteger(tick, "checkpoint tick");
    return containedPath(this.checkpointsDirectory, `${tick}.json`);
  }

  async flush(): Promise<void> {
    await Promise.all([
      this.#jsonTail,
      this.#metricsTail,
      this.#recorder?.flush() ?? Promise.resolve(),
    ]);
  }

  #assertInitialized(): void {
    if (!this.#recorder) throw new Error("EvidenceStore has not been initialized");
  }

  #enqueueJson(operation: () => Promise<void>): Promise<void> {
    const queued = this.#jsonTail.then(operation);
    this.#jsonTail = queued.then(() => undefined, () => undefined);
    return queued;
  }

  async #withVerificationSnapshot<T>(
    operation: (snapshot: EvidenceVerificationSnapshot) => Promise<T>,
  ): Promise<T> {
    return withAnchoredDirectory(this.directory, {}, async (directory) => {
      const opened: FileHandle[] = [];
      const openArtifact = async (name: string): Promise<FileHandle> => {
        const handle = await directory.openRegular(name, constants.O_RDONLY);
        opened.push(handle);
        return handle;
      };
      try {
        const handles = {
          manifest: await openArtifact("manifest.json"),
          config: await openArtifact("config.json"),
          events: await openArtifact("events.jsonl"),
          metrics: await openArtifact("metrics.jsonl"),
          summary: await openArtifact("summary.json"),
        };
        const initialIdentities = await captureOpenFileIdentities(handles);
        const snapshot: EvidenceVerificationSnapshot = {
          readManifest: async () => {
            const manifest = await readCanonicalJsonFromOpenHandle<RunManifest>(
              handles.manifest,
              this.manifestPath,
              MAX_MANIFEST_BYTES,
            );
            validateManifest(manifest);
            if (
              manifest.experimentId !== this.experimentId
              || manifest.universeId !== this.universeId
              || (this.runId !== undefined && manifest.runId !== this.runId)
            ) {
              throw new Error("Stored manifest does not match its evidence directory");
            }
            return manifest;
          },
          readConfig: async (manifest) => {
            const config = await readCanonicalJsonFromOpenHandle<GenesisConfig>(
              handles.config,
              this.configPath,
              MAX_CONFIG_BYTES,
            );
            validateGenesisConfig(config);
            if (
              config.experimentId !== this.experimentId
              || hashValue(config) !== manifest.configHash
            ) {
              throw new Error("Stored config does not match its manifest");
            }
            return config;
          },
          replay: (manifest, config) => ReplayEngine.replayHandle(
            handles.events,
            manifest,
            config,
          ),
          readMetrics: async () => {
            const metrics = await readCanonicalJsonlFromOpenHandle<MetricsSnapshot>(
              handles.metrics,
              this.metricsPath,
              MAX_METRICS_BYTES,
            );
            lastMetricTick(metrics);
            return metrics;
          },
          readSummary: async (manifest) => {
            const summary = await readCanonicalJsonFromOpenHandle<RunSummary>(
              handles.summary,
              this.summaryPath,
              MAX_SUMMARY_BYTES,
            );
            if (summary.runId !== manifest.runId || summary.universeId !== this.universeId) {
              throw new Error("Stored summary does not match its manifest");
            }
            return summary;
          },
          assertStable: async () => {
            const finalIdentities = await captureOpenFileIdentities(handles);
            for (const [name, identity] of Object.entries(initialIdentities)) {
              if (!sameOpenFileIdentity(identity, finalIdentities[name]!)) {
                throw new Error(`Evidence artifact changed during verification: ${name}`);
              }
            }
          },
        };
        return await operation(snapshot);
      } finally {
        for (const handle of opened.reverse()) await handle.close().catch(() => undefined);
      }
    });
  }

  async #writeImmutable(path: string, value: unknown, label: string): Promise<void> {
    const serialized = canonicalJson(value);
    try {
      const existing = await readTextNoFollow(path, Buffer.byteLength(serialized, "utf8"));
      if (existing === serialized) return;
      throw new EvidenceConflictError(`Refusing to replace existing ${label}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await atomicCanonicalWrite(path, serialized);
  }
}

interface OpenFileIdentity {
  device: bigint;
  inode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

async function captureOpenFileIdentities(
  handles: Readonly<Record<string, FileHandle>>,
): Promise<Record<string, OpenFileIdentity>> {
  const identities: Record<string, OpenFileIdentity> = {};
  for (const [name, handle] of Object.entries(handles)) {
    const info = await handle.stat({ bigint: true });
    identities[name] = {
      device: info.dev,
      inode: info.ino,
      size: info.size,
      mtimeNs: info.mtimeNs,
      ctimeNs: info.ctimeNs,
    };
  }
  return identities;
}

function sameOpenFileIdentity(left: OpenFileIdentity, right: OpenFileIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

type CandidateInspection =
  | { kind: "missing" }
  | { kind: "supported"; manifest: RunManifest }
  | { kind: "unsupported"; manifest: RunManifest; reason: string };

async function validateDiscoveryHierarchy(store: EvidenceStore): Promise<boolean> {
  const experimentDirectory = containedPath(store.runsRoot, store.experimentId);
  for (const [path, label] of [
    [store.runsRoot, "runs root"],
    [experimentDirectory, "experiment directory"],
    [containedPath(experimentDirectory, store.universeId), "universe directory"],
  ] as const) {
    try {
      await withAnchoredDirectory(path, {}, async () => undefined);
    } catch (error) {
      if (isMissing(error)) return false;
      if (error instanceof Error && /symbolic link|non-directory/.test(error.message)) {
        throw new Error(`Refusing symbolic link or invalid ${label}`, { cause: error });
      }
      throw error;
    }
  }
  return true;
}

async function inspectEvidenceCandidate(
  store: EvidenceStore,
  expectedRunId?: string,
): Promise<CandidateInspection> {
  try {
    await withAnchoredDirectory(store.directory, {}, async (anchored) => {
      let entryCount = 0;
      const directory = await opendir(anchored.path);
      for await (const entry of directory) {
        entryCount += 1;
        if (entryCount > MAX_DISCOVERY_ENTRIES) {
          throw new Error(
            `Evidence run exceeds the ${MAX_DISCOVERY_ENTRIES}-entry discovery limit: ${store.directory}`,
          );
        }
        if (entry.isSymbolicLink()) {
          throw new Error(`Refusing symbolic link evidence artifact ${entry.name}`);
        }
      }
    });
  } catch (error) {
    if (isMissing(error)) return { kind: "missing" };
    throw error;
  }

  let value: unknown;
  try {
    value = await readCanonicalJson<unknown>(store.manifestPath, MAX_MANIFEST_BYTES);
  } catch (error) {
    if (isMissing(error)) return { kind: "missing" };
    if (error instanceof Error && error.message.includes(`${MAX_MANIFEST_BYTES}-byte read limit`)) {
      throw new Error(
        `Evidence manifest exceeds the ${MAX_MANIFEST_BYTES}-byte discovery limit: ${store.manifestPath}`,
        { cause: error },
      );
    }
    throw error;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Evidence manifest must be a JSON object: ${store.manifestPath}`);
  }
  const manifest = value as RunManifest;
  assertSafeIdentifier(manifest.experimentId, "manifest experiment id");
  assertSafeIdentifier(manifest.runId, "manifest run id");
  assertSafeIdentifier(manifest.universeId, "manifest universe id");
  if (manifest.experimentId !== store.experimentId || manifest.universeId !== store.universeId) {
    throw new Error("Stored manifest does not match its evidence directory");
  }
  if (expectedRunId !== undefined && manifest.runId !== expectedRunId) {
    throw new Error(
      `Evidence directory ${expectedRunId} contains manifest for ${manifest.runId}`,
    );
  }
  try {
    assertLabManifestImplementation(manifest);
  } catch (error) {
    return {
      kind: "unsupported",
      manifest,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  validateManifest(manifest);
  return { kind: "supported", manifest };
}

function unsupportedImplementationError(
  candidate: Extract<CandidateInspection, { kind: "unsupported" }>,
): Error {
  return new Error(
    `Evidence run ${candidate.manifest.runId} has an unsupported implementation: ${candidate.reason}`,
  );
}

function selectionError(
  experimentId: string,
  universeId: string,
  runId: string | undefined,
): Error {
  if (runId !== undefined) {
    return new Error(`Evidence run ${runId} was not found for ${experimentId}/${universeId}`);
  }
  return new EvidenceConflictError(
    `No supported evidence run found for ${experimentId}/${universeId}`,
  );
}

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) && !value.includes("..");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

let temporarySequence = 0;

async function atomicCanonicalWrite(path: string, serialized: string): Promise<void> {
  await withAnchoredParentDirectory(path, { create: true }, async (directory, name) => {
    const temporaryName = `${name}.tmp-${process.pid}-${temporarySequence += 1}`;
    let handle: Awaited<ReturnType<typeof openRegularFileNoFollow>> | undefined;
    try {
      handle = await directory.openRegular(
        temporaryName,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      );
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        // Both names stay anchored to the same held directory descriptor.
        await link(directory.entry(temporaryName), directory.entry(name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const concurrent = await readTextFromAnchoredDirectory(
          directory,
          name,
          Buffer.byteLength(serialized, "utf8"),
        );
        if (concurrent !== serialized) {
          throw new EvidenceConflictError("Concurrent immutable artifact conflicts with this run");
        }
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(directory.entry(temporaryName)).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
    }
  });
}

async function appendCanonicalLine(path: string, value: unknown): Promise<void> {
  await ensureNoSymlinkDirectoryHierarchy(dirname(path));
  const handle = await openRegularFileNoFollow(
    path,
    constants.O_WRONLY | constants.O_APPEND,
  );
  try {
    await handle.writeFile(`${canonicalJson(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureAppendFile(path: string): Promise<void> {
  await ensureNoSymlinkDirectoryHierarchy(dirname(path));
  const handle = await openRegularFileNoFollow(
    path,
    constants.O_RDWR | constants.O_APPEND | constants.O_CREAT,
  );
  await handle.close();
}

async function readCanonicalJson<T>(path: string, maxBytes?: number): Promise<T> {
  const text = await readTextNoFollow(path, maxBytes);
  return parseCanonicalJson<T>(text, path);
}

async function readCanonicalJsonFromOpenHandle<T>(
  handle: FileHandle,
  path: string,
  maxBytes?: number,
): Promise<T> {
  const text = await readTextFromOpenHandle(handle, path, maxBytes);
  return parseCanonicalJson<T>(text, path);
}

function parseCanonicalJson<T>(text: string, path: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON artifact ${path}`, { cause: error });
  }
  if (canonicalJson(value) !== text) throw new Error(`Artifact is not canonical JSON: ${path}`);
  return value as T;
}

async function readOptionalCanonicalJson<T>(
  path: string,
  maxBytes?: number,
): Promise<T | undefined> {
  try {
    return await readCanonicalJson<T>(path, maxBytes);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function readCanonicalJsonl<T>(path: string, maxBytes?: number): Promise<T[]> {
  let text: string;
  try {
    text = await readTextNoFollow(path, maxBytes);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return parseCanonicalJsonl<T>(text, path);
}

async function readCanonicalJsonlFromOpenHandle<T>(
  handle: FileHandle,
  path: string,
  maxBytes?: number,
): Promise<T[]> {
  const text = await readTextFromOpenHandle(handle, path, maxBytes);
  return parseCanonicalJsonl<T>(text, path);
}

function parseCanonicalJsonl<T>(text: string, path: string): T[] {
  if (text === "") return [];
  if (!text.endsWith("\n")) throw new Error(`Truncated JSONL artifact ${path}`);
  const values: T[] = [];
  for (const [index, line] of text.slice(0, -1).split("\n").entries()) {
    if (!line) throw new Error(`Blank JSONL record at ${path}:${index + 1}`);
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSONL record at ${path}:${index + 1}`, { cause: error });
    }
    if (canonicalJson(value) !== line) throw new Error(`Non-canonical JSONL record at ${path}:${index + 1}`);
    values.push(value as T);
  }
  return values;
}

async function readTextNoFollow(path: string, maxBytes?: number): Promise<string> {
  const handle = await openRegularFileNoFollow(path, constants.O_RDONLY);
  return readTextFromHandle(handle, path, maxBytes);
}

async function readTextFromAnchoredDirectory(
  directory: AnchoredDirectory,
  name: string,
  maxBytes?: number,
): Promise<string> {
  const handle = await directory.openRegular(name, constants.O_RDONLY);
  return readTextFromHandle(handle, `${directory.displayPath}/${name}`, maxBytes);
}

async function readTextFromHandle(
  handle: Awaited<ReturnType<typeof openRegularFileNoFollow>>,
  path: string,
  maxBytes?: number,
): Promise<string> {
  try {
    return await readTextFromOpenHandle(handle, path, maxBytes);
  } finally {
    await handle.close();
  }
}

async function readTextFromOpenHandle(
  handle: FileHandle,
  path: string,
  maxBytes?: number,
): Promise<string> {
  const bytes = maxBytes === undefined
    ? await handle.readFile({ encoding: null })
    : await readBytesBounded(handle, maxBytes, path);
  if (!isUtf8(bytes)) throw new Error(`Artifact is not valid UTF-8: ${path}`);
  return bytes.toString("utf8");
}

async function readBytesBounded(
  handle: Awaited<ReturnType<typeof openRegularFileNoFollow>>,
  maxBytes: number,
  path: string,
): Promise<Buffer> {
  const info = await handle.stat();
  if (info.size > maxBytes) {
    throw new Error(`Artifact exceeds the ${maxBytes}-byte read limit: ${path}`);
  }
  const chunks: Buffer[] = [];
  let position = 0;
  while (true) {
    const remaining = maxBytes - position;
    const buffer = Buffer.allocUnsafe(Math.min(65_536, remaining + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    if (position > maxBytes) {
      throw new Error(`Artifact exceeds the ${maxBytes}-byte read limit: ${path}`);
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, position);
}

function validateManifest(manifest: RunManifest): void {
  assertSafeIdentifier(manifest.experimentId, "manifest experiment id");
  assertSafeIdentifier(manifest.runId, "manifest run id");
  assertSafeIdentifier(manifest.universeId, "manifest universe id");
  if (typeof manifest.seed !== "string" || manifest.seed.length === 0) {
    throw new Error("Manifest seed must be a non-empty string");
  }
  assertLabManifestImplementation(manifest);
  if (!/^[0-9a-f]{64}$/.test(manifest.configHash)) throw new Error("Manifest configHash must be lowercase SHA-256");
}

function validateCheckpoint(checkpoint: Checkpoint, manifest: RunManifest): void {
  nonNegativeSafeInteger(checkpoint.tick, "checkpoint tick");
  nonNegativeSafeInteger(checkpoint.seq, "checkpoint sequence");
  if (checkpoint.runId !== manifest.runId || checkpoint.universeId !== manifest.universeId) {
    throw new Error("Checkpoint does not match its manifest");
  }
  if (checkpoint.state.tick !== checkpoint.tick) throw new Error("Checkpoint state tick mismatch");
  if (hashValue(checkpoint.state) !== checkpoint.stateHash) throw new Error("Checkpoint state hash mismatch");
  if ((checkpoint.runtime === undefined) !== (checkpoint.runtimeHash === undefined)) {
    throw new Error("Checkpoint runtime and runtimeHash must appear together");
  }
  if (checkpoint.runtime !== undefined && hashValue(checkpoint.runtime) !== checkpoint.runtimeHash) {
    throw new Error("Checkpoint runtime hash mismatch");
  }
}

function validateMetric(metric: MetricsSnapshot): void {
  nonNegativeSafeInteger(metric.tick, "metric tick");
}

function lastMetricTick(metrics: readonly MetricsSnapshot[]): number {
  let prior = -1;
  for (const metric of metrics) {
    validateMetric(metric);
    if (metric.tick <= prior) throw new Error(`Metrics are not strictly ordered at tick ${metric.tick}`);
    prior = metric.tick;
  }
  return prior;
}

function assertSafeIdentifier(value: string, label: string): void {
  if (
    typeof value !== "string"
    || !isSafeIdentifier(value)
  ) {
    throw new TypeError(`${label} is unsafe`);
  }
}

function containedPath(root: string, ...parts: string[]): string {
  const path = resolve(root, ...parts);
  const relation = relative(root, path);
  if (relation === "" && parts.length > 0) throw new TypeError("Evidence path resolves to its root");
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new TypeError("Evidence path escapes its root");
  }
  return path;
}

function nonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}
