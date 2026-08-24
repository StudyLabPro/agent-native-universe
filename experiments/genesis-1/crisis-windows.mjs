/**
 * Windowed crisis analysis over baseline-arm evidence.
 *
 * Reads each arm's events.jsonl and slices task outcomes by the pressure
 * regime in force when the task was CREATED:
 *   W1 base      ticks   1..100
 *   W2 credits*2 ticks 101..200
 *   W3 bw/2      ticks 201..300
 *   W4 -20% pop  ticks 301..400
 *   W5 load*4    ticks 401..575   (created <=575 so every task resolves by 600)
 *
 * Usage: node crisis-windows.mjs <comparison.json>
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const comparisonPath = process.argv[2];
if (!comparisonPath) throw new Error("usage: node crisis-windows.mjs <comparison.json>");
const comparison = JSON.parse(readFileSync(comparisonPath, "utf8"));

const WINDOWS = [
  { key: "W1 base", from: 1, to: 100 },
  { key: "W2 cr*2", from: 101, to: 200 },
  { key: "W3 bw/2", from: 201, to: 300 },
  { key: "W4 -20%", from: 301, to: 400 },
  { key: "W5 ld*4", from: 401, to: 575 },
];
const windowOf = (tick) => WINDOWS.find((w) => tick >= w.from && tick <= w.to)?.key;

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

// The comparison artifact names each arm's run; evidence lives next door in
// <data-root>/<universeId>/<runId>/events.jsonl.
const dataRoot = join(dirname(comparisonPath), "..", "..");
const rows = [];
for (const arm of comparison.arms) {
  const eventsPath = join(dataRoot, arm.universeId, arm.runId, "events.jsonl");
  const createdTickByTask = new Map();
  const perWindow = new Map(WINDOWS.map((w) => [w.key, {
    created: 0, accepted: 0, rejected: 0, expired: 0, latencies: [],
    creditsSpent: 0, violations: 0,
  }]));
  let retired = 0;
  const retireTicks = [];
  let finalAgents = null;

  for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
    if (!line) continue;
    const event = JSON.parse(line);
    const stats = perWindow.get(windowOf(event.tick));
    switch (event.type) {
      case "task.created": {
        const task = event.data.task;
        createdTickByTask.set(task.id, event.tick);
        if (stats) stats.created += 1;
        break;
      }
      case "task.evaluated": {
        const born = createdTickByTask.get(event.data.taskId);
        const bornStats = perWindow.get(windowOf(born));
        if (!bornStats) break;
        if (event.data.accepted) {
          bornStats.accepted += 1;
          bornStats.latencies.push(event.data.latencyTicks);
        } else {
          bornStats.rejected += 1;
        }
        break;
      }
      case "task.expired": {
        const born = createdTickByTask.get(event.data.taskId);
        const bornStats = perWindow.get(windowOf(born));
        if (bornStats) bornStats.expired += 1;
        break;
      }
      case "resource.spent":
        if (stats) stats.creditsSpent += event.data.cost?.credits ?? 0;
        break;
      case "violation.recorded":
        if (stats) stats.violations += 1;
        break;
      case "agent.retired":
        retired += 1;
        retireTicks.push(event.tick);
        break;
      case "metrics.recorded":
        finalAgents = event.data.metrics?.activeAgents ?? finalAgents;
        break;
      default:
        break;
    }
  }

  for (const w of WINDOWS) {
    const s = perWindow.get(w.key);
    const sorted = [...s.latencies].sort((a, b) => a - b);
    rows.push({
      arm: arm.arm,
      window: w.key,
      created: s.created,
      accepted: s.accepted,
      rejected: s.rejected,
      expired: s.expired,
      unresolved: s.created - s.accepted - s.rejected - s.expired,
      successPct: s.created === 0 ? null : Math.round((s.accepted / s.created) * 1000) / 10,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      creditsPerAccepted: s.accepted === 0 ? null : Math.round((s.creditsSpent / s.accepted) * 100) / 100,
      violations: s.violations,
    });
  }
  console.error(`${arm.arm}: retired=${retired} at ticks [${retireTicks.join(",")}] finalAgents=${finalAgents}`);
}

console.log(JSON.stringify(rows, null, 1));
