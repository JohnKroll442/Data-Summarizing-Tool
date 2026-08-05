import { createContext, useContext } from 'react'
import { createPortal } from 'react-dom'

// A shared DOM node, rendered by the SummaryPage shell directly above the
// Activity Timeline. Each view portals its heading + KPI strip into it, so
// those sit at the very top of the page while the timeline — which lives once
// in the shell and keeps its zoom/collapse state across tab switches — stays
// below them. Pure CSS can't do this: the heading/KPIs are nested deep inside
// the <Outlet>, the timeline is a sibling above it, so there's no common flow
// to reorder them in.
const HeaderSlotContext = createContext(null)
export const HeaderSlotProvider = HeaderSlotContext.Provider

// Portals its children into the shared header slot. Renders nothing until the
// slot mounts (one tick after the shell's first paint, once the ref callback
// has set state), then re-renders into it.
export function HeaderPortal({ children }) {
  const slot = useContext(HeaderSlotContext)
  return slot ? createPortal(children, slot) : null
}
