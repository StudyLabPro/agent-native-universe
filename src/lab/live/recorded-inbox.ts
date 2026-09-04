/**
 * The shared shape of a recorded-input inbox (design §4.F, phase L3b).
 *
 * An inbox is a JSON-Lines file the operator appends to. Every record names
 * the absolute tick it applies on, so a source is a pure function of the file
 * and the tick: no cursor has to survive a crash, a resume re-reads the same
 * file and reaches the same tick with the same records, and a record written
 * for a tick that has already passed is simply never admitted — it is not
 * silently applied late.
 *
 * The one rule every inbox shares is the owner's fourth invariant: **the
 * control plane sets physics only**. A record that names an individual agent
 * is refused by the parser with a message that says why, rather than being
 * dropped, ignored, or — worst — honoured.
 */
import { readFile } from "node:fs/promises";

/** Field names by which a record would be addressing an individual agent. */
export const ADDRESSED_FIELDS: readonly string[] = Object.freeze([
  "agentId", "agent", "agents", "targetId", "target", "recipientId", "recipient",
  "assignTo", "assignee", "assignedTo", "claimedBy", "for", "to", "onlyAgent",
]);

export class RecordedInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordedInputError";
  }
}

/**
 * Refuse a record that steers one agent.
 *
 * The control plane may make thinking dearer for everyone or drop the task
 * load for everyone. It may not tell agent `a-0007` what to do, who to work
 * with, or which task is its. That distinction is the whole reason Live can
 * claim its agents organise themselves, so it is enforced where the input
 * enters, not where it is used.
 */
export function assertNotAddressed(record: Record<string, unknown>, what: string): void {
  for (const field of ADDRESSED_FIELDS) {
    if (record[field] !== undefined) {
      throw new RecordedInputError(
        `${what} is addressed to an agent (${field}); the control plane sets physics only, never who does what`,
      );
    }
  }
}

/** Parse a JSON-Lines inbox into records, refusing anything that is not one. */
export function parseInboxRecords(text: string, what: string): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new RecordedInputError(
        `${what} line ${index + 1} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new RecordedInputError(`${what} line ${index + 1} is not a JSON object`);
    }
    records.push(parsed as Record<string, unknown>);
  }
  return records;
}

/** Read and parse an inbox; a missing file is an empty inbox, not an error. */
export async function readInbox(path: string, what: string): Promise<Array<Record<string, unknown>>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return parseInboxRecords(text, what);
}

export function requiredInboxString(
  record: Record<string, unknown>,
  field: string,
  what: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new RecordedInputError(`${what} requires a non-empty string ${field}`);
  }
  return value;
}

export function requiredInboxTick(
  record: Record<string, unknown>,
  field: string,
  what: string,
): number {
  const value = record[field];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RecordedInputError(`${what} requires a non-negative safe integer ${field}`);
  }
  return value as number;
}

export function assertKnownFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new RecordedInputError(`${what} contains unknown field ${key}`);
  }
}
