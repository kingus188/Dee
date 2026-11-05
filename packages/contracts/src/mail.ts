export type MailSettingsInput = { enabled: boolean; tenantId: string; clientId: string; authMode?: "device" | "account" };
export type MailStatus = MailSettingsInput & {
  connected: boolean; offline: boolean; lastSuccessAt: string | null; error: string;
  syncing: boolean; initialComplete: boolean;
  authMode: "device" | "account"; savedAccountAvailable: boolean;
  login: { userCode: string; verificationUri: string; expiresAt: number } | null;
};
export type MailMessage = {
  id: string; subject: string; sender: string; address: string; receivedAt: string;
  preview: string; isRead: boolean; hasAttachments: boolean;
  importance?: "low" | "normal" | "high";
};
export type MailNotice = { sequence: number; message: MailMessage };
export type MailNotices = {
  latest: number; items: MailNotice[];
  // Delivery responses may summarize more messages than the bounded preview list.
  cursor?: number; total?: number; urgent?: boolean;
  delivery?: { id: string; token: string; leaseUntil: number };
};
