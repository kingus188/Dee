import type { PageResource } from "./usePageResource.js";

export function ResourceFeedback<T>({ resource, label, scope = "today" }: { resource: PageResource<T>; label: string; scope?: "today" | "activity" }) {
  return <>
    {resource.loading && !resource.data && <p className={`${scope}-feedback`} role="status">正在读取{label}…</p>}
    {resource.error && <div className={`${scope}-feedback ${scope}-feedback-error`} role="alert">
      <p>{label}读取失败：{resource.error}</p>
      {resource.data && <p>下方保留上次成功读取的内容，状态可能已有变化。</p>}
      <button type="button" className={`${scope}-text-button`} disabled={resource.loading} onClick={resource.refresh}>重新读取</button>
    </div>}
  </>;
}
