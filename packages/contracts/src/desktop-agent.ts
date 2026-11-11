export type DesktopModelInput = {
  api: string; baseUrl: string; model: string; apiKey?: string; contextWindow: number; maxTokens: number;
};
export type DesktopAgentKind = "pi" | "codex" | "claude" | "acp";
export type ExternalAgentConfig = { executable: string; args: string[]; mode?: string };
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
};
export type DesktopAgentSnapshot = {
  agent?: DesktopAgentKind;
  agentConfig?: ExternalAgentConfig;
  external?: ExternalAgentState;
  piConfigured?: boolean;
  configured: boolean;
  model: Omit<DesktopModelInput, "apiKey"> & { hasApiKey: boolean };
  workspace: string | null; nodeId: string; busy: boolean;
  messages: Array<{ id: string; role: "user" | "assistant"; text: string }>;
  jobs: DesktopPeerJob[]; serverConnected: boolean; error?: string;
};
export type DesktopAgentBridge = {
  snapshot(): Promise<DesktopAgentSnapshot>;
  saveModel(input: DesktopModelInput): Promise<{ persistedKey: boolean }>;
  selectAgent(input: DesktopAgentSelection): Promise<void>;
  newSession(): Promise<void>;
  answerApproval(input: AgentApprovalAnswer): Promise<void>;
  send(input: { id: string; text: string }): Promise<void>;
  chooseWorkspace(): Promise<void>;
  approve(id: string): Promise<void>;
  reject(id: string): Promise<void>;
  abort(): Promise<void>;
  openServer(): Promise<void>;
  openConnection(): Promise<void>;
};
