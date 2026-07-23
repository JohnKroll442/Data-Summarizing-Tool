/**
 * SAP-aligned chart palette read from the CSS variables in index.css.
 * Read once at module load — chart option builders import these as plain
 * hex strings and pass them straight to ECharts `color` arrays.
 */

function readVar(name, fallback) {
  if (typeof window === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name)
  return v.trim() || fallback
}

export const SAP_BLUE        = readVar('--sap-blue',        '#0070f2')
export const SAP_BLUE_DARK   = readVar('--sap-blue-dark',   '#0040b0')
export const SAP_BLUE_DARKER = readVar('--sap-blue-darker', '#00295c')
export const SAP_BLUE_LIGHT  = readVar('--sap-blue-light',  '#d1e8ff')
export const SAP_GOLD        = readVar('--sap-gold',        '#f0ab00')
export const SAP_GOLD_LIGHT  = readVar('--sap-gold-light',  '#ffd966')
export const SAP_TEXT        = readVar('--sap-text',        '#1d2d3e')
export const SAP_TEXT_MUTED  = readVar('--sap-text-muted',  '#556b82')
export const SAP_DANGER      = readVar('--sap-danger',      '#bb0000')
export const SAP_SUCCESS     = readVar('--sap-success',     '#107e3e')

// Cycle used wherever a chart needs N colors (pie slices, sankey nodes, etc).
export const SAP_PALETTE = [
  SAP_BLUE,
  SAP_GOLD,
  SAP_BLUE_DARK,
  SAP_SUCCESS,
  SAP_BLUE_LIGHT,
  SAP_GOLD_LIGHT,
  SAP_DANGER,
  SAP_BLUE_DARKER,
]

// Chart font stack — pulled from the app's --font-sans token (Geist) so charts
// match the rest of the UI. The old '72' family was never loaded here, so it
// silently fell back to a plain system font; using the real app font makes
// chart text look cleaner and consistent with everything around it.
export const CHART_FONT_FAMILY = readVar(
  '--font-sans',
  "'Geist Variable', -apple-system, 'Segoe UI', Roboto, system-ui, sans-serif",
)

// Shared base option fragments — every chart spreads these so tooltips,
// grids, and titles look the same across the app.
export const BASE_TEXT_STYLE = {
  fontFamily: CHART_FONT_FAMILY,
  color: SAP_TEXT,
}

/**
 * Responsive chart type sizes. ECharts needs pixel sizes, so we scale off the
 * document root font-size — which is itself fluid (clamp 16→20px across
 * viewport widths, see index.css) — and recompute at option-build time. Charts
 * therefore read bigger on larger screens, in step with the rest of the UI,
 * instead of being pinned at a tiny fixed px. All values are well above the old
 * hardcoded 11–12px so axis ticks, left-hand names, and annotations are
 * comfortably readable.
 */
export function chartFontSizes() {
  let root = 16
  if (typeof window !== 'undefined') {
    const px = parseFloat(getComputedStyle(document.documentElement).fontSize)
    if (Number.isFinite(px) && px > 0) root = px
  }
  return {
    axis:     Math.round(root * 0.875),   // tick labels + left-hand category names
    axisName: Math.round(root * 0.875),   // axis title, e.g. "Elapsed time"
    legend:   Math.round(root * 0.875),
    barLabel: Math.round(root * 0.8125),  // in-bar duration readouts
    markLine: Math.round(root * 0.8125),  // Action Start/End annotations
  }
}

export const BASE_TOOLTIP = {
  trigger: 'item',
  backgroundColor: 'rgba(255, 255, 255, 0.97)',
  borderColor: SAP_BLUE_LIGHT,
  textStyle: { color: SAP_TEXT },
}

export const BASE_GRID = {
  left: 48,
  right: 24,
  top: 32,
  bottom: 40,
  containLabel: true,
}
