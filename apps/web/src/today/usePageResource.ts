import { useCallback, useEffect, useState } from "react";
import { request } from "../api/request.js";

const REFRESH_INTERVAL_MS = 30_000;

export type PageResource<T> = {
  data: T | null;
  loading: boolean;
  error: string;
  updatedAt: number | null;
  refresh: () => void;
};

export function usePageResource<T>(path: string, active: boolean, validate: (value: unknown) => value is T): PageResource<T> {
  const [state, setState] = useState<Omit<PageResource<T>, "refresh">>({ data: null, loading: true, error: "", updatedAt: null });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let pending = false;
    let timer: number | undefined;

    async function load() {
      if (disposed || pending || document.visibilityState === "hidden") return;
      pending = true;
      setState(previous => ({ ...previous, loading: true }));
      try {
        const data = await request<unknown>(path);
        if (!validate(data)) throw new Error("服务返回的数据格式不完整，请稍后重试。");
        if (!disposed) setState({ data, loading: false, error: "", updatedAt: Date.now() });
      } catch (error) {
        if (!disposed) setState(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : "读取失败，请重试。" }));
      } finally {
        pending = false;
      }
    }

    function start() {
      if (document.visibilityState === "hidden") return;
      void load();
      timer = window.setInterval(() => { void load(); }, REFRESH_INTERVAL_MS);
    }

    function onVisibilityChange() {
      window.clearInterval(timer);
      timer = undefined;
      start();
    }

    start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      // The request API has no abort signal. A disposed effect owns no later response.
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [active, path, revision, validate]);

  return { ...state, refresh };
}
