import { useEffect, useMemo, useState } from 'react'

/**
 * Shared pagination for the summary/raw tables. Keeps the DOM bounded on huge
 * files by rendering only one page of rows at a time. Sorting, filtering, and
 * CSV export continue to operate on the full row set the caller passes in —
 * only what's handed to <DataTable> is sliced.
 */

const PAGE_SIZES = [25, 50, 100, 250, 500, 1000]

// Upper bound for a custom page size. Pagination exists to keep the DOM
// bounded on huge files, so we cap how many rows a custom value can render at
// once to avoid re-introducing the very slowdown this feature prevents.
const MAX_CUSTOM_PAGE_SIZE = 5000

/**
 * usePagination(rows) → { pageRows, page, setPage, pageSize, setPageSize,
 *                         pageCount, total, firstShown, lastShown }
 *
 * `rows` should be the already-filtered/sorted array. The page auto-resets to
 * the first page whenever that array changes (search/filter/sort) or the page
 * size changes, and `page` is always clamped into range.
 */
/* eslint-disable-next-line react-refresh/only-export-components */
export function usePagination(rows, { defaultPageSize = 100 } = {}) {
  const [pageSize, setPageSize] = useState(defaultPageSize)
  const [page, setPage] = useState(0)

  useEffect(() => {
    setPage(0)
  }, [rows, pageSize])

  const total = rows.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(page, pageCount - 1)

  const pageRows = useMemo(() => {
    const start = safePage * pageSize
    return rows.slice(start, start + pageSize)
  }, [rows, safePage, pageSize])

  return {
    pageRows,
    page: safePage,
    setPage,
    pageSize,
    setPageSize,
    pageCount,
    total,
    firstShown: total === 0 ? 0 : safePage * pageSize + 1,
    lastShown: Math.min(total, safePage * pageSize + pageSize),
  }
}

/** "Rows per page" dropdown for a table toolbar, with a Custom… entry that
 *  reveals a number input so the user can type any page size. */
export function PageSizeSelect({ value, onChange }) {
  const isPreset = PAGE_SIZES.includes(value)
  const [customMode, setCustomMode] = useState(!isPreset)
  const [customText, setCustomText] = useState(isPreset ? '' : String(value))

  const handleSelect = (e) => {
    const v = e.target.value
    if (v === 'custom') {
      setCustomMode(true)
      // Seed the input with the current size so it isn't blank.
      setCustomText(String(value))
    } else {
      setCustomMode(false)
      onChange(Number(v))
    }
  }

  const applyCustom = (text) => {
    setCustomText(text)
    const n = Math.floor(Number(text))
    if (Number.isFinite(n) && n >= 1) {
      onChange(Math.min(n, MAX_CUSTOM_PAGE_SIZE))
    }
  }

  return (
    <label className="raw-page-size">
      Rows per page{' '}
      <select value={customMode ? 'custom' : String(value)} onChange={handleSelect}>
        {PAGE_SIZES.map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
        <option value="custom">Custom…</option>
      </select>
      {customMode && (
        <input
          type="number"
          className="raw-page-size-input"
          min="1"
          max={MAX_CUSTOM_PAGE_SIZE}
          step="1"
          value={customText}
          onChange={(e) => applyCustom(e.target.value)}
          placeholder="rows"
          aria-label="Custom rows per page"
        />
      )}
    </label>
  )
}

/** First / Prev / status / Next / Last controls. Renders nothing on 1 page. */
export function TablePager({ page, pageCount, onPage }) {
  if (pageCount <= 1) return null
  return (
    <div className="raw-pager">
      <button
        type="button"
        className="raw-pager-btn"
        onClick={() => onPage(0)}
        disabled={page === 0}
        title="First page"
      >
        « First
      </button>
      <button
        type="button"
        className="raw-pager-btn"
        onClick={() => onPage(page - 1)}
        disabled={page === 0}
      >
        ‹ Prev
      </button>
      <span className="raw-pager-status">
        Page {(page + 1).toLocaleString()} of {pageCount.toLocaleString()}
      </span>
      <button
        type="button"
        className="raw-pager-btn"
        onClick={() => onPage(page + 1)}
        disabled={page >= pageCount - 1}
      >
        Next ›
      </button>
      <button
        type="button"
        className="raw-pager-btn"
        onClick={() => onPage(pageCount - 1)}
        disabled={page >= pageCount - 1}
        title="Last page"
      >
        Last »
      </button>
    </div>
  )
}
