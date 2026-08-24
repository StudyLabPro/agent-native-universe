import type { JsonObject, JsonValue } from "../core/types.js";
import { executeCapabilityPlan, validateCapabilityPublication } from "./capability-registry.js";
import { hashValue } from "./canonical.js";
import { deterministicId } from "./ids.js";
import {
  LAB_SCHEMA_VERSION,
  PPM,
  ZERO_RESOURCES,
  type CapabilityInvocationState,
  type CapabilityPlanStep,
  type CapabilityState,
  type LabAgentState,
  type LabEvent,
  type LabLinkState,
  type LabTaskState,
  type MetricsSnapshot,
  type MessageState,
  type PhysicsState,
  type PrimitiveActionType,
  type ResourceKind,
  type ResourceVector,
  type RunManifest,
  type SubmissionState,
  type TaskFamily,
  type VerificationState,
  type WorldState,
} from "./types.js";

const RESOURCE_KINDS: readonly ResourceKind[] = [
  "credits", "llmTokens", "computeMs", "storageBytes", "bandwidthBytes",
];

const ACTION_TYPES = new Set<PrimitiveActionType>([
  "observe", "reason", "send", "connect", "disconnect", "store", "retrieve", "execute", "verify",
  "spawn", "clone", "merge", "reserve", "transfer", "trade", "publishCapability", "useCapability",
  "claimTask", "submit",
]);

const TASK_FAMILIES = new Set<TaskFamily>([
  "arithmetic", "json_transform", "memory_recall", "correlation", "verification", "multi_step",
  "concurrency", "state_recovery",
]);

const WORLD_VERSIONS = new WeakMap<WorldState, number>();

export interface PreparedWorldTransition {
  readonly seq: number;
  readonly hash: string;
  /** Apply exactly once to the state against which this transition was prepared. */
  apply(committed: LabEvent): WorldState;
}

export function initialWorldState(manifest: RunManifest): WorldState {
  if (manifest.schemaVersion !== LAB_SCHEMA_VERSION) throw new Error("Unsupported lab manifest schema version");
  return {
    schemaVersion: LAB_SCHEMA_VERSION,
    runId: manifest.runId,
    universeId: manifest.universeId,
    configHash: manifest.configHash,
    seed: manifest.seed,
    tick: 0,
    started: false,
    agents: {},
    links: {},
    tasks: {},
    submissions: {},
    submissionOrder: [],
    verifications: {},
    messages: {},
    capabilities: {},
    capabilityInvocations: {},
    physics: defaultPhysics(),
    treasury: cloneResources(ZERO_RESOURCES),
    resourceSpent: cloneResources(ZERO_RESOURCES),
    metrics: [],
    completed: false,
  };
}

/**
 * Validate and prepare one atomic world transition without mutating `state`.
 *
 * All parsing, referential checks and resource arithmetic happen here. The
 * returned one-shot apply step only publishes values that have already been
 * proven valid, so callers can append the event after preflight and mutate the
 * live projection only after the append succeeds.
 */
