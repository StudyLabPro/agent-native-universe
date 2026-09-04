/**
 * The evaluator port and recorded verdicts (design §4.F, phase L3b).
 *
 * A calibration task carries a hidden oracle, so `IndependentEvaluator` can
 * grade it exactly and a replay can regenerate the grade. Recorded external
 * work has no oracle: someone — a grader model, or an operator writing
 * `verdicts/inbox.jsonl` — has to say how good the answer was. That judgement
 * is not reproducible, so it enters the chain the same way a model's answer
 * does: verbatim, as a state-neutral `verdict.recorded` event committed
 * BEFORE the `task.evaluated` it justifies. Replay reads the recorded verdict
 * and never asks a grader again.
 *
 * The verifier checks a verdict by form (`evaluatorId` is the manifest's,
 * `qualityPpm ∈ [0, PPM]`, the verdict precedes its evaluation) — the same
 * treatment `cognition.recorded` gets, for the same reason.
 */
import { canonicalJson, sha256Hex } from "../canonical.js";
import type { CompletionLike } from "../cognition.js";
import type { LiveEvaluationRequest, LiveEvaluatorPort, LiveVerdict } from "../live-ports.js";
import { PPM } from "../types.js";
import {
  RecordedInputError,
  assertKnownFields,
  assertNotAddressed,
  readInbox,
  requiredInboxString,
} from "./recorded-inbox.js";

/**
 * The evaluator identity of an epoch that grades nothing but calibration work.
 * A universe with no recorded work still needs an identity in its manifest, so
 * the absence of a grader is itself named rather than left blank. It lives in
 * `manifest.ts`, where the live identity is defined, and is re-exported here
 * because this is where the evaluator ports are.
 */
export { LAB_LIVE_ORACLE_EVALUATOR_ID as LIVE_ORACLE_EVALUATOR_ID } from "../manifest.js";
/** Identity prefix of the file-backed verdict inbox. */
export const LIVE_VERDICT_INBOX_ID = "verdict-inbox-v1";
/** The inbox path, relative to the universe root. */
export const LIVE_VERDICT_INBOX_SEGMENTS: readonly string[] = Object.freeze(["verdicts", "inbox.jsonl"]);
/** A grader's answer is bounded like every other recorded input. */
export const LIVE_VERDICT_CONTENT_MAX_BYTES = 65_536;

const VERDICT_RECORD_FIELDS: readonly string[] = Object.freeze([
  "taskId", "qualityPpm", "content", "rationale",
]);

export function assertQualityPpm(value: unknown, what: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > PPM) {
    throw new RecordedInputError(`${what} requires an integer qualityPpm in [0, ${PPM}]`);
  }
  return value as number;
}

/** Bound a grader's verbatim answer without changing what was said before the cut. */
export function truncateVerdictContent(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.byteLength <= LIVE_VERDICT_CONTENT_MAX_BYTES) return content;
  return new TextDecoder("utf8", { fatal: false })
    .decode(bytes.subarray(0, LIVE_VERDICT_CONTENT_MAX_BYTES));
}

/**
 * `verdicts/inbox.jsonl`: one recorded judgement per external task, re-read
 * every time it is needed (see `FileTaskSource` for why there is no cursor).
 */
export class InboxEvaluator implements LiveEvaluatorPort {
  readonly id: string;
  readonly #path: string;

  constructor(path: string, id = LIVE_VERDICT_INBOX_ID) {
    this.#path = path;
    this.id = id;
  }

