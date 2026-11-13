export type DesktopAgentKind = "pi" | "codex" | "claude" | "acp" | "omp";
export type DesktopConversation = {
  sessionId: string; agent: DesktopAgentKind;
  messages: Array<{ id: string; role: "user" | "assistant"; text: string }>;
};
export type DesktopConversationUpload = DesktopConversation & { deviceId: string; revision: number };
export type ExternalAgentConfig = { executable: string; args: string[]; mode?: string; permission?: "default" | "readOnly" | "autoEdit"; permissionMode?: string; sandbox?: string; approvalPolicy?: string; effort?: string; model?: string };
export type AgentPermissionParameter = { parameter: "permissionMode" | "sandbox" | "approvalPolicy"; values: string[] };
export type DesktopAgentSelection = { kind: DesktopAgentKind; config?: ExternalAgentConfig };
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
};
export type DesktopAgentSnapshot = {
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
  answerApproval(input: AgentApprovalAnswer): Promise<void>;
  send(input: { id: string; text: string }): Promise<void>;
  peerSessions?(node?: string): Promise<Array<{ agent: DesktopAgentKind; sessionId: string; status?: string }>>;
  readPeerSession?(input: { node: string; session: { agent: DesktopAgentKind; sessionId: string } }): Promise<DesktopConversation>;
  sendPeer?(input: Pick<DesktopPeerJob, "id" | "source" | "target" | "task" | "sourceSession" | "targetSession">): Promise<DesktopPeerJob>;
  peerStatus?(id: string): Promise<DesktopPeerJob>;
  chooseWorkspace(): Promise<void>;
  approve(id: string): Promise<void>;
  reject(id: string): Promise<void>;
  abort(): Promise<void>;
  openServer(hash?: string): Promise<void>;
  openConnection(): Promise<void>;
};
