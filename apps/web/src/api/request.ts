import { apiClient } from "./socket.js";
export const request = <T = unknown>(path: string, body?: unknown) => apiClient.request<T>(path, body);