export function prepareWorldEventTransition(
  state: WorldState,
  event: LabEvent,
): PreparedWorldTransition {
  if (state.schemaVersion !== LAB_SCHEMA_VERSION || event.schemaVersion !== LAB_SCHEMA_VERSION) {
    throw new Error("Unsupported lab schema version");
  }
  if (event.runId !== state.runId || event.universeId !== state.universeId) {
    throw new Error(`Event ${event.seq} belongs to another world`);
  }
  if (event.tick < state.tick) throw new Error(`Event ${event.seq} moves world time backwards`);
  if (state.completed) throw new Error(`Cannot apply event ${event.seq} after run completion`);
  if (event.type !== "run.started" && !state.started) {
    throw new Error(`Event ${event.seq} cannot precede run.started`);
  }

  const preparedVersion = WORLD_VERSIONS.get(state) ?? 0;
  const data = event.data;
  let mutation: () => void;

  switch (event.type) {
    case "run.started": {
      if (event.seq !== 1 || event.tick !== 0 || event.phase !== "genesis") {
        throw new Error("run.started must be the first genesis event at tick 0");
      }
      assertSystemEvent(event, "run.started");
      if (state.started) throw new Error("run.started cannot be applied more than once");
      const treasury = optionalRecord(data.treasury);
      const physics = optionalRecord(data.physics);
      const preparedTreasury = treasury
        ? parseResources(treasury, "run.started treasury")
        : undefined;
      const preparedPhysics = physics ? parsePhysics(physics, state.physics) : undefined;
      mutation = () => {
        state.started = true;
        if (preparedTreasury) state.treasury = preparedTreasury;
        if (preparedPhysics) state.physics = preparedPhysics;
      };
      break;
    }
    case "agent.created": {
      const agent = parseAgent(optionalRecord(data.agent) ?? data, event);
      if (event.seq <= 1) throw new Error("agent.created must follow the seq-1 run.started event");
      if (event.tick !== 0 || event.phase !== "genesis") {
        throw new Error("agent.created is restricted to genesis tick 0");
      }
      if (event.actorId !== agent.id) throw new Error("agent.created actorId must match the agent id");
      if (event.targetId !== undefined || event.causationId !== undefined) {
        throw new Error("agent.created cannot have targetId or causationId");
      }
      if (agent.createdTick !== 0) throw new Error("Genesis agents must have createdTick 0");
      if (state.agents[agent.id]) throw new Error(`Agent ${agent.id} already exists`);
      mutation = () => {
        state.agents[agent.id] = agent;
      };
      break;
    }
    case "agent.retired": {
      assertPhase(event, "pressure");
      const agentId = requireActorDataAgent(event);
      const agent = requireAgent(state, agentId);
      assertNoTarget(event, "agent.retired");
      if (!agent.active || agent.retiredTick !== undefined) {
        throw new Error(`Agent ${agent.id} is already inactive`);
      }
      const retiredTick = nonNegativeInteger(data.retiredTick, "retiredTick");
      if (retiredTick !== event.tick) throw new Error("retiredTick must equal the retirement event tick");
      if (data.reason !== "pressure") throw new Error("agent.retired requires reason pressure");
      requireCausation(event, "agent.retired");
      mutation = () => {
        agent.active = false;
        agent.retiredTick = retiredTick;
      };
      break;
    }
    case "task.created": {
      assertPhase(event, "task_generation");
      assertSystemEvent(event, "task.created");
      const task = parseTask(optionalRecord(data.task) ?? data);
      if (state.tasks[task.id]) throw new Error(`Task ${task.id} already exists`);
      if (!TASK_FAMILIES.has(task.family)) throw new Error(`Unknown task family ${task.family}`);
      if (task.status !== "available") throw new Error("New tasks must start available");
      if (task.createdTick !== event.tick) throw new Error("Task createdTick must equal the event tick");
      if (task.deadlineTick <= task.createdTick) throw new Error("Task deadlineTick must be after createdTick");
      if (
        task.claimedBy !== undefined
        || task.submittedBy !== undefined
        || task.completedTick !== undefined
        || task.evaluationEventId !== undefined
      ) {
        throw new Error("New tasks cannot contain lifecycle completion fields");
      }
      mutation = () => {
        state.tasks[task.id] = task;
      };
      break;
    }
    case "task.claimed": {
      assertPhase(event, "resolution");
      const task = requireTask(state, requiredString(data.taskId, "taskId"));
      const agentId = requireActorDataAgent(event);
      assertNoTarget(event, "task.claimed");
      requireCausation(event, "task.claimed");
      const agent = requireAgent(state, agentId);
      if (!agent.active) throw new Error(`Inactive agent ${agentId} cannot claim tasks`);
      if (task.status !== "available") throw new Error(`Task ${task.id} is ${task.status}, not available`);
      if (event.tick > task.deadlineTick) throw new Error(`Task ${task.id} is past its deadline`);
      mutation = () => {
        task.status = "claimed";
        task.claimedBy = agentId;
      };
      break;
    }
    case "task.submitted": {
      assertPhase(event, "resolution");
      const submission = parseSubmission(optionalRecord(data.submission) ?? data, event);
      if (state.submissions[submission.id]) throw new Error(`Submission ${submission.id} already exists`);
      const task = requireTask(state, submission.taskId);
      const agent = requireAgent(state, submission.agentId);
      assertNoTarget(event, "task.submitted");
      if (event.actorId !== submission.agentId) {
        throw new Error("task.submitted actorId must match submission.agentId");
      }
      requireCausation(event, "task.submitted");
      if (!agent.active) throw new Error(`Inactive agent ${submission.agentId} cannot submit tasks`);
      if (task.status !== "claimed") throw new Error(`Task ${task.id} is ${task.status}, not claimed`);
      if (task.claimedBy !== submission.agentId) {
        throw new Error(`Task ${task.id} is claimed by ${String(task.claimedBy)}, not ${submission.agentId}`);
      }
      if (event.tick > task.deadlineTick) throw new Error(`Task ${task.id} is past its deadline`);
      const expectedId = deterministicId("submission", state.runId, task.id, submission.agentId);
      if (submission.id !== expectedId) throw new Error("Submission id is not deterministic");
      mutation = () => {
        state.submissions[submission.id] = submission;
        state.submissionOrder.push(submission.id);
        task.status = "submitted";
        task.submittedBy = submission.agentId;
      };
      break;
    }
    case "task.evaluated": {
      assertPhase(event, "evaluation");
      const submission = requireSubmission(state, requiredString(data.submissionId, "submissionId"));
      const task = requireTask(state, requiredString(data.taskId, "taskId"));
      if (task.id !== submission.taskId) {
        throw new Error(`Evaluation task ${task.id} does not match submission ${submission.id}`);
      }
      if (task.status !== "submitted") throw new Error(`Task ${task.id} is ${task.status}, not submitted`);
      if (event.actorId !== submission.agentId || task.submittedBy !== submission.agentId) {
        throw new Error("task.evaluated actorId must match the submission owner");
      }
      if (event.targetId !== undefined) throw new Error("task.evaluated cannot target another participant");
      if (event.causationId !== submission.submittedEventId) {
        throw new Error("task.evaluated must be caused by its task.submitted event");
      }
      const accepted = requiredBoolean(data.accepted, "accepted");
      const qualityPpm = nonNegativeInteger(data.qualityPpm, "qualityPpm");
      if (qualityPpm > PPM) throw new Error("qualityPpm must not exceed 1,000,000");
      if (qualityPpm !== (accepted ? PPM : 0)) {
        throw new Error("Evaluation accepted and qualityPpm are inconsistent");
      }
      if (nonNegativeInteger(data.violations, "violations") !== 0) {
        throw new Error("Logical v1.1 evaluator violations must be zero");
      }
      const latencyTicks = nonNegativeInteger(data.latencyTicks, "latencyTicks");
      const completedTick = nonNegativeInteger(data.completedTick, "completedTick");
      if (completedTick !== event.tick) throw new Error("completedTick must equal the evaluation event tick");
      const expectedLatency = event.tick - task.createdTick;
      if (latencyTicks !== expectedLatency) {
        throw new Error(`Evaluation latency ${latencyTicks} does not match task age ${expectedLatency}`);
      }
      const agent = requireAgent(state, submission.agentId);
      const taskCount = incrementCounter(agent.taskCounts[task.family], `taskCounts.${task.family}`);
      const attempts = incrementCounter(agent.learning.attempts[task.family], `learning.attempts.${task.family}`);
      const successes = accepted
        ? incrementCounter(agent.learning.successes[task.family], `learning.successes.${task.family}`)
        : undefined;
      mutation = () => {
        submission.accepted = accepted;
        submission.qualityPpm = qualityPpm;
        submission.latencyTicks = latencyTicks;
        task.status = "completed";
        task.completedTick = completedTick;
        task.evaluationEventId = event.eventId;
        agent.taskCounts[task.family] = taskCount;
        agent.learning.attempts[task.family] = attempts;
        if (successes !== undefined) agent.learning.successes[task.family] = successes;
      };
      break;
    }
    case "submission.verified": {
      assertPhase(event, "resolution");
      const verification = parseVerification(optionalRecord(data.verification) ?? data, event);
      const submission = requireSubmission(state, verification.submissionId);
      const task = requireTask(state, submission.taskId);
      const verifier = requireAgent(state, verification.verifierId);
      if (event.actorId !== verifier.id || event.targetId !== submission.agentId) {
        throw new Error("Verification event participants do not match its verifier and submission owner");
      }
      if (!verifier.active) throw new Error(`Inactive agent ${verifier.id} cannot verify submissions`);
      if (submission.agentId === verifier.id) throw new Error("Agents cannot verify their own submissions");
      if (task.status !== "completed" || !task.evaluationEventId) {
        throw new Error("Only completed, evaluated tasks can be verified");
      }
      requireCausation(event, "submission.verified");
      const duplicate = Object.values(state.verifications).some((candidate) => (
        candidate.submissionId === submission.id && candidate.verifierId === verifier.id
      ));
      if (duplicate || state.verifications[verification.id]) {
        throw new Error(`Submission ${submission.id} is already verified by ${verifier.id}`);
      }
      const expectedId = deterministicId("verification", state.runId, submission.id, verifier.id);
      if (verification.id !== expectedId) throw new Error("Verification id is not deterministic");
      const matchesSubmission = hashValue(verification.computedResult) === hashValue(submission.result);
      if (verification.matchesSubmission !== matchesSubmission || verification.verdict !== matchesSubmission) {
        throw new Error("Verification verdict does not match the supplied independent result");
      }
      mutation = () => {
        state.verifications[verification.id] = verification;
      };
      break;
    }
    case "task.expired": {
      assertPhase(event, "task_generation");
      assertSystemEvent(event, "task.expired");
      const task = requireTask(state, requiredString(data.taskId, "taskId"));
      if (task.status !== "available" && task.status !== "claimed") {
        throw new Error(`Task ${task.id} in status ${task.status} cannot expire`);
      }
      if (event.tick <= task.deadlineTick) throw new Error(`Task ${task.id} cannot expire before its deadline passes`);
      mutation = () => {
        task.status = "expired";
      };
      break;
    }
    case "link.created": {
      assertPhase(event, "resolution");
      const link = parseLink(optionalRecord(data.link) ?? data, event);
      if (state.links[link.id]) throw new Error(`Link ${link.id} already exists`);
      if (link.left === link.right) throw new Error("Links require two distinct agents");
      const left = requireAgent(state, link.left);
      const right = requireAgent(state, link.right);
      if (!left.active || !right.active) throw new Error("Links require active participants");
      const [canonicalLeft, canonicalRight] = [link.left, link.right].sort();
      if (link.left !== canonicalLeft || link.right !== canonicalRight) {
        throw new Error("Link endpoints are not in deterministic order");
      }
      assertLinkParticipants(event, link, "link.created");
      requireCausation(event, "link.created");
      const expectedId = deterministicId("link", state.runId, canonicalLeft!, canonicalRight!);
      if (link.id !== expectedId) throw new Error("Link id is not deterministic");
      if (link.createdTick !== event.tick || link.lastUsedTick !== event.tick) {
        throw new Error("New link timestamps must equal the creation event tick");
      }
      if (link.strengthPpm !== PPM) throw new Error("New links must start at full strength");
      mutation = () => {
        state.links[link.id] = link;
      };
      break;
    }
    case "link.removed": {
      assertPhase(event, "resolution");
      const linkId = requiredString(data.linkId, "linkId");
      const link = requireLink(state, linkId);
      assertLinkParticipants(event, link, "link.removed");
      requireActiveActor(state, event, "link.removed");
      requireCausation(event, "link.removed");
      mutation = () => {
        delete state.links[linkId];
      };
      break;
    }
    case "link.used": {
      assertPhase(event, "resolution");
      assertExactKeys(data, ["linkId", "messageId"], "link.used data");
      const link = requireLink(state, requiredString(data.linkId, "linkId"));
      const message = requireMessage(state, requiredString(data.messageId, "messageId"));
      assertLinkParticipants(event, link, "link.used");
      if (message.linkId !== link.id) throw new Error("link.used does not match the message link");
      if (message.deliveredEventId === undefined || message.deliveredSeq === undefined) {
        throw new Error("link.used requires a delivered message");
      }
      if (message.linkUsedEventId !== undefined) throw new Error(`Message ${message.id} already used its link`);
      if (event.causationId !== message.deliveredEventId) {
        throw new Error("link.used must be caused by message.delivered");
      }
      if (event.seq !== message.deliveredSeq + 1 || event.tick !== message.deliveredTick) {
        throw new Error("link.used must immediately follow delivery in the same tick");
      }
      mutation = () => {
        link.lastUsedTick = event.tick;
        message.linkUsedEventId = event.eventId;
      };
      break;
    }
    case "resource.spent": {
      assertPhase(event, "resolution");
      const agentId = requireActorDataAgent(event);
      const agent = requireAgent(state, agentId);
      if (!agent.active) throw new Error(`Inactive agent ${agentId} cannot spend resources`);
      if (event.targetId !== undefined || event.causationId !== undefined) {
        throw new Error("resource.spent is a root action payment and cannot have targetId or causationId");
      }
      const resources = cloneResources(agent.resources);
      const treasury = cloneResources(state.treasury);
      const resourceSpent = cloneResources(state.resourceSpent);
      const cost = optionalRecord(data.cost);
      if (!cost) throw new Error("resource.spent requires a complete cost vector");
      const parsed = parseResources(cost, "resource cost");
      for (const kind of RESOURCE_KINDS) {
        debit(resources, kind, parsed[kind], agentId);
        credit(treasury, kind, parsed[kind]);
        credit(resourceSpent, kind, parsed[kind]);
      }
      const action = requiredAction(data.action, "resource.spent action");
      const actionCount = incrementCounter(agent.actionCounts[action], `actionCounts.${action}`);
      mutation = () => {
        assignResources(agent.resources, resources);
        assignResources(state.treasury, treasury);
        assignResources(state.resourceSpent, resourceSpent);
        agent.actionCounts[action] = actionCount;
      };
      break;
    }
    case "resource.transferred": {
      const fromId = requiredString(data.fromId, "fromId");
      const toId = requiredString(data.toId, "toId");
      if (event.actorId !== fromId || event.targetId !== toId) {
        throw new Error("resource.transferred actor/target must exactly match fromId/toId");
      }
      if (fromId === toId) throw new Error("Resources cannot be transferred to the same account");
      const resource = parseResourceKind(data.resource);
      const amount = positiveInteger(data.amount, "amount");
      const from = accountResources(state, fromId);
      const to = accountResources(state, toId);
      const reason = optionalString(data.reason);
      if (fromId === "@treasury") {
        assertPhase(event, "evaluation");
        if (reason !== "accepted-task") throw new Error("Treasury transfers require reason accepted-task");
        const task = requireTask(state, requiredString(data.taskId, "taskId"));
        if (task.status !== "completed" || task.evaluationEventId === undefined) {
          throw new Error("Task rewards require a completed evaluation");
        }
        if (event.causationId !== task.evaluationEventId) {
          throw new Error("Task reward must be caused by its task.evaluated event");
        }
        const submission = Object.values(state.submissions).find((candidate) => candidate.taskId === task.id);
        if (!submission?.accepted || submission.agentId !== toId) {
          throw new Error("Task reward recipient must own an accepted submission");
        }
        if (!requireAgent(state, toId).active) throw new Error("Task reward recipient must be active");
      } else {
        assertPhase(event, "resolution");
        if (reason !== undefined || data.taskId !== undefined) {
          throw new Error("Agent transfers cannot claim task-reward provenance");
        }
        const fromAgent = requireAgent(state, fromId);
        const toAgent = requireAgent(state, toId);
        if (!fromAgent.active || !toAgent.active) throw new Error("Agent transfers require active participants");
        requireCausation(event, "resource.transferred");
      }
      const fromResources = cloneResources(from);
      const toResources = cloneResources(to);
      debit(fromResources, resource, amount, fromId);
      credit(toResources, resource, amount);
      mutation = () => {
        assignResources(from, fromResources);
        assignResources(to, toResources);
      };
      break;
    }
    case "memory.stored": {
      assertPhase(event, "resolution");
      const agentId = requireActorDataAgent(event);
      const agent = requireAgent(state, agentId);
      assertNoTarget(event, "memory.stored");
      if (!agent.active) throw new Error(`Inactive agent ${agentId} cannot store memory`);
      requireCausation(event, "memory.stored");
      const key = requiredString(data.key, "key");
      const value = cloneJsonValue(requiredJsonValue(data.value, "value"));
      const action = requiredAction(data.action, "memory.stored action");
      if (action !== "store" && action !== "execute") {
        throw new Error("memory.stored action must be store or execute");
      }
      if (action === "execute") {
        const task = requireTask(state, requiredString(data.taskId, "taskId"));
        if (task.status !== "claimed" || task.claimedBy !== agent.id) {
          throw new Error("Execution memory must belong to a task claimed by the actor");
        }
      } else if (data.taskId !== undefined) {
        throw new Error("Plain store memory cannot include taskId");
      }
      mutation = () => {
        agent.memory[key] = value;
      };
      break;
    }
    case "memory.retrieved": {
      assertPhase(event, "resolution");
      const agentId = requireActorDataAgent(event);
      const agent = requireAgent(state, agentId);
      assertNoTarget(event, "memory.retrieved");
      if (!agent.active) throw new Error(`Inactive agent ${agentId} cannot retrieve memory`);
      requireCausation(event, "memory.retrieved");
      if (requiredAction(data.action, "memory.retrieved action") !== "retrieve") {
        throw new Error("memory.retrieved action must be retrieve");
      }
      const key = requiredString(data.key, "key");
      if (!Object.hasOwn(agent.memory, key)) throw new Error(`Unknown memory key ${key}`);
      const value = requiredJsonValue(data.value, "value");
      if (hashValue(value) !== hashValue(agent.memory[key]!)) {
        throw new Error("memory.retrieved value does not match stored memory");
      }
      mutation = () => undefined;
      break;
    }
    case "message.sent": {
      assertPhase(event, "resolution");
      const message = parseMessage(optionalRecord(data.message) ?? data, event);
      if (state.messages[message.id]) throw new Error(`Message ${message.id} already exists`);
      const sender = requireAgent(state, message.senderId);
      const recipient = requireAgent(state, message.recipientId);
      if (event.actorId !== sender.id || event.targetId !== recipient.id) {
        throw new Error("Message event participants do not match its sender and recipient");
      }
      if (!sender.active || !recipient.active) throw new Error("Messages require active participants");
      if (sender.id === recipient.id) throw new Error("Agents cannot message themselves");
      const link = findLink(state, sender.id, recipient.id);
      if (!link) throw new Error("Messages require an active link");
      if (message.linkId !== link.id) throw new Error("Message linkId does not match its active link");
      requireCausation(event, "message.sent");
      const expectedId = deterministicId(
        "message", state.runId, state.universeId, event.tick,
        message.senderId, message.recipientId, message.localIndex,
      );
      if (message.id !== expectedId) throw new Error("Message id is not deterministic");
      mutation = () => {
        state.messages[message.id] = message;
      };
      break;
    }
    case "message.delivered": {
      assertPhase(event, "resolution");
      const messageId = requiredString(data.messageId, "messageId");
      const message = requireMessage(state, messageId);
      if (message.deliveredTick !== undefined) throw new Error(`Message ${messageId} is already delivered`);
      if (event.actorId !== message.senderId || event.targetId !== message.recipientId) {
        throw new Error(`Message ${messageId} delivery participants do not match`);
      }
      if (event.causationId !== message.sentEventId) throw new Error(`Message ${messageId} has invalid delivery causation`);
      if (event.seq !== message.sentSeq + 1 || event.tick !== message.sentTick) {
        throw new Error(`Message ${messageId} must be delivered immediately in its send tick`);
      }
      if (requiredString(data.linkId, "linkId") !== message.linkId) {
        throw new Error(`Message ${messageId} delivery linkId does not match`);
      }
      const link = requireLink(state, message.linkId);
      assertLinkParticipants(event, link, "message.delivered");
      const recipient = requireAgent(state, message.recipientId);
      const sender = requireAgent(state, message.senderId);
      if (!sender.active || !recipient.active) throw new Error("Message delivery requires active participants");
      if (recipient.inbox.includes(message.id)) throw new Error(`Inbox already contains message ${message.id}`);
      const inbox = [...recipient.inbox, message.id];
      mutation = () => {
        message.deliveredTick = event.tick;
        message.deliveredSeq = event.seq;
        message.deliveredEventId = event.eventId;
        recipient.inbox = inbox;
      };
      break;
    }
    case "capability.published": {
      assertPhase(event, "resolution");
      const capability = parseCapability(optionalRecord(data.capability) ?? data, event);
      if (state.capabilities[capability.id]) throw new Error(`Capability ${capability.id} already exists`);
      if (event.actorId !== capability.ownerId) {
        throw new Error("Capability publication actorId must match its ownerId");
      }
      const owner = requireAgent(state, capability.ownerId);
      assertNoTarget(event, "capability.published");
      if (!owner.active) throw new Error(`Inactive agent ${owner.id} cannot publish capabilities`);
      requireCausation(event, "capability.published");
      mutation = () => {
        state.capabilities[capability.id] = capability;
      };
      break;
    }
    case "capability.used": {
      assertPhase(event, "resolution");
      const invocation = parseCapabilityInvocation(optionalRecord(data.invocation) ?? data, event);
      if (state.capabilityInvocations[invocation.id]) throw new Error(`Capability invocation ${invocation.id} already exists`);
      const capability = requireCapability(state, invocation.capabilityId);
      const caller = requireAgent(state, invocation.callerId);
      if (event.actorId !== caller.id || event.targetId !== capability.ownerId) {
        throw new Error("Capability invocation participants do not match caller and owner");
      }
      if (!caller.active) throw new Error(`Inactive agent ${caller.id} cannot use capabilities`);
      requireCausation(event, "capability.used");
      const expectedId = deterministicId(
        "capability-invocation", state.runId, state.universeId, event.tick,
        caller.id, capability.id, invocation.localIndex,
      );
      if (invocation.id !== expectedId) throw new Error("Capability invocation id is not deterministic");
      if (invocation.success && !invocation.accepted) throw new Error("Rejected capability invocation cannot succeed");
      if (invocation.accepted) {
        if (!invocation.success || invocation.output === undefined) {
          throw new Error("Accepted capability invocation must succeed and include output");
        }
        if (invocation.reason !== undefined) throw new Error("Accepted capability invocation cannot include a rejection reason");
        const expectedOutput = executeCapabilityPlan(capability, invocation.input);
        if (hashValue(expectedOutput) !== hashValue(invocation.output)) {
          throw new Error("Capability invocation output does not match its deterministic plan");
        }
        assertSameResources(invocation.chargedCost, capability.cost, "Capability charge differs from its declaration");
        const expectedPaymentTo = capability.ownerId === caller.id ? "@treasury" : capability.ownerId;
        if (invocation.paymentTo !== expectedPaymentTo) throw new Error("Capability payment destination is incorrect");
        const callerResources = cloneResources(caller.resources);
        const paymentAccount = accountResources(state, expectedPaymentTo);
        const paymentResources = cloneResources(paymentAccount);
        for (const kind of RESOURCE_KINDS) {
          debit(callerResources, kind, invocation.chargedCost[kind], caller.id);
          credit(paymentResources, kind, invocation.chargedCost[kind]);
        }
        const usageCount = incrementCounter(capability.usageCount, "capability usageCount");
        const successCount = incrementCounter(capability.successCount, "capability successCount");
        mutation = () => {
          assignResources(caller.resources, callerResources);
          assignResources(paymentAccount, paymentResources);
          capability.usageCount = usageCount;
          capability.successCount = successCount;
          state.capabilityInvocations[invocation.id] = invocation;
        };
      } else {
        assertSameResources(invocation.chargedCost, ZERO_RESOURCES, "Rejected capability invocation cannot be charged");
        if (invocation.paymentTo !== undefined) throw new Error("Rejected capability invocation cannot have a payment destination");
        if (invocation.output !== undefined) throw new Error("Rejected capability invocation cannot include output");
        let executionFailed = false;
        try {
          executeCapabilityPlan(capability, invocation.input);
        } catch {
          executionFailed = true;
        }
        const insufficientResources = !canAfford(caller.resources, capability.cost);
        if (executionFailed) {
          if (invocation.reason !== "execution_failed") {
            throw new Error("Rejected capability execution must use reason code execution_failed");
          }
        } else if (insufficientResources) {
          if (invocation.reason !== "insufficient_resources") {
            throw new Error("Rejected capability payment must use reason code insufficient_resources");
          }
        } else {
          throw new Error("Capability invocation cannot be rejected when execution and payment are valid");
        }
        mutation = () => {
          state.capabilityInvocations[invocation.id] = invocation;
        };
      }
      break;
    }
    case "cognition.recorded":
      // Deliberately state-neutral. What a model proposed is evidence; only the
      // actions the world then accepted may move the world.
      mutation = () => {};
      break;

    case "agent.learning.updated": {
      throw new Error("agent.learning.updated is unsupported; learning is derived from task.evaluated");
    }
    case "pressure.applied": {
      const physics = structuredClone(state.physics);
      applyPressure(physics, optionalRecord(data.pressure) ?? data);
      mutation = () => {
        state.physics = physics;
      };
      break;
    }
    case "violation.recorded": {
      assertPhase(event, "resolution");
      const agentId = requireActorDataAgent(event);
      const agent = requireAgent(state, agentId);
      assertNoTarget(event, "violation.recorded");
      if (!agent.active) throw new Error(`Inactive agent ${agentId} cannot record action violations`);
      requiredAction(data.action, "violation action");
      requiredString(data.reason, "violation reason");
      const count = nonNegativeInteger(data.count, "count");
      if (count !== 1) throw new Error("violation.recorded count must equal one");
      const violations = addCounters(agent.violations, count, "agent violations");
      mutation = () => {
        agent.violations = violations;
      };
      break;
    }
    case "metrics.recorded": {
      const metrics = optionalRecord(data.metrics) ?? data;
      const snapshot = structuredClone(metrics) as unknown as MetricsSnapshot;
      mutation = () => {
        state.metrics.push(snapshot);
      };
      break;
    }
    case "tick.completed":
      mutation = () => undefined;
      break;
    case "run.completed":
      mutation = () => {
        state.completed = true;
      };
      break;
  }

  let applied = false;
  return {
    seq: event.seq,
    hash: event.hash,
    apply(committed: LabEvent): WorldState {
      if (applied) throw new Error(`Event ${event.seq} transition has already been applied`);
      if (
        committed.seq !== event.seq
        || committed.eventId !== event.eventId
        || committed.hash !== event.hash
      ) {
        throw new Error(`Committed event does not match prepared transition ${event.seq}`);
      }
      if ((WORLD_VERSIONS.get(state) ?? 0) !== preparedVersion) {
        throw new Error(`World changed after event ${event.seq} transition was prepared`);
      }
      applied = true;
      mutation();
      state.tick = event.tick;
      WORLD_VERSIONS.set(state, preparedVersion + 1);
      return state;
    },
  };
}

