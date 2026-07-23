import { useEffect, useState } from 'react'

/**
 * Re-render on viewport resize, debounced to animation frames.
 *
 * Chart option builders read the fluid root font-size (clamp 16→20px in
 * index.css) at build time to size their text responsively. A chart already
 * mounted in a modal needs to rebuild its option when the window crosses that
 * size range for the text to rescale — this hook provides a value that changes
 * on resize so the consuming component (and any option useMemo keyed on it)
 * re-runs. Returns the current innerWidth as a convenient dependency key.
 */
export function useViewportWidth() {
  const [width, setWidth] = useState(() =>
    typeof window === 'undefined' ? 0 : window.innerWidth
  )

  useEffect(() => {
    let raf = 0
    const onResize = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setWidth(window.innerWidth))
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      cancelAnimationFrame(raf)
    }
  }, [])

  return width
}
