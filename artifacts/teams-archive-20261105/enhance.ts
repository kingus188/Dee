import { teamsMedia } from "../../apps/web/src/chat/TeamsMedia.js";

// 当前线上资源比本地工作区更新；本次按既有工具结果补充附件，下一次完整构建由 React 组件负责。
export function startTeamsMedia(document: Document) {
  function render() {
    for (const turn of document.querySelectorAll<HTMLElement>(".chat-turn")) {
      const existing = turn.querySelector<HTMLElement>(".teams-media-inline");
      if (existing && !existing.dataset.enhanced) continue;
      const activities = [...turn.querySelectorAll(".turn-activity pre")].map((pre, index) => ({ id: String(index), name: "teams_history", status: "completed" as const, text: pre.textContent ?? "" }));
      const media = teamsMedia(activities), signature = JSON.stringify(media);
      if (!media.length) { existing?.remove(); continue; }
      if (existing?.dataset.signature === signature) continue;
      const host = existing ?? document.createElement("div");
      host.className = "user-attachments-grid teams-media-inline";
      host.dataset.enhanced = "true"; host.dataset.signature = signature;
      host.replaceChildren();
      for (const item of media) {
        if (item.kind === "image" && item.previewUrl) {
          const a = document.createElement("a"), image = document.createElement("img");
          a.className = "msg-image-link"; a.href = item.previewUrl; a.target = "_blank"; a.rel = "noopener noreferrer";
          image.className = "msg-image-thumb"; image.src = item.previewUrl; image.alt = item.name; image.loading = "lazy";
          a.append(image); host.append(a);
        } else {
          const card = document.createElement("div"), label = document.createElement(item.url ? "a" : "span");
          card.className = "msg-file-card"; label.textContent = item.name;
          if (item.url) { (label as HTMLAnchorElement).href = item.url; (label as HTMLAnchorElement).target = "_blank"; (label as HTMLAnchorElement).rel = "noopener noreferrer"; }
          else { const status = document.createElement("small"); status.textContent = item.status === "failed" ? "保存失败" : item.status === "pending" ? "正在保存" : "暂无可用链接"; label.append(status); }
          card.append(label); host.append(card);
        }
      }
      if (!existing) turn.insertBefore(host, turn.querySelector(":scope > .turn-activities"));
    }
  }
  let queued = false;
  const observer = new document.defaultView!.MutationObserver(() => {
    if (!queued) { queued = true; queueMicrotask(() => { queued = false; render(); }); }
  });
  render(); observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}
if (typeof document !== "undefined") startTeamsMedia(document);
