/**
 * Recorded external work (design §4.F, phase L3b).
 *
 * `external` is the only task family a seed cannot produce. Such a task enters
 * the world from `tasks/inbox.jsonl` as a recorded input and is graded by a
 * recorded verdict, never by a hidden oracle — which is exactly why it is
 * allowed to cross an epoch boundary while calibration work is not.
 *
 * The calibration stream is deliberately NOT behind this port. The world owns
 * one `DeterministicTaskStream` and the protocol verifier regenerates it from
 * the same seed; wrapping that in a second object would be a second
 * calibration generator, which the single-embodiment invariant forbids. What
 * a composite source composes here is therefore recorded sources only.
 */
import { assertExternalTask, externalTaskId, type LiveExternalTaskInput } from "../epoch-rules.js";
import type { LiveTaskSource } from "../live-ports.js";
import type { LabTaskState } from "../types.js";
import {
  RecordedInputError,
  assertKnownFields,
  assertNotAddressed,
  readInbox,
  requiredInboxString,
  requiredInboxTick,
} from "./recorded-inbox.js";

/** Identity of the file-backed external task inbox. */
export const LIVE_FILE_TASK_SOURCE_ID = "file-task-source-v1";
/** The inbox path, relative to the universe root. */
export const LIVE_TASK_INBOX_SEGMENTS: readonly string[] = Object.freeze(["tasks", "inbox.jsonl"]);

const TASK_RECORD_FIELDS: readonly string[] = Object.freeze([
  "tick", "deadlineTick", "slug", "prompt", "rubric",
]);

/**
 * One line of `tasks/inbox.jsonl`, turned into the task the world will commit.
 *
 * The id is a commitment to the content (`externalTaskId`), so replay can
 * check the event against itself without ever reading this file again, and a
 * byte-identical record can never enter the world twice.
 */
export function parseExternalTaskRecord(record: Record<string, unknown>): LabTaskState {
  assertNotAddressed(record, "An external task record");
  assertKnownFields(record, TASK_RECORD_FIELDS, "An external task record");
  const tick = requiredInboxTick(record, "tick", "An external task record");
  const deadlineTick = requiredInboxTick(record, "deadlineTick", "An external task record");
  const input: LiveExternalTaskInput = {
    kind: "external",
    slug: requiredInboxString(record, "slug", "An external task record"),
    prompt: requiredInboxString(record, "prompt", "An external task record"),
    rubric: requiredInboxString(record, "rubric", "An external task record"),
  };
  const task: LabTaskState = {
    id: externalTaskId(tick, deadlineTick, input),
    family: "external",
    input: { ...input },
    createdTick: tick,
    deadlineTick,
    status: "available",
  };
  if (deadlineTick <= tick) {
    throw new RecordedInputError("An external task record needs a deadlineTick after its tick");
  }
  try {
    assertExternalTask(task, tick);
  } catch (error) {
    throw new RecordedInputError(
      `An external task record is not admissible: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return task;
}

/** Parse a whole inbox, refusing two records that would produce the same task. */
export function parseExternalTaskRecords(
  records: readonly Record<string, unknown>[],
): LabTaskState[] {
  const tasks: LabTaskState[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const task = parseExternalTaskRecord(record);
    if (seen.has(task.id)) {
      throw new RecordedInputError(`The external task inbox records ${task.id} twice`);
    }
    seen.add(task.id);
    tasks.push(task);
  }
  return tasks;
}

/** An in-memory external task source — the shape a test or a driver supplies. */
export class RecordedTaskSource implements LiveTaskSource {
  readonly id: string;
  readonly #tasks: readonly LabTaskState[];

  constructor(records: readonly Record<string, unknown>[], id = LIVE_FILE_TASK_SOURCE_ID) {
    this.id = id;
    this.#tasks = parseExternalTaskRecords(records);
  }

  async next(tick: number, capacity: number): Promise<LabTaskState[]> {
    return admit(this.#tasks, tick, capacity);
  }
}

/**
 * `tasks/inbox.jsonl`, re-read every tick.
 *
 * Re-reading rather than cursoring is what makes a resume trivially correct: a
 * record is bound to its own absolute tick, so the file alone decides what
 * enters when, and a crash loses nothing but the ticks it did not run.
 */
export class FileTaskSource implements LiveTaskSource {
  readonly id: string;
  readonly #path: string;

  constructor(path: string, id = LIVE_FILE_TASK_SOURCE_ID) {
    this.#path = path;
    this.id = id;
  }

  async next(tick: number, capacity: number): Promise<LabTaskState[]> {
    const records = await readInbox(this.#path, "The external task inbox");
    return admit(parseExternalTaskRecords(records), tick, capacity);
  }
}

/** Several recorded sources as one, in the order they were composed. */
export class CompositeTaskSource implements LiveTaskSource {
  readonly id: string;
  readonly #sources: readonly LiveTaskSource[];

  constructor(sources: readonly LiveTaskSource[], id?: string) {
    if (sources.length === 0) throw new Error("A composite task source needs at least one source");
    this.#sources = [...sources];
    this.id = id ?? `composite(${sources.map((source) => source.id).join("+")})`;
  }

  async next(tick: number, capacity: number, signal?: AbortSignal): Promise<LabTaskState[]> {
    const admitted: LabTaskState[] = [];
    for (const source of this.#sources) {
      const remaining = capacity - admitted.length;
      if (remaining <= 0) break;
      admitted.push(...await source.next(tick, remaining, signal));
    }
    return admitted;
  }
}

function admit(tasks: readonly LabTaskState[], tick: number, capacity: number): LabTaskState[] {
  if (!Number.isSafeInteger(capacity) || capacity < 0) {
    throw new RangeError("Task source capacity must be a non-negative safe integer");
  }
  // A record belongs to its own tick. Beyond the tick's capacity the bounded
  // world simply has no room, and an unadmitted record stays unadmitted rather
  // than arriving late under a tick it does not name.
  return tasks.filter((task) => task.createdTick === tick).slice(0, capacity).map((task) => structuredClone(task));
}
