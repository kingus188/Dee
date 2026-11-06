import type { ToolActivity } from "./activities.js";

export type Media = { id: string; name: string; kind: "image" | "file"; status: string; url?: string; previewUrl?: string };
const imagePath = /^\/api\/teams\/media\/[a-f0-9]{64}$/;
function link(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  if (imagePath.test(value)) return value;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}

export function teamsMedia(activities: ToolActivity[]): Media[] {
  const found = new Map<string, Media>();
  for (const activity of activities) {
    if (!activity.name.startsWith("teams_") || activity.status !== "completed") continue;
    for (const marker of activity.text.matchAll(/^<teams-media>([^\n]*)<\/teams-media>$/gm)) {
      let items: unknown;
      try { items = JSON.parse(marker[1]); } catch { continue; }
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (!item || typeof item.id !== "string" || !/^[a-f0-9]{64}$/.test(item.id) || typeof item.name !== "string" || !["image", "file"].includes(item.kind)) continue;
        found.set(item.id, { id: item.id, name: item.name, kind: item.kind, status: item.status,
          url: link(item.url), previewUrl: typeof item.previewUrl === "string" && imagePath.test(item.previewUrl) ? item.previewUrl : undefined });
      }
    }
  }
  return [...found.values()];
}

export function MediaItems({ media }: { media: Media[] }) {
  return <>{media.map(item => item.kind === "image" && item.previewUrl
    ? <a key={item.id} href={item.previewUrl} target="_blank" rel="noopener noreferrer" className="msg-image-link"><img className="msg-image-thumb" src={item.previewUrl} alt={item.name} loading="lazy" /></a>
    : <div className="msg-file-card" key={item.id}>{item.url
      ? <a href={item.url} target="_blank" rel="noopener noreferrer">{item.name}</a>
      : <span>{item.name}<small>{item.status === "failed" ? "保存失败" : item.status === "pending" ? "正在保存" : "暂无可用链接"}</small></span>}</div>)}</>;
}

export function TeamsMedia({ activities }: { activities: ToolActivity[] }) {
  const media = teamsMedia(activities);
  if (!media.length) return null;
  return <div className="user-attachments-grid teams-media-inline"><MediaItems media={media} /></div>;
}
