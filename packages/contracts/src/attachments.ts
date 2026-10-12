export type AttachmentInput = { name: string; mimeType: string; data: string };
export type AttachmentSummary = { kind: "image" | "text"; name: string; mimeType: string; size: number; index?: number; url?: string };
