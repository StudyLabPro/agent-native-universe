/**
 * Runs a Genesis-Live universe in its own process and kills that process with
 * SIGKILL at a named point, so the boundary tests can assert what a real
 * `kill -9` leaves on disk rather than simulating it.
 *
 * ANU_LIVE_CRASH_ROOT   evidence root
 * ANU_LIVE_CRASH_EPOCHS how many epochs to attempt
 * ANU_LIVE_CRASH_AT     "checkpoint:<absoluteTick>" | "step:<boundaryStep>:<epoch>"
 *                       (omitted: run to completion)
 */
import { runLiveUniverse } from "../dist/lab/live/epoch.js";
import { liveTestConfig, scriptedLiveCognition } from "./live-fixture.mjs";

const root = process.env.ANU_LIVE_CRASH_ROOT;
const epochs = Number(process.env.ANU_LIVE_CRASH_EPOCHS ?? "2");
const crashAt = process.env.ANU_LIVE_CRASH_AT ?? "";
if (!root) {
  process.stderr.write("ANU_LIVE_CRASH_ROOT is required\n");
  process.exit(2);
}

const die = () => {
  // No flush, no cleanup, no lease release: exactly what a power loss leaves.
  process.kill(process.pid, "SIGKILL");
};

await runLiveUniverse({
  dataRoot: root,
  config: liveTestConfig(),
  cognition: scriptedLiveCognition(),
  epochs,
  recoverStaleLease: true,
  hooks: {
    onCheckpoint(checkpoint) {
      if (crashAt === `checkpoint:${checkpoint.tick}`) die();
    },
    onBoundaryStep(step, context) {
      if (crashAt === `step:${step}:${context.epoch}`) die();
    },
  },
});
process.stdout.write("completed\n");
