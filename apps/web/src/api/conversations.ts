import { request } from "./request.js";

export const openDirectConversation = () => request<{ id: number }>("/api/conversations/direct", {});
