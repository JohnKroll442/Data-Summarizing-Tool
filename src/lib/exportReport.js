/**
 * exportReport — builds an Action Performance Report and downloads it directly
 * as a named PDF file. No print dialog, no new tab — just a clean download.
 *
 * Requires:  npm install jspdf jspdf-autotable
 */

import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { ANOMALY_TYPES } from './anomalyDetect'
import { formatDurationMs, formatCount } from './format'
import { generateInsights, topAnomalousActions, durationProfile } from './generateInsights'

// ── Shared palette (RGB arrays for jsPDF) ─────────────────────────────────────
const BLUE      = [0,   112, 242]
const BLUE_DARK = [0,    64, 176]  // eslint-disable-line no-unused-vars
const BLUE_BG   = [240, 246, 255]
const YELLOW_BG = [255, 251, 230]
const YELLOW_BD = [255, 224, 102]
const RED       = [187,   0,   0]
const RED_BG    = [255, 243, 243]
const MUTED     = [134, 150, 169]
const TEXT      = [ 29,  45,  62]
const BORDER    = [217, 221, 227]
const SURFACE   = [255, 255, 255]
const ROW_ALT   = [245, 246, 247]

// A4 page geometry
const PW = 210
const PH = 297
const ML = 16
const MR = 16
const CW = PW - ML - MR

// ── Drawing helpers ───────────────────────────────────────────────────────────

function setFont(doc, size, style = 'normal', color = TEXT) {
  doc.setFontSize(size)
  doc.setFont('helvetica', style)
  doc.setTextColor(...color)
}

function sectionHeader(doc, title, y) {
  setFont(doc, 8, 'bold', BLUE)
  doc.text(title.toUpperCase(), ML, y)
  doc.setDrawColor(...BLUE)
  doc.setLineWidth(0.4)
  doc.line(ML, y + 1.5, ML + CW, y + 1.5)
  return y + 6
}

function kpiTile(doc, x, y, w, h, label, value, accentColor = BLUE) {
  doc.setFillColor(...SURFACE)
  doc.setDrawColor(...BORDER)
  doc.setLineWidth(0.3)
  doc.roundedRect(x, y, w, h, 1.5, 1.5, 'FD')
  doc.setFillColor(...accentColor)
  doc.roundedRect(x, y, w, 2, 1, 1, 'F')
  doc.rect(x, y + 1, w, 1, 'F')
  setFont(doc, 7, 'normal', MUTED)
  doc.text(label, x + 4, y + 8)
  setFont(doc, 13, 'bold', TEXT)
  doc.text(value ?? '—', x + 4, y + 17)
  return x + w + 3
}

function multiLine(doc, text, x, y, maxW, size, style = 'normal', color = TEXT) {
  if (!text) return y
  setFont(doc, size, style, color)
  const lines = doc.splitTextToSize(String(text), maxW)
  doc.text(lines, x, y)
  return y + lines.length * (size * 0.4)
}

function calloutBox(doc, y, bg, border, content) {
  const pad = 4
  setFont(doc, 9, 'normal', TEXT)
  const lines = doc.splitTextToSize(content, CW - pad * 2 - 3)
  const boxH  = lines.length * 4 + pad * 2
  doc.setFillColor(...bg)
  doc.setDrawColor(...border)
  doc.setLineWidth(0.3)
  doc.roundedRect(ML, y, CW, boxH, 2, 2, 'FD')
  doc.setFillColor(...border)
  doc.roundedRect(ML, y, 2.5, boxH, 1, 1, 'F')
  doc.rect(ML + 1.5, y, 1, boxH, 'F')
  setFont(doc, 9, 'normal', TEXT)
  doc.text(lines, ML + pad + 2, y + pad + 2)
  return y + boxH + 4
}

// ── Main export function ──────────────────────────────────────────────────────

