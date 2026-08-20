/**
 * scrollFast(el, duration?)
 *
 * Scrolls `el` into view using a smooth ease-in-out cubic animation.
 *
 * `duration` (ms, default 200) controls the speed:
 *   - 200 ms  — snappy, used by the Widget view (user-preferred)
 *   - 350 ms  — polished, used by the Action view where the panel also animates in
 *
 * Both are 2–3× faster than the browser's native scrollIntoView({ behavior: 'smooth' })
 * which can take 400–700 ms. Falls back to an instant jump for users who have
 * prefers-reduced-motion set.
 *
 * Pass the DOM node directly. The caller is responsible for any deferred
 * invocation (e.g. wrapping in requestAnimationFrame when the element may not
 * yet be in the DOM on first render).
 */
export function scrollFast(el, duration = 200) {
  if (!el) return

  // Instant jump for reduced-motion preference.
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    el.scrollIntoView({ behavior: 'auto', block: 'start' })
    return
  }

  // Align the element top with the viewport top, leaving a 12 px breathing gap.
  const targetY  = el.getBoundingClientRect().top + window.scrollY - 12
  const startY   = window.scrollY
  const distance = targetY - startY

  // Skip the animation when we're already there (avoids a no-op rAF loop).
  if (Math.abs(distance) < 2) return

  const startTime = performance.now()

  // Ease-in-out cubic: gentle acceleration → full speed → gentle deceleration.
  // Feels more deliberate and premium than pure ease-out, especially when the
  // destination panel is also animating into existence at the same time.
  const easeInOut = (t) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

  const step = (now) => {
    const progress = Math.min((now - startTime) / duration, 1)
    window.scrollTo(0, startY + distance * easeInOut(progress))
    if (progress < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}