  async evaluate(request: LiveEvaluationRequest): Promise<LiveVerdict> {
    const records = await readInbox(this.#path, "The verdict inbox");
    for (const record of records) {
      assertNotAddressed(record, "A verdict record");
      assertKnownFields(record, VERDICT_RECORD_FIELDS, "A verdict record");
      if (requiredInboxString(record, "taskId", "A verdict record") !== request.task.id) continue;
      return {
        evaluatorId: this.id,
        content: truncateVerdictContent(requiredInboxString(record, "content", "A verdict record")),
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        qualityPpm: assertQualityPpm(record.qualityPpm, "A verdict record"),
      };
    }
    // No recorded judgement is a judgement of zero, recorded as such: the task
    // is closed with no reward instead of hanging until its deadline.
    return {
      evaluatorId: this.id,
      content: canonicalJson({ qualityPpm: 0, rationale: "no recorded verdict" }),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      qualityPpm: 0,
    };
  }
}

export interface LlmEvaluatorOptions {
  completion: CompletionLike;
  /** Grader model, e.g. `gpt-oss-120b`. Part of the evaluator identity. */
  model: string;
  /** Hashed into the identity alongside the model, like the cognition prompt is. */
  promptVersion?: string;
  maxTokens?: number;
  /** Provider-specific body, e.g. `{ reasoning_effort: "low" }`. */
  extraBody?: Record<string, unknown>;
}

const GRADER_SYSTEM_PROMPT = [
  "You grade one answer against one rubric and reply with JSON only.",
  'Reply exactly: {"qualityPpm": <integer 0..1000000>, "rationale": "<one sentence>"}.',
  "qualityPpm is parts per million: 0 = worthless, 1000000 = fully satisfies the rubric.",
  "Grade only against the rubric. Never mention the agent, never assign further work.",
].join(" ");

/**
 * A grader model behind the same completion surface the cognition port uses,
 * so it goes through the same gateway, the same budget and the same audit.
 *
 * `temperature: 0` and a pinned model make the grader as repeatable as a
 * provider can be — but the world does not rely on that: the answer is
 * recorded verbatim and replay reads the record, never the grader.
 */
export class LlmEvaluator implements LiveEvaluatorPort {
  readonly id: string;
  readonly #options: LlmEvaluatorOptions;

  constructor(options: LlmEvaluatorOptions) {
    if (typeof options.model !== "string" || options.model.trim().length === 0) {
      throw new Error("An LLM evaluator requires a model");
    }
    this.#options = options;
    const digest = sha256Hex(canonicalJson({
      model: options.model,
      promptVersion: options.promptVersion ?? "grader-v1",
      prompt: GRADER_SYSTEM_PROMPT,
      maxTokens: options.maxTokens ?? 512,
      extraBody: options.extraBody ?? {},
    })).slice(0, 24);
    this.id = `evaluator-llm-v1:${options.model}:${digest}`;
  }

  async evaluate(request: LiveEvaluationRequest, signal?: AbortSignal): Promise<LiveVerdict> {
    const input = request.task.input as { prompt?: unknown; rubric?: unknown } | null;
    const response = await this.#options.completion.complete(
      {
        messages: [
          { role: "system", content: GRADER_SYSTEM_PROMPT },
          {
            role: "user",
            content: canonicalJson({
              task: String((input as { prompt?: unknown } | null)?.prompt ?? ""),
              rubric: String((input as { rubric?: unknown } | null)?.rubric ?? ""),
              answer: request.submission.result,
            }),
          },
        ],
        temperature: 0,
        maxTokens: this.#options.maxTokens ?? 512,
        responseFormat: "json",
        ...(this.#options.extraBody === undefined
          ? {}
          : { extra: this.#options.extraBody as Record<string, never> }),
      },
      { require: ["chat", "json"] },
      signal,
    );
    const content = truncateVerdictContent(response.content);
    return {
      evaluatorId: this.id,
      content,
      usage: {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        totalTokens: response.usage.totalTokens,
      },
      qualityPpm: parseGraderQuality(content),
    };
  }
}

/**
 * Read the grade out of a grader's answer. An answer that cannot be parsed is
 * a grade of zero, not a crash: an unusable verdict must close the task, and
 * the unparsable answer stays on record verbatim so the failure is visible.
 */
export function parseGraderQuality(content: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(content));
  } catch {
    return 0;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return 0;
  const value = (parsed as { qualityPpm?: unknown }).qualityPpm;
  if (!Number.isSafeInteger(value)) return 0;
  return Math.min(PPM, Math.max(0, value as number));
}

function extractJsonObject(content: string): string {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) return content;
  return content.slice(start, end + 1);
}
