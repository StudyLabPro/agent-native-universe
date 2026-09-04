/**
 * Kernel-assigned process identity, used to tell a writer lease left behind by
 * a crashed process apart from one still held by a live process.
 *
 * `kill(pid, 0)` is not enough: a pid is recycled the moment its owner exits,
 * and a fresh supervisor process routinely lands on a low, previously-used pid
 * (1 or 7 inside a container). Two facts the kernel hands out are not subject
 * to that ambiguity: the boot id (constant for a boot, unique across boots)
 * and a process's start time in clock ticks since boot (field 22 of
 * `/proc/<pid>/stat`, which differs between any two processes that have ever
 * held the same pid within one boot).
 */

import { readFile } from "node:fs/promises";

const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

/** The identifier of the current boot. Constant across this boot, unique across boots. */
export async function readBootId(): Promise<string> {
  const raw = await readFile(BOOT_ID_PATH, "utf8");
  const bootId = raw.trim();
  if (bootId.length === 0) throw new Error(`${BOOT_ID_PATH} is empty`);
  return bootId;
}

/**
 * Field 22 (`starttime`) of `/proc/<pid>/stat`: clock ticks since boot at
 * which the process currently holding `pid` started. `undefined` when no
 * process currently holds `pid`.
 */
export async function readProcessStartTicks(pid: number): Promise<number | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError("pid must be a positive safe integer");
  let raw: string;
  try {
    raw = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return undefined;
    throw error;
  }
  // `comm` (field 2) is parenthesized and may itself contain spaces or
  // parentheses; the *last* ")" in the line always ends it, so every field
  // after that point is a simple space-separated token.
  const closingParen = raw.lastIndexOf(")");
  if (closingParen === -1) throw new Error(`Unable to parse /proc/${pid}/stat`);
  const fields = raw.slice(closingParen + 2).split(" ");
  // fields[0] is field 3 (state); field 22 (starttime) is therefore fields[19].
  const starttime = fields[19];
  const startTicks = starttime === undefined ? Number.NaN : Number(starttime);
  if (!Number.isSafeInteger(startTicks) || startTicks < 0) {
    throw new Error(`Unable to parse starttime from /proc/${pid}/stat`);
  }
  return startTicks;
}

/** `readProcessStartTicks` for a pid the caller knows is currently alive (typically its own). */
export async function requireProcessStartTicks(pid: number): Promise<number> {
  const startTicks = await readProcessStartTicks(pid);
  if (startTicks === undefined) throw new Error(`No process currently holds pid ${pid}`);
  return startTicks;
}
