import { useEffect } from "react";

export function useUnsavedChanges(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
}

export function mayDiscard(dirty: boolean) {
  return !dirty || window.confirm("有未保存的修改，放弃这些修改吗？");
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，修改仍保留，请重试。";
}
