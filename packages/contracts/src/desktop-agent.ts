export type DesktopModelInput = {
  api: string; baseUrl: string; model: string; apiKey?: string; contextWindow: number; maxTokens: number;
};
export type DesktopPeerJob = {
  id: string; source: string; target: string; task: string;
  status: "queued" | "running" | "done" | "failed";
  result?: string; createdAt: string; updatedAt: string;
};
export type DesktopAgentSnapshot = {
  configured: boolean;
  model: Omit<DesktopModelInput, "apiKey"> & { hasApiKey: boolean };
  workspace: string | null; nodeId: string; busy: boolean;
  messages: Array<{ id: string; role: "user" | "assistant"; text: string }>;
  jobs: DesktopPeerJob[]; serverConnected: boolean; error?: string;
};
export type DesktopAgentBridge = {
  snapshot(): Promise<DesktopAgentSnapshot>;
  saveModel(input: DesktopModelInput): Promise<{ persistedKey: boolean }>;
  send(input: { id: string; text: string }): Promise<void>;
  chooseWorkspace(): Promise<void>;
  approve(id: string): Promise<void>;
  reject(id: string): Promise<void>;
  abort(): Promise<void>;
  openServer(): Promise<void>;
  openConnection(): Promise<void>;
};
