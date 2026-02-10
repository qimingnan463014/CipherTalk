import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type AssistantFilterMode = 'all' | 'whitelist' | 'blacklist'

interface AssistantFilterState {
  filterMode: AssistantFilterMode
  selectedSessionIds: string[]
  setFilterMode: (mode: AssistantFilterMode) => void
  toggleSession: (sessionId: string) => void
  setSelectedSessionIds: (sessionIds: string[]) => void
  clearSelection: () => void
}

const storageKey = 'assistant-filter-preferences'

export const useAssistantStore = create<AssistantFilterState>()(
  persist(
    (set, get) => ({
      filterMode: 'all',
      selectedSessionIds: [],
      setFilterMode: (mode) => set({ filterMode: mode }),
      toggleSession: (sessionId) => {
        const current = new Set(get().selectedSessionIds)
        if (current.has(sessionId)) {
          current.delete(sessionId)
        } else {
          current.add(sessionId)
        }
        set({ selectedSessionIds: Array.from(current) })
      },
      setSelectedSessionIds: (sessionIds) => set({ selectedSessionIds: sessionIds }),
      clearSelection: () => set({ selectedSessionIds: [] })
    }),
    {
      name: storageKey,
      partialize: (state) => ({
        filterMode: state.filterMode,
        selectedSessionIds: state.selectedSessionIds
      })
    }
  )
)
