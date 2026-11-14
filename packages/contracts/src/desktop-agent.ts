export type DesktopAgentKind = "pi" | "codex" | "claude" | "acp" | "omp";
export type AgentCapabilities = {
  nativeResume: "supported" | "unsupported" | "unknown";
  approval: "tool-callback" | "provider-request";
  cancellation: "runtime-task" | "process-stop";
  historyTransfer: "text-only";
  rollback: false;
};
export type DesktopHandoff = {
  source: DesktopAgentKind; target: DesktopAgentKind; createdAt: string;
  totalMessages: number; includedMessages: number; omittedMessages: number;
  firstMessageId?: string; lastMessageId?: string;
  omitted: Array<"attachments" | "tool-state" | "hidden-reasoning">;
  status: "pending" | "submitted";
};
/** Projection of persisted native request records, not user acceptance or external delivery. */
export type DesktopAgentRun = {
  id: string; sessionId: string; nativeSessionId?: string;
  agent: Exclude<DesktopAgentKind, "pi">;
  status: "running" | "succeeded" | "failed" | "cancelled" | "interrupted" | "unknown";
  request: string; result: string | null;
  cancellation: "not_requested" | "confirmed" | "unknown";
  review: "unsupported";
};
export type DesktopConversation = {
  sessionId: string; agent: DesktopAgentKind;
  messages: Array<{ id: string; role: "user" | "assistant"; text: string }>;
};
export type DesktopConversationUpload = DesktopConversation & { deviceId: string; revision: number };
export type ExternalAgentConfig = { executable: string; args: string[]; access?: "ask" | "full"; mode?: string; permission?: "default" | "readOnly" | "autoEdit"; permissionMode?: string; sandbox?: string; approvalPolicy?: string; effort?: string; model?: string };
export type AgentPermissionParameter = { parameter: "permissionMode" | "sandbox" | "approvalPolicy"; values: string[] };
export type DesktopPiEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type DesktopAgentSelection = { kind: DesktopAgentKind; config?: ExternalAgentConfig; piAccess?: "ask" | "full"; piModel?: { provider: string; modelId: string } | null; piEffort?: DesktopPiEffort | null };
export type AgentQuestion = { id: string; text: string; options?: string[]; secret?: boolean };
export type AgentApproval = { id: string; title: string; detail: string; questions?: AgentQuestion[] };
export type AgentApprovalAnswer = { id: string; allow: boolean; answers?: Record<string, string> };
export type AgentActivity = { id: string; title: string; status: "running" | "done" | "failed"; detail?: string };
export type ExternalAgentState = {
  status: "idle" | "running" | "waiting" | "done" | "failed" | "cancelled" | "interrupted";
  sessionId?: string; activities: AgentActivity[]; approvals: AgentApproval[];
};
export type DesktopPeerJob = {
  id: string; source: string; target: string; task: string;
  status: "queued" | "running" | "done" | "failed";
  result?: string; createdAt: string; updatedAt: string;
  sourceSession?: { agent: DesktopAgentKind; sessionId: string };
  targetSession?: { agent: DesktopAgentKind; sessionId: string };
  deliveryError?: string;
  resultDelivered?: boolean;
  approved?: boolean;
  workspace?: string; constraints?: string; acceptanceCriteria?: string;
  cancellation?: { requestedAt: string; confirmedAt?: string };
};
export type ConversationSyncMode = "local" | "summary" | "full";
export type ConversationSyncState = {
  sessionId: string; mode: ConversationSyncMode; summary: string; serverId?: string; serverMismatch?: boolean;
  revision: number; sentRevision: number; previouslyShared: boolean; status: "local" | "pending" | "synced";
};
export type DesktopAgentSnapshot = {
  conversationSync?: ConversationSyncState;
  runs?: DesktopAgentRun[];
  capabilities?: AgentCapabilities;
  handoff?: DesktopHandoff;
  piAccess?: "ask" | "full";
  piEffort?: DesktopPiEffort | null;
  piModel?: { provider: string; modelId: string } | null;
  agent?: DesktopAgentKind;
  agentConfig?: ExternalAgentConfig;
  external?: ExternalAgentState;
  piConfigured?: boolean;
  configured: boolean;
  model: { api: string; baseUrl: string; model: string; contextWindow: number; maxTokens: number; hasApiKey: boolean };
  workspace: string | null; nodeId: string; busy: boolean;
  messages: Array<{ id: string; role: "user" | "assistant"; text: string }>;
  jobs: DesktopPeerJob[]; serverConnected: boolean; error?: string;
  collaboration?: "connecting" | "ready" | "pairing" | "unavailable" | "offline";
};
export type DesktopAgentBridge = {
  platform?: string;
  snapshot(): Promise<DesktopAgentSnapshot>;
  agentModels?(): Promise<Array<{ id: string; name: string; efforts: string[] }>>;
  agentPermissions?(): Promise<AgentPermissionParameter[]>;
  selectAgent(input: DesktopAgentSelection): Promise<void>;
  newSession(): Promise<void>;
  setConversationSync?(input: {sessionId: string; mode: ConversationSyncMode; summary?: string}): Promise<void>;
  cancelPeer?(id: string): Promise<void>;
  answerApproval(input: AgentApprovalAnswer): Promise<void>;
  send(input: { id: string; text: string }): Promise<void>;
  peerSessions?(node?: string): Promise<Array<{ agent: DesktopAgentKind; sessionId: string; status?: string }>>;
  readPeerSession?(input: { node: string; session: { agent: DesktopAgentKind; sessionId: string } }): Promise<DesktopConversation>;
  sendPeer?(input: Pick<DesktopPeerJob, "id" | "source" | "target" | "task" | "sourceSession" | "targetSession" | "workspace" | "constraints" | "acceptanceCriteria">): Promise<DesktopPeerJob>;
  peerStatus?(id: string): Promise<DesktopPeerJob>;
  chooseWorkspace(): Promise<void>;
  approve(id: string): Promise<void>;
  reject(id: string): Promise<void>;
  abort(): Promise<void>;
  openServer(hash?: string): Promise<void>;
  openConnection(): Promise<void>;
};