/** Efficient in-place projection for owned replay/live state. */
export function applyWorldEventMutable(state: WorldState, event: LabEvent): WorldState {
  return prepareWorldEventTransition(state, event).apply(event);
}

/** Pure compatibility wrapper: the input state and event are never mutated. */
export function reduceWorldEvent(state: WorldState, event: LabEvent): WorldState {
  return applyWorldEventMutable(structuredClone(state), event);
}

function defaultPhysics(): PhysicsState {
  return {
    resourcePricePpm: {
      credits: PPM,
      llmTokens: PPM,
      computeMs: PPM,
      storageBytes: PPM,
      bandwidthBytes: PPM,
    },
    bandwidthCapacityPpm: PPM,
    taskLoadPpm: PPM,
  };
}

function parsePhysics(value: Record<string, unknown>, fallback: PhysicsState): PhysicsState {
  const prices = optionalRecord(value.resourcePricePpm);
  const resourcePricePpm = structuredClone(fallback.resourcePricePpm);
  if (prices) {
    for (const kind of RESOURCE_KINDS) {
      if (prices[kind] !== undefined) resourcePricePpm[kind] = nonNegativeInteger(prices[kind], `resourcePricePpm.${kind}`);
    }
  }
  return {
    resourcePricePpm,
    bandwidthCapacityPpm: optionalSafeInteger(value.bandwidthCapacityPpm, "bandwidthCapacityPpm") ?? fallback.bandwidthCapacityPpm,
    taskLoadPpm: optionalSafeInteger(value.taskLoadPpm, "taskLoadPpm") ?? fallback.taskLoadPpm,
  };
}

