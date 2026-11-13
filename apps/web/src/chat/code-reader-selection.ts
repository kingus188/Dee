// One read-only overlay across all messages/results, including during lazy loading.
let active: string | null = null;
const listeners = new Set<() => void>();
export const readerSelection = {
  get: () => active,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  open(id: string) { active = id; listeners.forEach(listener => listener()); },
  close(id: string) { if (active === id) { active = null; listeners.forEach(listener => listener()); } },
};