export function exportActionReport({
  fileName, anomalies, filteredSummary, filteredAnomalyRows,
  activeFilters, kpis, aggRows, thresholds,
}) {
  const rowsForTables = filteredAnomalyRows?.length > 0
    ? filteredAnomalyRows
    : anomalies?.rows ?? []

  const insights    = generateInsights({ anomalies, filteredSummary, filteredAnomalyRows, kpis, thresholds })
  const topActions  = topAnomalousActions(rowsForTables, 25)
  const durProfile  = durationProfile(aggRows, 15)
  const summary     = filteredSummary ?? anomalies
  const hasFilters  = activeFilters?.length > 0
  const generatedAt = new Date().toLocaleString()

  // ── Extract KPI values ───────────────────────────────────────────────────────
  const totalActionsVal = kpis?.find((k) => k.label === 'Total actions')?.value ?? '—'
  const overSlowVal     = kpis?.find((k) => k.label?.startsWith('>'))?.value ?? '—'
  const overSlowLabel   = kpis?.find((k) => k.label?.startsWith('>'))?.label ?? '>2m actions'
  const medianVal       = kpis?.find((k) => k.label?.toLowerCase().includes('median'))?.value ?? '—'
  const p90Val          = kpis?.find((k) => k.label?.startsWith('p90'))?.value ?? '—'
  const p95Val          = kpis?.find((k) => k.label?.startsWith('p95'))?.value ?? '—'

  const flaggedActions  = summary?.totalFlagged?.actions ?? 0
  const flaggedPct      = Math.round((summary?.totalFlagged?.pct ?? 0) * 100)
  const flaggedVal      = flaggedActions > 0 ? `${formatCount(flaggedActions)} (${flaggedPct}%)` : '0'
  const flaggedColor    = flaggedActions > 0 ? RED : [30, 138, 69]

  // ── Build PDF ────────────────────────────────────────────────────────────────
  const doc  = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  let   y    = 0

  // ── Header bar ──────────────────────────────────────────────────────────────
  doc.setFillColor(...BLUE)
  doc.rect(0, 0, PW, 30, 'F')
  setFont(doc, 17, 'bold', [255, 255, 255])
  doc.text('Action Performance Report', ML, 13)
  setFont(doc, 8, 'normal', [220, 235, 255])
  doc.text(fileName ?? 'Unnamed file', ML, 21)
  doc.text(`Generated ${generatedAt}`, PW - MR, 21, { align: 'right' })
  y = 36

  // ── Active filters banner ───────────────────────────────────────────────────
  if (hasFilters) {
    const pillRows   = activeFilters ?? []
    const lineH      = 5
    const bannerH    = 8 + pillRows.length * lineH
    doc.setFillColor(...YELLOW_BG)
    doc.setDrawColor(...YELLOW_BD)
    doc.setLineWidth(0.3)
    doc.roundedRect(ML, y, CW, bannerH, 2, 2, 'FD')
    setFont(doc, 8, 'bold', [122, 92, 0])
    doc.text('Filtered view', ML + 4, y + 5)
    setFont(doc, 7.5, 'normal', [122, 92, 0])
    pillRows.forEach((f, i) => {
      doc.text(`• ${f}`, ML + 4, y + 5 + (i + 1) * lineH)
    })
    y += bannerH + 4
  }

  // ── KPI tiles ───────────────────────────────────────────────────────────────
  y = sectionHeader(doc, 'Key Metrics', y)
  const tileW = (CW - 5 * 3) / 6
  const tileH = 22
  let tx = ML
  tx = kpiTile(doc, tx, y, tileW, tileH, 'Total Actions',  totalActionsVal, BLUE)
  tx = kpiTile(doc, tx, y, tileW, tileH, 'Anomalous',      flaggedVal,       flaggedColor)
  tx = kpiTile(doc, tx, y, tileW, tileH, overSlowLabel,    overSlowVal,      flaggedActions > 0 ? [231, 101, 0] : BLUE)
  tx = kpiTile(doc, tx, y, tileW, tileH, 'Median Duration', medianVal,       BLUE)
  tx = kpiTile(doc, tx, y, tileW, tileH, 'p90 Duration',   p90Val,           BLUE)
  kpiTile(doc, tx, y, tileW, tileH, 'p95 Duration',        p95Val,           BLUE)
  y += tileH + 8

  // ── Executive summary ────────────────────────────────────────────────────────
  y = sectionHeader(doc, 'Executive Summary', y)

  setFont(doc, 11, 'bold', TEXT)
  const headLines = doc.splitTextToSize(insights.headline, CW)
  doc.text(headLines, ML, y)
  y += headLines.length * 5 + 2

  if (insights.kpiLine) {
    y = multiLine(doc, insights.kpiLine, ML, y, CW, 8.5, 'normal', MUTED) + 3
  }

  if (insights.topIssues.length > 0) {
    setFont(doc, 8.5, 'bold', TEXT)
    doc.text('Top issues:', ML, y)
    y += 5
    insights.topIssues.forEach((issue) => {
      setFont(doc, 8.5, 'normal', TEXT)
      doc.text(`• ${issue.label} — ${issue.count} action${issue.count === 1 ? '' : 's'} (${issue.pct}%)`, ML + 3, y)
      y += 4.5
    })
    y += 2
  }

  if (insights.worstOffender) {
    const wo = insights.worstOffender
    const woText = [
      `Worst offender: ${wo.actionName}`,
      wo.story ? `  Story: ${wo.story}` : null,
      `  Duration: ${wo.duration}`,
      wo.flagLabels.length ? `  Issues: ${wo.flagLabels.join(', ')}` : null,
    ].filter(Boolean).join('\n')
    y = calloutBox(doc, y, RED_BG, RED, woText) + 2
  }

  if (insights.recommendation) {
    y = calloutBox(doc, y, BLUE_BG, BLUE, `Recommendation: ${insights.recommendation}`) + 2
  }

  // ── Anomaly breakdown table ──────────────────────────────────────────────────
  y = sectionHeader(doc, 'Anomaly Breakdown', y + 2)
  const breakdownRows = ANOMALY_TYPES
    .filter((t) => !t.subgroup && (summary?.counts?.[t.key]?.actions ?? 0) > 0)
    .map((t) => [
      t.label,
      String(summary?.counts?.[t.key]?.actions ?? 0),
      `${Math.round((summary?.counts?.[t.key]?.pct ?? 0) * 100)}%`,
    ])
    .sort((a, b) => Number(b[1]) - Number(a[1]))

  if (breakdownRows.length === 0) {
    setFont(doc, 8.5, 'italic', MUTED)
    doc.text('No anomalies detected.', ML, y)
    y += 6
  } else {
    autoTable(doc, {
      startY: y,
      head: [['Anomaly Type', 'Actions', '% of Total']],
      body: breakdownRows,
      ...tableStyle(),
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } },
    })
    y = doc.lastAutoTable.finalY + 6
  }

  // ── Top anomalous actions ────────────────────────────────────────────────────
  if (topActions.length === 0) {
    // skip section
  } else {
    y = sectionHeader(doc, 'Top Anomalous Actions', y)
    setFont(doc, 7.5, 'italic', MUTED)
    doc.text('Unique actions with ≥1 anomaly, sorted slowest-first. Reflects active filters.', ML, y)
    y += 4
    autoTable(doc, {
      startY: y,
      head: [['Action Name', 'Story', 'Duration', 'Anomaly Types']],
      body: topActions.map((r) => [r.action, r.story, r.duration, r.issues]),
      ...tableStyle(),
      columnStyles: {
        0: { cellWidth: 50 },
        1: { cellWidth: 40 },
        2: { cellWidth: 22, halign: 'right' },
        3: { cellWidth: 'auto' },
      },
    })
    y = doc.lastAutoTable.finalY + 6
  }

  // ── Duration profile ─────────────────────────────────────────────────────────
  if (durProfile.length > 0) {
    if (y > PH - 60) { doc.addPage(); y = 16 }
    y = sectionHeader(doc, 'Duration Profile — Top Actions by Total Time', y)
    setFont(doc, 7.5, 'italic', MUTED)
    doc.text('Actions consuming the most cumulative time — highest-leverage optimisation targets. Reflects active filters.', ML, y)
    y += 4
    autoTable(doc, {
      startY: y,
      head: [['Action Name', 'Runs', 'Max', 'Avg', 'Total']],
      body: durProfile.map((r) => [r.action, String(r.count), r.max, r.avg, r.total]),
      ...tableStyle(),
      columnStyles: {
        0: { cellWidth: 'auto' },
        1: { cellWidth: 14, halign: 'right' },
        2: { cellWidth: 22, halign: 'right' },
        3: { cellWidth: 22, halign: 'right' },
        4: { cellWidth: 22, halign: 'right' },
      },
    })
  }

  // ── Download ─────────────────────────────────────────────────────────────────
  const safeName = (fileName ?? 'report')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60)
  doc.save(`action-report-${safeName}.pdf`)
}

// ── autoTable shared style preset ────────────────────────────────────────────
function tableStyle() {
  return {
    styles: {
      fontSize: 8.5,
      cellPadding: { top: 3, bottom: 3, left: 4, right: 4 },
      textColor: TEXT,
      lineColor: BORDER,
      lineWidth: 0.2,
    },
    headStyles: {
      fillColor: BLUE,
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 7.5,
    },
    alternateRowStyles: { fillColor: ROW_ALT },
    margin: { left: ML, right: MR },
    tableLineColor: BORDER,
    tableLineWidth: 0.2,
    didDrawPage: () => {},  // suppress default margins
  }
}

// (end of file)