function parseAgent(value: Record<string, unknown>, event: LabEvent): LabAgentState {
  const id = optionalString(value.id) ?? optionalString(value.agentId) ?? event.actorId;
  if (!id) throw new Error("agent.created requires an agent id");
  const resources = optionalRecord(value.resources);
  const agent: LabAgentState = {
    id,
    active: value.active === undefined ? true : requiredBoolean(value.active, "agent.active"),
    generation: optionalSafeInteger(value.generation, "agent.generation") ?? 0,
    lineage: stringArray(value.lineage, "agent.lineage"),
    resources: resources ? parseResources(resources, "agent.resources") : cloneResources(ZERO_RESOURCES),
    inbox: stringArray(value.inbox, "agent.inbox"),
    memory: (structuredClone(optionalRecord(value.memory) ?? {}) as Record<string, JsonValue>),
    learning: (structuredClone(optionalRecord(value.learning) ?? { attempts: {}, successes: {}, utilityPpm: {} }) as unknown as LabAgentState["learning"]),
    actionCounts: (structuredClone(optionalRecord(value.actionCounts) ?? {}) as LabAgentState["actionCounts"]),
    taskCounts: (structuredClone(optionalRecord(value.taskCounts) ?? {}) as LabAgentState["taskCounts"]),
    violations: optionalSafeInteger(value.violations, "agent.violations") ?? 0,
    createdTick: optionalSafeInteger(value.createdTick, "agent.createdTick") ?? event.tick,
    ...(value.retiredTick === undefined ? {} : { retiredTick: nonNegativeInteger(value.retiredTick, "agent.retiredTick") }),
  };
  if (!agent.active || agent.retiredTick !== undefined) throw new Error("Genesis agents must start active and unretired");
  return agent;
}

