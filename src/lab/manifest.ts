import { hashValue } from "./canonical.js";
import { validateGenesisConfig } from "./config.js";
import { deterministicId } from "./ids.js";
import {
  LAB_LIVE_CANARY_EXPERIMENT_ID,
  LAB_LIVE_EXPERIMENT_ID,
  LAB_SCHEMA_VERSION,
  isLabExperimentId,
  type GenesisConfig,
  type LabRunMode,
  type RunManifest,
} from "./types.js";

export const LAB_ENGINE_VERSION = "genesis-logical-v1.1.0";
/**
 * Cognitive runs get their own identity on purpose. Evidence produced with a
 * model in the loop must never be mistaken for evidence a seed alone can
 * reproduce, and a verifier that regenerates the neutral decision stream must
 * refuse it rather than silently disagree.
 *
 * v1.1.0: the manifest carries `cognitionId` and hashes it into the runId, so
 * consulting a different model, endpoint or consultation budget can never
 * collide with — and silently recover — a run made with another one. v1.0.0
 * evidence lacked that binding and is refused rather than reinterpreted.
 *
 * v1.2.0 (phase L2): resume of a cognitive (cohort) run is now sound.
 * `CohortPolicy` exposes `checkpoint()`/`restore()` (delegated to its inner
 * `NeutralPolicy`, which owns the RNG streams), and the evaluator's oracle
 * map — previously never rebuilt on restore, so a resumed run with any open
 * task failed every evaluation with "No oracle registered" — is now
 * reconstructed in memory from a replay of the event stream before the
 * resumed universe runs its first tick. Evidence made with v1.1.0 is refused
 * rather than reinterpreted: it was produced by an engine that could not
 * resume soundly, and a v1.2.0 verifier must not silently vouch for it.
 */
export const LAB_COGNITIVE_ENGINE_VERSION = "genesis-cognitive-v1.2.0";
/**
 * Genesis-Live epochs carry a third engine identity. A live run is neither
 * seed-reproducible nor a cohort of the scientific track: every non-seed
 * input is a recorded input, epochs chain through `configHash`, and the
 * experiment identity is `genesis-live` only. The identity is registered
 * here so that engines which do not implement live semantics refuse such
 * evidence fail-closed instead of projecting it as logical or cognitive.
 */
export const LAB_LIVE_ENGINE_VERSION = "genesis-live-v1.0.0";
export const LAB_POLICY_ID = "neutral-backpressure-v1";
/**
 * The live policy literal. Cohort `C` = external model, which is honest: in a
 * live epoch the recorded answers steer every steered agent and an unsteered
 * agent idles (`LiveIdlePolicy`, phase L2) instead of falling back to the
 * neutral solver. The pattern is accepted only under `mode: "live"`.
 */
export const LAB_LIVE_POLICY_ID = "cohort-c-live-idle-v1";
export const LAB_LIVE_POLICY_PATTERN = /^cohort-c-live-idle-v1$/;
/** Recorded-input task source of live epochs (calibration stream + inboxes). */
export const LAB_LIVE_TASK_SOURCE_ID = "live-task-source-v1";
/**
 * The evaluator identity of a live epoch that grades nothing but calibration
 * work — the hidden oracle, named rather than left blank. It is the default of
 * `RunManifestOptions.evaluatorId` in live mode, so the identity is always
 * present in the manifest and always hashed into the runId; an epoch that
 * grades recorded work names its grader instead (phase L3b).
 */
export const LAB_LIVE_ORACLE_EVALUATOR_ID = "oracle-evaluator-v1";
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
  mode?: LabRunMode;
  /**
   * Identity of the cognition port a cognitive or live run consults (model,
   * endpoint, consultation budget). Required in cognitive and live mode and
   * hashed into the runId; forbidden in logical mode, where no such treatment
   * exists.
   */
  cognitionId?: string;
  /**
   * Identity of the evaluator that graded recorded work (grader model or
   * verdict inbox). Required in live mode and hashed into the runId; forbidden
   * everywhere else, where every evaluation is the hidden-oracle one.
   */
  evaluatorId?: string;
}

