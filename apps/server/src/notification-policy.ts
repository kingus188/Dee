import type { NotificationPriority, NotificationQuietHours } from "@assistant/contracts";
import { nextNotificationAt } from "./notification-quiet-hours.js";

// Only structured priority can bypass quiet hours. Never classify urgency from message text.
export function notificationDeliveryAt(quiet: NotificationQuietHours, at: number, priority: NotificationPriority = "normal", availableAt = at): number {
  if (priority === "urgent" || priority === "approval") return at;
  return nextNotificationAt(quiet, Math.max(at, availableAt));
}