function parseTask(value: Record<string, unknown>): LabTaskState {
  const status = optionalString(value.status) ?? "available";
  if (!["available", "claimed", "submitted", "completed", "expired"].includes(status)) throw new Error(`Invalid task status ${status}`);
  return {
    id: requiredString(value.id, "task.id"),
    family: requiredString(value.family, "task.family") as TaskFamily,
    input: cloneJsonValue(requiredJsonValue(value.input, "task.input")),
    createdTick: nonNegativeInteger(value.createdTick, "task.createdTick"),
    deadlineTick: nonNegativeInteger(value.deadlineTick, "task.deadlineTick"),
    status: status as LabTaskState["status"],
    ...(value.claimedBy === undefined ? {} : { claimedBy: requiredString(value.claimedBy, "task.claimedBy") }),
    ...(value.submittedBy === undefined ? {} : { submittedBy: requiredString(value.submittedBy, "task.submittedBy") }),
    ...(value.completedTick === undefined ? {} : { completedTick: nonNegativeInteger(value.completedTick, "task.completedTick") }),
    ...(value.evaluationEventId === undefined ? {} : {
      evaluationEventId: requiredString(value.evaluationEventId, "task.evaluationEventId"),
    }),
  };
}

function parseSubmission(value: Record<string, unknown>, event: LabEvent): SubmissionState {
  const submission: SubmissionState = {
    id: requiredString(value.id, "submission.id"),
    taskId: requiredString(value.taskId, "submission.taskId"),
    agentId: requiredString(value.agentId, "submission.agentId"),
    result: cloneJsonValue(requiredJsonValue(value.result, "submission.result")),
    submittedTick: optionalSafeInteger(value.submittedTick, "submission.submittedTick") ?? event.tick,
    submittedSeq: event.seq,
    submittedEventId: event.eventId,
    accepted: value.accepted === undefined ? false : requiredBoolean(value.accepted, "submission.accepted"),
    qualityPpm: optionalSafeInteger(value.qualityPpm, "submission.qualityPpm") ?? 0,
    latencyTicks: optionalSafeInteger(value.latencyTicks, "submission.latencyTicks") ?? 0,
  };
  if (submission.submittedTick !== event.tick) throw new Error("Submission submittedTick must equal the event tick");
  if (submission.accepted || submission.qualityPpm !== 0 || submission.latencyTicks !== 0) {
    throw new Error("New submissions must start unevaluated");
  }
  if (
    value.submittedSeq !== undefined && nonNegativeInteger(value.submittedSeq, "submission.submittedSeq") !== event.seq
  ) {
    throw new Error("Submission submittedSeq must equal the event sequence");
  }
  if (
    value.submittedEventId !== undefined
    && requiredString(value.submittedEventId, "submission.submittedEventId") !== event.eventId
  ) {
    throw new Error("Submission submittedEventId must equal the event id");
  }
  return submission;
}