/**
 * Identity coupling between experiment and mode. `genesis-live` evidence is
 * live and only live; the canary is the cognitive cohort path under its own
 * name and is never a logical arm; the scientific track never runs live.
 */
export function assertExperimentModeCoupling(experimentId: string, mode: LabRunMode): void {
  if (!isLabExperimentId(experimentId)) {
    throw new Error(`Unsupported experiment ${experimentId}`);
  }
  if ((experimentId === LAB_LIVE_EXPERIMENT_ID) !== (mode === "live")) {
    throw new Error(
      `Experiment ${experimentId} cannot run in mode ${mode}: mode live and experiment ${LAB_LIVE_EXPERIMENT_ID} imply each other`,
    );
  }
  if (experimentId === LAB_LIVE_CANARY_EXPERIMENT_ID && mode !== "cognitive") {
    throw new Error(
      `Experiment ${experimentId} is an engineering canary of the cognitive cohort path and cannot run in mode ${mode}`,
    );
  }
}

function assertValidCognitionId(cognitionId: string): void {
  if (
    typeof cognitionId !== "string"
    || cognitionId.length === 0
    || cognitionId.length > 128
    || /[\u0000-\u001F\u007F]/.test(cognitionId)
  ) {
    throw new Error("Cognition id must be a non-empty control-character-free string of at most 128 characters");
  }
}

function assertValidEvaluatorId(evaluatorId: string): void {
  if (
    typeof evaluatorId !== "string"
    || evaluatorId.length === 0
    || evaluatorId.length > 128
    || /[\u0000-\u001F\u007F]/.test(evaluatorId)
  ) {
    throw new Error("Evaluator id must be a non-empty control-character-free string of at most 128 characters");
  }
}

export interface LabManifestProjectionOptions {
  /**
   * Accept `mode: "live"` evidence. Only the Genesis-Live engine passes this
   * (`src/lab/live/epoch.ts` through `replay.ts`, `protocol-verifier.ts`,
   * `world.ts` and `artifacts.ts`); every scientific reader — the CLI
   * `replay`/`attest`/`verify-attestation` commands, evidence discovery,
   * populations, baselines and the Pareto readout — calls this function
   * without it and therefore keeps refusing a live manifest fail-closed.
   */
  live?: boolean;
}

