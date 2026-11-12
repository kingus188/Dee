export interface DocumentVersion {
  id: string;
  createdAt: number;
  markdown: string;
}

// ponytail: device-local recovery, not a server revision log; bounded to avoid filling browser storage.
const prefix = "dee.document-timeline.v1:";
const maxVersions = 100;
const maxBytes = 1024 * 1024;

export function readDocumentTimeline(documentId: string): DocumentVersion[] {
  const raw = window.localStorage.getItem(prefix + documentId);
  if (raw === null) return [];
  if (raw.length * 2 > maxBytes) throw new Error("文档时间线缓存过大，原缓存未覆盖。");
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.length > maxVersions || !value.every(item =>
    item && typeof item.id === "string" && typeof item.markdown === "string" &&
    typeof item.createdAt === "number" && Number.isFinite(item.createdAt) && Math.abs(item.createdAt) <= 8.64e15) ||
    new Set(value.map(item => item.id)).size !== value.length) {
    throw new Error("文档时间线缓存损坏，原缓存未覆盖。");
  }
  return value;
}

export function appendDocumentVersion(versions: DocumentVersion[], markdown: string): DocumentVersion[] {
  if (versions.at(-1)?.markdown === markdown) return versions;
  const next = [...versions, { id: crypto.randomUUID(), createdAt: Date.now(), markdown }].slice(-maxVersions);
  // Bound each document's cache, retaining the latest version even if it is too
  // large to persist. The caller reports that failure rather than dropping text.
  while (next.length > 1 && JSON.stringify(next).length * 2 > maxBytes) next.shift();
  return next;
}

export function writeDocumentTimeline(documentId: string, versions: DocumentVersion[]): void {
  const raw = JSON.stringify(versions);
  if (raw.length * 2 > maxBytes) throw new Error("正文过大，时间线暂时只能保留在当前页面。");
  window.localStorage.setItem(prefix + documentId, raw);
}