function parseLink(value: Record<string, unknown>, event: LabEvent): LabLinkState {
  const link: LabLinkState = {
    id: requiredString(value.id, "link.id"),
    left: requiredString(value.left, "link.left"),
    right: requiredString(value.right, "link.right"),
    strengthPpm: optionalSafeInteger(value.strengthPpm, "link.strengthPpm") ?? PPM,
    createdTick: optionalSafeInteger(value.createdTick, "link.createdTick") ?? event.tick,
    lastUsedTick: optionalSafeInteger(value.lastUsedTick, "link.lastUsedTick") ?? event.tick,
  };
  if (link.strengthPpm > PPM) throw new Error("link.strengthPpm must not exceed 1,000,000");
  return link;
}

function parseCapability(value: Record<string, unknown>, event: LabEvent): CapabilityState {
  const ownerId = requiredString(value.ownerId, "capability.ownerId");
  const cost = optionalRecord(value.cost);
  const id = requiredString(value.id, "capability.id");
  const expectedVersion = Number.parseInt(id.match(/\/v([1-9][0-9]*)$/)?.[1] ?? "", 10);
  const version = optionalSafeInteger(value.version, "capability.version") ?? 1;
  const createdTick = optionalSafeInteger(value.createdTick, "capability.createdTick") ?? event.tick;
  const usageCount = optionalSafeInteger(value.usageCount, "capability.usageCount") ?? 0;
  const successCount = optionalSafeInteger(value.successCount, "capability.successCount") ?? 0;
  const capability: CapabilityState = {
    id,
    ownerId,
    version,
    inputs: stringArray(value.inputs, "capability.inputs"),
    outputs: stringArray(value.outputs, "capability.outputs"),
    primitivePlan: stringArray(value.primitivePlan, "capability.primitivePlan") as PrimitiveActionType[],
    executionPlan: structuredClone(jsonArray(value.executionPlan, "capability.executionPlan")) as CapabilityPlanStep[],
    tests: structuredClone(jsonArray(value.tests, "capability.tests")),
    cost: cost ? parseResources(cost, "capability.cost") : cloneResources(ZERO_RESOURCES),
    createdTick,
    usageCount,
    successCount,
  };
  validateCapabilityPublication(capability);
  if (!Number.isSafeInteger(expectedVersion) || capability.version !== expectedVersion) {
    throw new Error("Capability version does not match its /vN id suffix");
  }
  if (capability.createdTick !== event.tick) {
    throw new Error("Capability createdTick must equal the publication event tick");
  }
  if (capability.usageCount !== 0 || capability.successCount !== 0) {
    throw new Error("Published capability counters must start at zero");
  }
  return capability;
}