/** Fail closed when evidence targets semantics other than this exact projector. */
export function assertLabManifestImplementation(
  manifest: RunManifest,
  options: LabManifestProjectionOptions = {},
): void {
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
  if (!isLabExperimentId(manifest.experimentId)) {
    throw new Error(`Unsupported lab experimentId ${manifest.experimentId}`);
  }
  // Genesis-Live evidence is refused by this projector unless the caller is
  // the live engine itself: a live epoch is steered by recorded inputs that
  // the logical and cognitive verifiers do not know how to regenerate or
  // accept, so projecting it there would either fail late or, worse, silently
  // reinterpret it.
  if (manifest.mode === "live") {
    if (options.live !== true) {
      throw new Error(
        `Unsupported lab execution mode live: engine ${LAB_LIVE_ENGINE_VERSION} evidence is not projectable by this build`,
      );
    }
    if (manifest.engineVersion !== LAB_LIVE_ENGINE_VERSION) {
      throw new Error(`Unsupported lab engineVersion ${manifest.engineVersion}; expected ${LAB_LIVE_ENGINE_VERSION}`);
    }
    assertExperimentModeCoupling(manifest.experimentId, manifest.mode);
    if (!LAB_LIVE_POLICY_PATTERN.test(manifest.policyId)) {
      throw new Error(`Unsupported lab policyId ${manifest.policyId}; expected ${LAB_LIVE_POLICY_ID}`);
    }
    if (manifest.taskGeneratorId !== LAB_LIVE_TASK_SOURCE_ID) {
      throw new Error(
        `Unsupported lab taskGeneratorId ${manifest.taskGeneratorId}; expected ${LAB_LIVE_TASK_SOURCE_ID}`,
      );
    }
    assertValidCognitionId(manifest.cognitionId as string);
    // A verdict is a recorded input exactly like a model answer, so the port
    // that produced it is part of what the evidence claims.
    assertValidEvaluatorId(manifest.evaluatorId as string);
    return;
  }
  const cognitive = manifest.mode === "cognitive";
  const expectedEngine = cognitive ? LAB_COGNITIVE_ENGINE_VERSION : LAB_ENGINE_VERSION;
  if (manifest.engineVersion !== expectedEngine) {
    throw new Error(`Unsupported lab engineVersion ${manifest.engineVersion}; expected ${expectedEngine}`);
  }
  if (manifest.mode !== "logical" && !cognitive) {
    throw new Error(`Unsupported lab execution mode ${String(manifest.mode)}`);
  }
  assertExperimentModeCoupling(manifest.experimentId, manifest.mode);
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
  // The consulted model is part of what the evidence claims. A cognitive
  // manifest without it could silently stand in for a run of any model.
  if (cognitive) {
    assertValidCognitionId(manifest.cognitionId as string);
  } else if (manifest.cognitionId !== undefined) {
    throw new Error("A logical manifest must not carry a cognitionId");
  }
  if (manifest.evaluatorId !== undefined) {
    throw new Error("Only a live manifest carries an evaluatorId; every other run uses the hidden oracle");
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
  const mode = options.mode ?? "logical";
  const live = mode === "live";
  const policyId = options.policyId ?? (live ? LAB_LIVE_POLICY_ID : LAB_POLICY_ID);
  if (typeof policyId !== "string" || policyId.length === 0 || policyId.length > 128) {
    throw new Error("Policy id must be a non-empty string of at most 128 characters");
  }
  if (mode === "cognitive" || live) {
    assertValidCognitionId(options.cognitionId as string);
  } else if (options.cognitionId !== undefined) {
    throw new Error("A logical run manifest must not carry a cognitionId");
  }
  const evaluatorId = live ? options.evaluatorId ?? LAB_LIVE_ORACLE_EVALUATOR_ID : undefined;
  if (live) {
    assertValidEvaluatorId(evaluatorId as string);
  } else if (options.evaluatorId !== undefined) {
    throw new Error("Only a live run manifest carries an evaluatorId");
  }
  // The live policy literal is accepted only in live mode, and a live epoch
  // accepts only it: neither a neutral solver nor a baseline may steer Live.
  if (live !== LAB_LIVE_POLICY_PATTERN.test(policyId)) {
    throw new Error(
      live
        ? `A live run manifest requires policy ${LAB_LIVE_POLICY_ID}; got ${policyId}`
        : `Policy ${policyId} is reserved for mode live`,
    );
  }
  assertExperimentModeCoupling(config.experimentId, mode);
  const configHash = hashValue(config);
  // The implementation is hashed into the run id, so a cognitive run can never
  // collide with the logical run that shares its seed and config — nor with a
  // cognitive run that consulted a different model or consultation budget.
  const implementation = {
    engineVersion: live
      ? LAB_LIVE_ENGINE_VERSION
      : mode === "cognitive" ? LAB_COGNITIVE_ENGINE_VERSION : LAB_ENGINE_VERSION,
    mode,
    policyId,
    taskGeneratorId: live ? LAB_LIVE_TASK_SOURCE_ID : LAB_TASK_GENERATOR_ID,
    ...(options.cognitionId === undefined ? {} : { cognitionId: options.cognitionId }),
    ...(evaluatorId === undefined ? {} : { evaluatorId }),
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
