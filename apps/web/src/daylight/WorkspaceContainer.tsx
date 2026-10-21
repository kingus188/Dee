import { createContext, useContext } from 'react'

export const WorkspaceContainer = createContext<() => HTMLElement>(() => document.body)

/** All Ant portals belong to this workspace, including while it is hidden. */
export function useDaylightContainer() {
  return useContext(WorkspaceContainer)
}