function parseMessage(value: Record<string, unknown>, event: LabEvent): MessageState {
  const senderId = requiredString(value.senderId, "message.senderId");
  const recipientId = requiredString(value.recipientId, "message.recipientId");
  const payload = optionalRecord(value.payload);
  if (!payload) throw new Error("message.sent payload must be a JSON object");
  const sentTick = optionalSafeInteger(value.sentTick, "message.sentTick") ?? event.tick;
  if (sentTick !== event.tick) throw new Error("message.sentTick must equal the event tick");
  if (value.sentSeq !== undefined && nonNegativeInteger(value.sentSeq, "message.sentSeq") !== event.seq) {
    throw new Error("message.sentSeq must equal the event sequence");
  }
  if (value.sentEventId !== undefined && requiredString(value.sentEventId, "message.sentEventId") !== event.eventId) {
    throw new Error("message.sentEventId must equal the event id");
  }
  if (
    value.deliveredTick !== undefined
    || value.deliveredSeq !== undefined
    || value.deliveredEventId !== undefined
    || value.linkUsedEventId !== undefined
  ) {
    throw new Error("New messages cannot contain delivery state");
  }
  return {
    id: requiredString(value.id, "message.id"),
    senderId,
    recipientId,
    payload: structuredClone(payload) as JsonObject,
    sentTick,
    sentSeq: event.seq,
    sentEventId: event.eventId,
    linkId: requiredString(value.linkId, "message.linkId"),
    localIndex: nonNegativeInteger(value.localIndex, "message.localIndex"),
  };
}

function parseVerification(value: Record<string, unknown>, event: LabEvent): VerificationState {
  const verifierId = requiredString(value.verifierId, "verification.verifierId");
  const createdTick = optionalSafeInteger(value.createdTick, "verification.createdTick") ?? event.tick;
  if (createdTick !== event.tick) throw new Error("verification.createdTick must equal the event tick");
  return {
    id: requiredString(value.id, "verification.id"),
    submissionId: requiredString(value.submissionId, "verification.submissionId"),
    verifierId,
    computedResult: cloneJsonValue(requiredJsonValue(value.computedResult, "verification.computedResult")),
    verdict: requiredBoolean(value.verdict, "verification.verdict"),
    matchesSubmission: requiredBoolean(value.matchesSubmission, "verification.matchesSubmission"),
    createdTick,
  };
}

function parseCapabilityInvocation(value: Record<string, unknown>, event: LabEvent): CapabilityInvocationState {
  const callerId = requiredString(value.callerId, "capability invocation callerId");
  const chargedCost = optionalRecord(value.chargedCost);
  if (!chargedCost) throw new Error("capability.used requires chargedCost");
  const createdTick = optionalSafeInteger(value.createdTick, "capability invocation createdTick") ?? event.tick;
  if (createdTick !== event.tick) throw new Error("Capability invocation createdTick must equal event tick");
  return {
    id: requiredString(value.id, "capability invocation id"),
    capabilityId: requiredString(value.capabilityId, "capabilityId"),
    callerId,
    input: cloneJsonValue(requiredJsonValue(value.input, "capability input")),
    accepted: requiredBoolean(value.accepted, "capability invocation accepted"),
    success: requiredBoolean(value.success, "capability invocation success"),
    chargedCost: parseResources(chargedCost, "capability chargedCost"),
    createdTick,
    localIndex: nonNegativeInteger(value.localIndex, "capability invocation localIndex"),
    ...(value.output === undefined ? {} : { output: cloneJsonValue(requiredJsonValue(value.output, "capability output")) }),
    ...(value.paymentTo === undefined ? {} : { paymentTo: requiredString(value.paymentTo, "capability paymentTo") }),
    ...(value.reason === undefined ? {} : { reason: requiredString(value.reason, "capability reason") }),
  };
}

function applyPressure(physics: PhysicsState, value: Record<string, unknown>): void {
  const type = requiredString(value.type, "pressure.type");
  const resultingPpm = optionalSafeInteger(value.resultingPpm, "pressure.resultingPpm");
  if (type === "resource_price_multiplier") {
    const resource = parseResourceKind(value.resource);
    physics.resourcePricePpm[resource] = resultingPpm ?? multiplyPpm(
      physics.resourcePricePpm[resource], nonNegativeInteger(value.multiplierPpm, "pressure.multiplierPpm"),
    );
  } else if (type === "bandwidth_capacity_multiplier") {
    physics.bandwidthCapacityPpm = resultingPpm ?? multiplyPpm(
      physics.bandwidthCapacityPpm, nonNegativeInteger(value.multiplierPpm, "pressure.multiplierPpm"),
    );
  } else if (type === "task_load_multiplier") {
    physics.taskLoadPpm = resultingPpm ?? multiplyPpm(
      physics.taskLoadPpm, nonNegativeInteger(value.multiplierPpm, "pressure.multiplierPpm"),
    );
  } else if (type !== "retire_agent_fraction") {
    throw new Error(`Unknown pressure type ${type}`);
  }
}

function incrementCounter(value: number | undefined, name: string): number {
  return addCounters(value ?? 0, 1, name);
}

