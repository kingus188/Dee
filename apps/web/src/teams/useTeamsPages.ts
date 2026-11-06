import { useCallback, useEffect, useRef, useState } from "react";
import { request } from "../api/request.js";

type Page = { items: { id: string }[]; nextCursor: string | null };
type State<T> = { data: T | null; loading: boolean; error: string };
/** Read-only pages: clear sensitive cached text on failure and reject late responses. */
export function useTeamsPages<T extends Page>(path: string, active: boolean, validate: (value: unknown) => value is T, merge: (previous: T, next: T) => T) {
  const [state, setState] = useState<State<T>>({ data: null, loading: false, error: "" });
  const current = useRef(state); current.current = state;
  const enabled = useRef(active); enabled.current = active;
  const generation = useRef(0), pending = useRef(false), cursors = useRef(new Set<string>());
  const load = useCallback(async (more = false) => {
    if (!enabled.current || pending.current) return;
    const previous = current.current.data, cursor = more ? previous?.nextCursor : undefined;
    if (more && !cursor) return;
    const epoch = generation.current;
    pending.current = true;
    if (!more) cursors.current.clear();
    setState({ data: more ? previous : null, loading: true, error: "" });
    try {
      const value = await request<unknown>(path + (cursor ? `${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}` : ""));
      if (epoch !== generation.current || !enabled.current) return;
      if (!validate(value)) throw new Error("Teams 返回的数据格式不完整，请重新读取。");
      if (value.nextCursor && (value.nextCursor === cursor || cursors.current.has(value.nextCursor))) throw new Error("Teams 分页未推进，请重新读取。");
      if (cursor) cursors.current.add(cursor);
      setState({ data: more && previous ? merge(previous, value) : value, loading: false, error: "" });
    } catch (error) {
      if (epoch === generation.current && enabled.current) setState({ data: null, loading: false, error: error instanceof Error ? error.message : "Teams 读取失败，请重试。" });
    } finally { if (epoch === generation.current) pending.current = false; }
  }, [path, validate, merge]);
  useEffect(() => {
    generation.current++; pending.current = false; cursors.current.clear();
    current.current = { data: null, loading: false, error: "" }; setState(current.current);
    if (active) void load();
    return () => { generation.current++; pending.current = false; };
  }, [active, load]);
  function refresh() {
    if (!enabled.current) return;
    // An action can invalidate the source while an older page is in flight.
    // Supersede that page immediately instead of letting the busy guard retain it.
    generation.current++; pending.current = false; cursors.current.clear();
    current.current = { data: null, loading: false, error: "" }; setState(current.current);
    void load();
  }
  return { ...state, refresh, more: () => { void load(true); } };
}
