import { createContext, useContext, type ReactNode } from 'react'

// The dashboard pages (list, dashboard, Studio's Search) serve two experiences
// side by side, so people can try both:
//   - classic, under /dashboards and /studio: ShuttleViz is SpotterViz embedded
//     in the dashboard's edit mode (src/components/ShuttleBuilder.tsx);
//   - Dashboard Lab, under /lab: the same pages, but ShuttleViz is a
//     conversation over ThoughtSpot's Spotter MCP Server (src/pages/LabBuilder.tsx).
// Pages link through these paths so each experience stays within itself.

export type Experience = 'classic' | 'lab'

const q = (id?: string | null) => (id ? `&dashboard=${id}` : '')

const PATHS = {
  classic: {
    home: '/dashboards',
    view: (id: string) => `/dashboards/${id}`,
    search: (id?: string | null) => `/studio?mode=search${q(id)}`,
    editChart: (id: string, vizId: string) => `/studio?mode=search&dashboard=${id}&edit=${vizId}`,
    shuttleViz: (id?: string | null) => `/studio?mode=ai${q(id)}`,
  },
  lab: {
    home: '/lab',
    view: (id: string) => `/lab/dashboards/${id}`,
    search: (id?: string | null) => `/lab/studio?mode=search${q(id)}`,
    editChart: (id: string, vizId: string) => `/lab/studio?mode=search&dashboard=${id}&edit=${vizId}`,
    shuttleViz: (id?: string | null) => `/lab/shuttleviz/${id ?? 'new'}`,
  },
}

const ExperienceContext = createContext<Experience>('classic')

export function ExperienceProvider({ experience, children }: { experience: Experience; children: ReactNode }) {
  return <ExperienceContext.Provider value={experience}>{children}</ExperienceContext.Provider>
}

export const useExperience = () => useContext(ExperienceContext)

export const usePaths = () => PATHS[useExperience()]
