/**
 * Aggregate several §33 comparisons (one per seed) into one readout, and test
 * the arm-F capacity model quantitatively.
 *
 * The model: a solver's task cycle is 3 ticks, arm F freezes the verifier
 * slots N0004/N0008/N0012/N0016, so after the tick-300 retirement the arm
 * sustains (surviving solvers)/3 tasks per tick against the ×4 demand of 4.0.
 * A task expires 25 ticks after creation, so the deficit is observable over
 * ~175 ticks — predicted expiries = max(0, 4 − solvers/3) × 175.
 *
 * Usage: node experiments/genesis-1/aggregate-arms.mjs <comparison.json>...
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";

const VERIFIERS = new Set(["N0004", "N0008", "N0012", "N0016"]);

async function scanEvents(path) {
  const createdTick = new Map();
  let expired = 0;
  const retired = [];
  const w5 = { created: 0, accepted: 0 };
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    const event = JSON.parse(line);
    switch (event.type) {
      case "task.created":
        createdTick.set(event.data.task.id, event.tick);
        if (event.tick >= 401 && event.tick <= 575) w5.created += 1;
        break;
      case "task.evaluated":
        if (event.data.accepted) {
          const born = createdTick.get(event.data.taskId) ?? 0;
          if (born >= 401 && born <= 575) w5.accepted += 1;
        }
        break;
      case "task.expired":
        expired += 1;
        break;
      case "agent.retired":
        retired.push(event.data.agentId);
        break;
      default:
        break;
    }
  }
  return { expired, retired, w5 };
}

const rows = [];
for (const comparisonPath of process.argv.slice(2)) {
  const { seed, arms } = (() => {
    const parsed = JSON.parse(readFileSync(comparisonPath, "utf8"));
    const comparison = parsed.comparison ?? parsed;
    return { seed: comparison.seed, arms: comparison.arms };
  })();
  const dataRoot = join(dirname(comparisonPath), "..", "..");
  for (const arm of arms) {
    const { expired, retired, w5 } = await scanEvents(
      join(dataRoot, arm.universeId, arm.runId, "events.jsonl"),
    );
    const row = {
      seed,
      arm: arm.arm,
      successPct: arm.metrics.taskSuccessRatePpm / 10_000,
      w5Pct: w5.created === 0 ? null : Math.round((1000 * w5.accepted) / w5.created) / 10,
      p95: arm.metrics.p95LatencyTicks,
      expired,
    };
    if (arm.arm === "F") {
      const solversLost = retired.filter((id) => !VERIFIERS.has(id)).length;
      const solversLeft = 12 - solversLost;
      row.retired = retired;
      row.solversLeft = solversLeft;
      row.predictedExpiries = Math.round(Math.max(0, 4 - solversLeft / 3) * 175);
    }
    rows.push(row);
  }
}

console.log(JSON.stringify(rows, null, 1));
