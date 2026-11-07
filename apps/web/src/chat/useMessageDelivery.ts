import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { AttachmentSummary, ConversationView, MessageRequest } from "@assistant/contracts";
import type { PendingAttachment } from "../types.js";
import { readMessageStatus, sendMessage } from "../api/chat.js";

export type PendingMessage = {
  requestId: string; conversationId: number | null; text: string; attachments: AttachmentSummary[];
  status: "sending" | "waiting" | "unconfirmed" | "stopped"; entryId?: number;
};
export type MessageSender = (body: MessageRequest & { requestId: string }, files: PendingAttachment[], onConnected?: (id: number) => void) => Promise<void>;

export function useMessageDelivery(view: ConversationView | null, selected: RefObject<number | null>, connect: () => Promise<number>) {
  const [messages, setMessages] = useState<PendingMessage[]>([]);
  const pending = useRef(messages);
  const lastFrame = useRef("");
  function update(change: (items: PendingMessage[]) => PendingMessage[]) {
    pending.current = change(pending.current); setMessages(pending.current);
  }
  async function check(message: PendingMessage): Promise<boolean> {
    if (message.conversationId === null) return false;
    try {
      const result = await readMessageStatus(message.conversationId, message.requestId);
      if (!result) return false;
      update(items => items.map(item => item.requestId !== message.requestId ? item : {
        ...item, entryId: result.entryId ?? item.entryId,
        status: result.status === "unanswered" && result.entryId === undefined ? "stopped" : item.status === "stopped" ? "stopped" : "waiting",
      }));
      return true;
    } catch {
      // A failed status read cannot establish whether the message was received.
      return false;
    }
  }
  async function reconcile(data: ConversationView) {
    const frame = `${data.conversationId}:${data.entries.at(-1)?.id}:${data.inbox}:${data.busy}`;
    if (frame === lastFrame.current) return;
    lastFrame.current = frame;
    const confirmed = await Promise.all(pending.current.filter(item => item.conversationId === data.conversationId && item.entryId === undefined && item.status !== "stopped").map(check));
    if (confirmed.some(value => !value)) lastFrame.current = "";
  }
  const send: MessageSender = async (body, files, onConnected) => {
    let message: PendingMessage = {
      requestId: body.requestId, conversationId: selected.current, text: body.text ?? "", status: "sending",
      attachments: files.map(file => ({ kind: file.kind, name: file.name, mimeType: file.mimeType, size: file.size,
        ...(file.kind === "image" ? { url: `data:${file.mimeType};base64,${file.data}` } : {}) })),
    };
    update(items => [...items.filter(item => item.requestId !== body.requestId), message]);
    try {
      const conversationId = await connect();
      onConnected?.(conversationId);
      message = { ...message, conversationId };
      update(items => items.map(item => item.requestId === body.requestId ? { ...item, conversationId: message.conversationId } : item));
      await sendMessage(conversationId, body);
      update(items => items.map(item => item.requestId === body.requestId && item.status === "sending" ? { ...item, status: "waiting" } : item));
      void check(message);
    } catch (error) {
      const known = pending.current.find(item => item.requestId === body.requestId);
      if (!known || known.status === "waiting" || known.status === "stopped") return;
      update(items => items.map(item => item.requestId === body.requestId ? { ...item, status: "unconfirmed" } : item));
      void check(message);
      throw error;
    }
  };
  const selectedId = selected.current;
  const visible = useMemo(() => messages.filter(item => item.conversationId === selectedId &&
    !(view?.conversationId === item.conversationId && view.entries.some(entry => entry.id === item.entryId))), [messages, selectedId, view]);
  useEffect(() => {
    if (!view) return;
    const represented = new Set(view.entries.map(entry => entry.id));
    if (pending.current.some(item => item.conversationId === view.conversationId && item.entryId !== undefined && represented.has(item.entryId))) {
      update(items => items.filter(item => item.conversationId !== view.conversationId || item.entryId === undefined || !represented.has(item.entryId)));
    }
  }, [view, messages]);
  return { pendingMessages: visible, send, reconcile };
}
