// The width below which the bar and the view header are a phone's: DSH's drawer takes over the
// sidebar, and the header keeps only what a phone has room for. One number for both, and the
// sheet's media query (left-bar-css.js) says the same.
import { useEffect, useState } from 'react'

export const NARROW = 620

/** Whether the window is at the phone's width, kept live across resizes. */
export function useNarrow() {
  const [narrow, setNarrow] = useState(typeof window !== 'undefined' && window.innerWidth <= NARROW)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
    const read = () => setNarrow(window.innerWidth <= NARROW)
    read()
    window.addEventListener('resize', read)
    return () => window.removeEventListener('resize', read)
  }, [])
  return narrow
}