function addCounters(left: number, right: number, name: string): number {
  if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  const sum = BigInt(left) + BigInt(right);
  if (sum > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${name} exceeds the safe-integer range`);
  return Number(sum);
}

function findLink(state: WorldState, left: string, right: string): LabLinkState | undefined {
  return Object.values(state.links).find((link) => (
    (link.left === left && link.right === right)
    || (link.left === right && link.right === left)
  ));
}

function accountResources(state: WorldState, account: string): ResourceVector {
  if (account === "@treasury" || account === "treasury") return state.treasury;
  return requireAgent(state, account).resources;
}

function debit(resources: ResourceVector, kind: ResourceKind, amount: number, account: string): void {
  if (amount === 0) return;
  if (resources[kind] < amount) throw new Error(`${account} has insufficient ${kind}`);
  resources[kind] -= amount;
}

function credit(resources: ResourceVector, kind: ResourceKind, amount: number): void {
  const next = resources[kind] + amount;
  if (!Number.isSafeInteger(next)) throw new Error(`${kind} balance exceeds safe integer range`);
  resources[kind] = next;
}

function parseResources(value: Record<string, unknown>, name: string): ResourceVector {
  for (const key of Object.keys(value)) {
    if (!(RESOURCE_KINDS as readonly string[]).includes(key)) {
      throw new Error(`${name} contains unknown resource ${key}`);
    }
  }
  return {
    credits: nonNegativeInteger(value.credits, `${name}.credits`),
    llmTokens: nonNegativeInteger(value.llmTokens, `${name}.llmTokens`),
    computeMs: nonNegativeInteger(value.computeMs, `${name}.computeMs`),
    storageBytes: nonNegativeInteger(value.storageBytes, `${name}.storageBytes`),
    bandwidthBytes: nonNegativeInteger(value.bandwidthBytes, `${name}.bandwidthBytes`),
  };
}

function cloneResources(value: Readonly<ResourceVector>): ResourceVector {
  return { ...value };
}

function assignResources(target: ResourceVector, source: Readonly<ResourceVector>): void {
  for (const kind of RESOURCE_KINDS) target[kind] = source[kind];
}

function canAfford(balance: Readonly<ResourceVector>, cost: Readonly<ResourceVector>): boolean {
  return RESOURCE_KINDS.every((kind) => balance[kind] >= cost[kind]);
}

function parseResourceKind(value: unknown): ResourceKind {
  if (typeof value !== "string" || !(RESOURCE_KINDS as readonly string[]).includes(value)) throw new Error(`Unknown resource ${String(value)}`);
  return value as ResourceKind;
}

function requireActorDataAgent(event: LabEvent): string {
  const actorId = requiredString(event.actorId, `${event.type} actorId`);
  const dataAgentId = requiredString(event.data.agentId, `${event.type} data.agentId`);
  if (actorId !== dataAgentId) throw new Error(`${event.type} actorId must match data.agentId`);
  return actorId;
}

function requireActiveActor(state: WorldState, event: LabEvent, label: string): LabAgentState {
  const actorId = requiredString(event.actorId, `${label} actorId`);
  const actor = requireAgent(state, actorId);
  if (!actor.active) throw new Error(`${label} requires an active actor`);
  return actor;
}

function requireCausation(event: LabEvent, label: string): string {
  return requiredString(event.causationId, `${label} causationId`);
}

function requiredAction(value: unknown, name: string): PrimitiveActionType {
  const action = requiredString(value, name);
  if (!ACTION_TYPES.has(action as PrimitiveActionType)) throw new Error(`${name} is unknown: ${action}`);
  return action as PrimitiveActionType;
}

function assertPhase(event: LabEvent, expected: LabEvent["phase"]): void {
  if (event.phase !== expected) throw new Error(`${event.type} must use phase ${expected}`);
}

function assertSystemEvent(event: LabEvent, label: string): void {
  if (event.actorId !== undefined || event.targetId !== undefined || event.causationId !== undefined) {
    throw new Error(`${label} must be a system event without participants or causation`);
  }
}

function assertNoTarget(event: LabEvent, label: string): void {
  if (event.targetId !== undefined) throw new Error(`${label} cannot have targetId`);
}

function assertLinkParticipants(event: LabEvent, link: LabLinkState, label: string): void {
  const actorId = requiredString(event.actorId, `${label} actorId`);
  const targetId = requiredString(event.targetId, `${label} targetId`);
  if (actorId === targetId || !(
    (actorId === link.left && targetId === link.right)
    || (actorId === link.right && targetId === link.left)
  )) {
    throw new Error(`${label} participants do not match link endpoints`);
  }
}

function requireAgent(state: WorldState, id: string): LabAgentState {
  const agent = state.agents[id];
  if (!agent) throw new Error(`Unknown agent ${id}`);
  return agent;
}

function requireTask(state: WorldState, id: string): LabTaskState {
  const task = state.tasks[id];
  if (!task) throw new Error(`Unknown task ${id}`);
  return task;
}

function requireSubmission(state: WorldState, id: string): SubmissionState {
  const submission = state.submissions[id];
  if (!submission) throw new Error(`Unknown submission ${id}`);
  return submission;
}

function requireMessage(state: WorldState, id: string): MessageState {
  const message = state.messages[id];
  if (!message) throw new Error(`Unknown message ${id}`);
  return message;
}

function requireLink(state: WorldState, id: string): LabLinkState {
  const link = state.links[id];
  if (!link) throw new Error(`Unknown link ${id}`);
  return link;
}

function requireCapability(state: WorldState, id: string): CapabilityState {
  const capability = state.capabilities[id];
  if (!capability) throw new Error(`Unknown capability ${id}`);
  return capability;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const orderedExpected = [...expected].sort();
  if (
    actual.length !== orderedExpected.length
    || actual.some((key, index) => key !== orderedExpected[index])
  ) {
    throw new Error(`${name} must contain exactly ${orderedExpected.join(", ")}`);
  }
}

function requiredString(value: unknown, name: string): string {
  const parsed = optionalString(value);
  if (!parsed) throw new Error(`${name} must be a non-empty string`);
  return parsed;
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
}

function optionalSafeInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  return nonNegativeInteger(value, name);
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value as number;
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = nonNegativeInteger(value, name);
  if (parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function requiredJsonValue(value: unknown, name: string): JsonValue {
  if (value === undefined) throw new Error(`${name} is required`);
  return value as JsonValue;
}

function cloneJsonValue(value: JsonValue): JsonValue {
  return structuredClone(value);
}

function stringArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(`${name} must be a string array`);
  return [...value] as string[];
}

function jsonArray(value: unknown, name: string): JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be a JSON array`);
  return structuredClone(value) as JsonValue[];
}

function assertSameResources(left: ResourceVector, right: Readonly<ResourceVector>, message: string): void {
  for (const kind of RESOURCE_KINDS) {
    if (left[kind] !== right[kind]) throw new Error(message);
  }
}

function multiplyPpm(value: number, multiplierPpm: number): number {
  const result = (BigInt(value) * BigInt(multiplierPpm)) / BigInt(PPM);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("PPM multiplication exceeds safe integer range");
  return Number(result);
}
