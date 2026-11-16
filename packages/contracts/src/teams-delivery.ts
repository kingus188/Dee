export type TeamsDeliveryIssue = {
  id: string; state: "sending" | "unknown"; createdAt: number; sourceCount: number;
  sourceStatus: "current" | "invalidated"; receipt: "unavailable";
};
export type TeamsDeliveryIssues = { available: boolean; items: TeamsDeliveryIssue[]; truncated: boolean };
export type TeamsDeliveryRecheck = {
  item: TeamsDeliveryIssue; sourceCheck: "verified" | "invalidated";
  deliveryCheck: "unconfirmed";
};
