import { hashValue } from "./canonical.js";
import { validateGenesisConfig } from "./config.js";
import { deterministicId } from "./ids.js";
import { LAB_SCHEMA_VERSION, type GenesisConfig, type RunManifest } from "./types.js";

export const LAB_ENGINE_VERSION = "genesis-logical-v1.1.0";
/**
 * Cognitive runs get their own identity on purpose. Evidence produced with a
 * model in the loop must never be mistaken for evidence a seed alone can
 * reproduce, and a verifier that regenerates the neutral decision stream must
 * refuse it rather than silently disagree.
 */
export const LAB_COGNITIVE_ENGINE_VERSION = "genesis-cognitive-v1.0.0";
export const LAB_POLICY_ID = "neutral-backpressure-v1";
/**
 * Control-arm policies (experiment plan §33). Registered here because the
 * manifest is the authority on which implementation identities evidence may
 * claim; the implementations live in baselines.ts.
 */
export const BASELINE_CENTRAL_DISPATCH_ID = "baseline-central-dispatch-v1";
export const BASELINE_FIXED_ROLES_ID = "baseline-fixed-roles-v1";
export const BASELINE_NO_LINKS_ID = "baseline-no-links-v1";
export const LAB_BASELINE_POLICY_IDS: readonly string[] = Object.freeze([
  BASELINE_CENTRAL_DISPATCH_ID,
  BASELINE_FIXED_ROLES_ID,
  BASELINE_NO_LINKS_ID,
]);
/** `cohort-a-…` through `cohort-c-…`, as built by `CohortPolicy`. */
const COHORT_POLICY_PATTERN = /^cohort-[abc]-neutral-backpressure-v1$/;
export const LAB_TASK_GENERATOR_ID = "deterministic-task-stream-v1";

export interface RunManifestOptions {
  policyId?: string;
  mode?: "logical" | "cognitive";
}

/** Fail closed when evidence targets semantics other than this exact projector. */
export function assertLabManifestImplementation(manifest: RunManifest): void {
  if (typeof manifest.experimentId !== "string" || manifest.experimentId.length === 0) {
    throw new Error("Lab manifest experimentId must be a non-empty string");
  }
  if (typeof manifest.runId !== "string" || manifest.runId.length === 0) {
    throw new Error("Lab manifest runId must be a non-empty string");
  }
  if (typeof manifest.universeId !== "string" || !/^U[0-9]{4,8}$/.test(manifest.universeId)) {
    throw new Error("Lab manifest universeId is invalid");
  }
  if (typeof manifest.seed !== "string" || manifest.seed.trim().length === 0) {
    throw new Error("Lab manifest seed must be a non-empty string");
  }
  if (typeof manifest.configHash !== "string" || !/^[a-f0-9]{64}$/.test(manifest.configHash)) {
    throw new Error("Lab manifest configHash must be a lowercase SHA-256 digest");
  }
  if (manifest.schemaVersion !== LAB_SCHEMA_VERSION) {
    throw new Error(`Unsupported lab manifest schemaVersion ${String(manifest.schemaVersion)}`);
  }
  const cognitive = manifest.mode === "cognitive";
  const expectedEngine = cognitive ? LAB_COGNITIVE_ENGINE_VERSION : LAB_ENGINE_VERSION;
  if (manifest.engineVersion !== expectedEngine) {
    throw new Error(`Unsupported lab engineVersion ${manifest.engineVersion}; expected ${expectedEngine}`);
  }
  if (manifest.mode !== "logical" && !cognitive) {
    throw new Error(`Unsupported lab execution mode ${String(manifest.mode)}`);
  }
  // A cognitive run is steered by recorded answers, so its policy is a cohort
  // wrapper. A logical run must remain exactly the neutral policy.
  const policyValid = cognitive
    ? COHORT_POLICY_PATTERN.test(manifest.policyId)
    : manifest.policyId === LAB_POLICY_ID || LAB_BASELINE_POLICY_IDS.includes(manifest.policyId);
  if (!policyValid) {
    throw new Error(
      `Unsupported lab policyId ${manifest.policyId}; expected ${cognitive ? "a cohort policy" : LAB_POLICY_ID}`,
    );
  }
  if (manifest.taskGeneratorId !== LAB_TASK_GENERATOR_ID) {
    throw new Error(
      `Unsupported lab taskGeneratorId ${manifest.taskGeneratorId}; expected ${LAB_TASK_GENERATOR_ID}`,
    );
  }
}

export function createRunManifest(
  config: GenesisConfig,
  universeId: string,
  options: RunManifestOptions = {},
): RunManifest {
  validateGenesisConfig(config);
  if (!/^U[0-9]{4,8}$/.test(universeId)) {
    throw new Error("Universe id must match U0001-style notation");
  }
  const policyId = options.policyId ?? LAB_POLICY_ID;
  if (typeof policyId !== "string" || policyId.length === 0 || policyId.length > 128) {
    throw new Error("Policy id must be a non-empty string of at most 128 characters");
  }
  const mode = options.mode ?? "logical";
  const configHash = hashValue(config);
  // The implementation is hashed into the run id, so a cognitive run can never
  // collide with the logical run that shares its seed and config.
  const implementation = {
    engineVersion: mode === "cognitive" ? LAB_COGNITIVE_ENGINE_VERSION : LAB_ENGINE_VERSION,
    mode,
    policyId,
    taskGeneratorId: LAB_TASK_GENERATOR_ID,
  };
  return {
    schemaVersion: config.schemaVersion,
    experimentId: config.experimentId,
    ...implementation,
    runId: deterministicId(
      "run",
      config.experimentId,
      universeId,
      config.seed,
      configHash,
      hashValue(implementation),
    ).replace(":", "-"),
    universeId,
    seed: config.seed,
    configHash,
  };
}

export function populationSeed(baseSeed: string, universeId: string): string {
  if (!baseSeed) throw new Error("Population seed must not be empty");
  if (!/^U[0-9]{4,8}$/.test(universeId)) throw new Error("Invalid population universe id");
  return deterministicId("seed", baseSeed, universeId);
}
