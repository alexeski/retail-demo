import { useEffect, useRef, useState } from 'react'

/**
 * The height that takes an element from where it sits on the page (scrolled to
 * the top) down to the bottom of the window, at least `min`. Studio uses it so
 * the dashboard fills the screen below its header.
 */
export function useFillHeight<T extends HTMLElement>(min = 560, gap = 0) {
  const ref = useRef<T>(null)
  const [height, setHeight] = useState(min)

  useEffect(() => {
    const measure = () => {
      const el = ref.current
      if (!el) return
      const top = el.getBoundingClientRect().top + window.scrollY
      setHeight(Math.max(min, Math.floor(window.innerHeight - top - gap)))
    }
    measure()
    window.addEventListener('resize', measure)
    // The header above can wrap (long titles, narrow windows): follow its size too.
    const observer = new ResizeObserver(measure)
    if (ref.current?.parentElement) observer.observe(ref.current.parentElement)
    return () => {
      window.removeEventListener('resize', measure)
      observer.disconnect()
    }
  }, [min, gap])

  return [ref, height] as const
}
