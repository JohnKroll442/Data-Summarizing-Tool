/**
 * scrollFast(el)
 *
 * Scrolls `el` into view using a 200 ms ease-out cubic animation — roughly
 * 2–3× faster than the browser's native scrollIntoView({ behavior: 'smooth' })
 * which can take 400–700 ms. Falls back to an instant jump for users who have
 * prefers-reduced-motion set.
 *
 * Pass the DOM node directly. The caller is responsible for any deferred
 * invocation (e.g. wrapping in requestAnimationFrame when the element may not
 * yet be in the DOM on first render).
 */
export function scrollFast(el) {
  if (!el) return

  // Instant jump for reduced-motion preference.
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    el.scrollIntoView({ behavior: 'auto', block: 'start' })
    return
  }

  // Align the element top with the viewport top, leaving a 12 px breathing gap.
  const targetY = el.getBoundingClientRect().top + window.scrollY - 12
  const startY  = window.scrollY
  const distance = targetY - startY

  // Skip the animation when we're already there (avoids a no-op rAF loop).
  if (Math.abs(distance) < 2) return

  const duration  = 200 // ms
  const startTime = performance.now()

  // Ease-out cubic: accelerates immediately then decelerates at destination.
  const easeOut = (t) => 1 - Math.pow(1 - t, 3)

  const step = (now) => {
    const progress = Math.min((now - startTime) / duration, 1)
    window.scrollTo(0, startY + distance * easeOut(progress))
    if (progress < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}
