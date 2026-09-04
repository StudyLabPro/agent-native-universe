export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface NetworkAddress {
  host: string;
  port: number;
}

export interface MeshPublicIdentity {
  id: string;
  signingPublicKeyPem: string;
  encryptionPublicKeyPem: string;
  signingFingerprint: string;
  encryptionFingerprint: string;
  algorithm: "Ed25519+X25519";
}

export interface MeshPeer {
  identity: MeshPublicIdentity;
  address: NetworkAddress;
}

export interface AgentAdvertisement {
  agentId: string;
  nodeId: string;
  generation: number;
  objective: string;
  capabilities: string[];
  accepts: string[];
  produces: string[];
  needs: string[];
  currentLinks: number;
  maxLinks: number;
  minCompatibility: number;
  maxCommunicationCost: number;
  metadata: JsonObject;
  issuedAt: number;
  expiresAt: number;
}

export interface DiscoveryCandidate {
  local: AgentAdvertisement;
  remote: AgentAdvertisement;
  score: number;
  matchedNeeds: string[];
  reciprocalMatches: string[];
}

export interface RelationshipTerms {
  topics: string[];
  payloadMode: "full" | "delta" | "event";
  heartbeatMs: number;
  maxCommunicationCost: number;
  minInformationGain: number;
}

export interface RelationshipProposal {
  id: string;
  proposerNodeId: string;
  proposerAgentId: string;
  recipientNodeId: string;
  recipientAgentId: string;
  candidateScore: number;
  terms: RelationshipTerms;
  round: number;
  expiresAt: number;
}

export type RelationshipDecision =
  | { action: "accept"; terms: RelationshipTerms; reason: string }
  | { action: "counter"; terms: RelationshipTerms; reason: string }
  | { action: "reject"; reason: string };

export interface RemoteRelationship {
  id: string;
  localAgentId: string;
  remoteAgentId: string;
  remoteNodeId: string;
  terms: RelationshipTerms;
  state: "probation" | "active" | "dormant" | "retired";
  revisions: number;
  lastActivityAt: number;
  usefulExchanges: number;
  failures: number;
}

export interface AgentCognitivePort {
  readonly id: string;
  snapshot(): {
    objective?: { primary?: string; secondary?: string[] };
    exposedState?: JsonObject;
    durableState?: JsonObject;
    privateState?: JsonObject;
    ephemeralState?: JsonObject;
    capabilities?: Array<{ id: string; accepts?: string[]; produces?: string[] }>;
    needs?: Array<{ accepts?: string[] }>;
    generation?: number;
    links?: string[];
    networkPolicy?: {
      maxLinks?: number;
      minCompatibility?: number;
      maxCommunicationCost?: number;
    };
  };
  expose?(delta: JsonObject): void;
  remember?(delta: JsonObject): void;
  think?(delta: JsonObject): void;
  setEphemeral?(delta: JsonObject): void;
  consumeBudget?(kind: "compute" | "tokens" | "money" | "latencyMs" | "externalActions", amount: number): void;
}

export interface CognitiveAction {
  type: string;
  payload: JsonObject;
}

export interface CognitiveDecision {
  privateState?: JsonObject;
  exposedState?: JsonObject;
  durableState?: JsonObject;
  ephemeralState?: JsonObject;
  actions?: CognitiveAction[];
  summary?: string;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface LlmRequest {
  model?: string;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "text" | "json";
  metadata?: JsonObject;
  /**
   * Provider-specific request fields merged into the wire body verbatim
   * (e.g. `{"reasoning_effort":"low"}`). They never override `model`,
   * `messages` or `stream`. Anything here changes what the model contributes,
   * so callers that record evidence must hash it into their identity.
   */
  extra?: JsonObject;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface LlmResponse {
  provider: string;
  model: string;
  content: string;
  usage: LlmUsage;
  latencyMs: number;
  raw?: JsonValue;
  /** `message.reasoning_content` when the provider exposes its reasoning. */
  reasoningContent?: string;
  /** `usage.completion_tokens_details.reasoning_tokens` when reported. */
  reasoningTokens?: number;
  /** `choices[0].finish_reason` when reported, e.g. `stop` or `length`. */
  finishReason?: string;
}

export interface LlmCompletionPort {
  complete(
    request: LlmRequest,
    policy?: { require?: string[]; prefer?: string[]; maxEstimatedCost?: number },
    signal?: AbortSignal,
  ): Promise<LlmResponse>;
}

export type ResourceKind = "credits" | "compute_ms" | "model_tokens" | "storage_bytes" | "bandwidth_bytes";

export interface FractalAgentView {
  id: string;
  kind: "nano" | "meta";
  capabilities: string[];
  exposedState: JsonObject;
  parentMetaAgentId?: string;
  lineage: string[];
}

export interface FractalLinkView {
  id: string;
  left: string;
  right: string;
  protocol: JsonObject;
  strength: number;
}

export interface MetaAgentView extends FractalAgentView {
  kind: "meta";
  members: string[];
  depth: number;
}

export interface FractalProjection {
  agents: FractalAgentView[];
  links: FractalLinkView[];
  metaAgents: MetaAgentView[];
}

export interface FractalGraphPort {
  projection(): FractalProjection;
  detectClusters(minStrength?: number, minimumMembers?: number): string[][];
  foldCluster(memberIds: string[], requestedId?: string): MetaAgentView;
  unfold(metaAgentId: string): MetaAgentView;
  getMetaAgent(id: string): MetaAgentView | undefined;
}

export interface ConsensusCommand {
  id: string;
  type: string;
  payload: JsonObject;
  issuer: string;
  issuedAt: number;
}
