export type TaskPanelContext = {
  run: (action: () => Promise<unknown>) => Promise<void>;
  isCurrent: (sequence: number, id?: string | null) => boolean;
  say: (message: string) => void;
};
export function currentId() {
  const id = location.hash.replace(/^#/, "");
  return /^\d+$/.test(id) ? id : null;
}
export const base = () => "/api/conversations/" + currentId();
