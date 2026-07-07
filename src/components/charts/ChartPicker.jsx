import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { CHART_TYPES, getChartType, groupedChartTypes } from './registry'
import { validOptionsFor } from './validate'
import './ChartPicker.css'

/**
 * ChartPicker — modal dialog for adding a chart to the current view.
 *
 * Dropdowns are filtered by the active chart type's field constraints:
 *  - `measure` fields only list numeric columns;
 *  - `dimension` fields only list columns with ≥2 distinct values (and
 *    optionally a `maxDistinct` cap for heatmap/pie-style charts);
 *  - `date` fields only list parseable-date columns;
 *  - `distinctFrom` removes already-chosen columns from sibling fields;
 *  - `pairsWith` (scatter/bubble) hides numeric columns that don't share
 *    ≥2 finite rows with the paired column.
 *
 * The picker also auto-clears stale selections when a previous choice
 * removes the current value from the valid set.
 *
 * Props:
 *   open: boolean
 *   onClose(): void
 *   onAdd(typeId, config): void
 *   headers: string[]
 *   profile: ReturnType<typeof profileColumns>
 *   rows: parsed CSV rows
 */
function ChartPicker({ open, onClose, onAdd, headers, profile, rows }) {
  const [selectedId, setSelectedId] = useState(CHART_TYPES[0].id)
  const [config, setConfig] = useState({})

  const groups = useMemo(() => groupedChartTypes(), [])
  const selected = getChartType(selectedId)

  // Prime defaults when chart type changes
  useEffect(() => {
    if (!selected) return
    const next = {}
    for (const f of selected.fields) {
      if (f.defaultValue !== undefined) next[f.key] = f.defaultValue
      else if (f.multiple) next[f.key] = []
    }
    setConfig(next)
  }, [selectedId, selected])

  // Reset to first type whenever the dialog reopens
  useEffect(() => {
    if (open) setSelectedId(CHART_TYPES[0].id)
  }, [open])

  // Per-field valid option list, recomputed when config changes
  const optionsByField = useMemo(() => {
    if (!selected) return {}
    const out = {}
    for (const f of selected.fields) {
      if (f.role === 'number') continue
      out[f.key] = validOptionsFor(f, selected.fields, config, headers, profile, rows)
    }
    return out
  }, [selected, config, headers, profile, rows])

  // Drop stale selections that are no longer valid given current config
  useEffect(() => {
    if (!selected) return
    let dirty = false
    const next = { ...config }
    for (const f of selected.fields) {
      if (f.role === 'number') continue
      const valid = optionsByField[f.key] ?? []
      const v = next[f.key]
      if (f.multiple && Array.isArray(v)) {
        const pruned = v.filter((x) => valid.includes(x))
        if (pruned.length !== v.length) {
          next[f.key] = pruned
          dirty = true
        }
      } else if (v && !valid.includes(v)) {
        next[f.key] = ''
        dirty = true
      }
    }
    if (dirty) setConfig(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionsByField])

  if (!open) return null

  const allRequiredFilled = selected.fields.every((f) => {
    if (!f.required) return true
    const v = config[f.key]
    if (f.multiple) return Array.isArray(v) && v.length > 0
    return v !== undefined && v !== '' && v !== null
  })

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!allRequiredFilled) return
    onAdd(selected.id, config)
  }

  return (
    <div className="chart-picker-backdrop" onClick={onClose}>
      <div
        className="chart-picker"
        role="dialog"
        aria-labelledby="chart-picker-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="chart-picker-header">
          <h2 id="chart-picker-title">Add chart</h2>
          <button type="button" className="chart-picker-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="chart-picker-body">
          <aside className="chart-picker-types" aria-label="Chart type">
            {groups.map(({ group, types }) => (
              <div key={group} className="chart-picker-group">
                <p className="chart-picker-group-label">{group}</p>
                {types.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`chart-picker-type ${t.id === selectedId ? 'active' : ''}`}
                    onClick={() => setSelectedId(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            ))}
          </aside>

          <form className="chart-picker-form" onSubmit={handleSubmit}>
            <p className="chart-picker-form-title">{selected.label}</p>
            <p className="chart-picker-form-subtitle">
              Dropdowns only show columns that fit this chart.
            </p>

            <div className="chart-picker-fields">
              {selected.fields.map((field) => (
                <FieldInput
                  key={field.key}
                  field={field}
                  value={config[field.key]}
                  options={optionsByField[field.key] ?? []}
                  onChange={(v) => setConfig((prev) => ({ ...prev, [field.key]: v }))}
                />
              ))}
            </div>

            <div className="chart-picker-actions">
              <button type="button" className="chart-picker-cancel" onClick={onClose}>
                Cancel
              </button>
              <button
                type="submit"
                className="chart-picker-submit"
                disabled={!allRequiredFilled}
              >
                Add chart
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}

function FieldInput({ field, value, options, onChange }) {
  if (field.role === 'number') {
    return (
      <label className="chart-picker-field">
        <span>{field.label}</span>
        <input
          type="number"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        />
      </label>
    )
  }

  if (field.multiple) {
    const arr = Array.isArray(value) ? value : []
    return (
      <div className="chart-picker-field">
        <span>
          {field.label}
          {field.required && <em className="chart-picker-required"> *</em>}
        </span>
        <div className="chart-picker-checks">
          {options.length === 0 && (
            <em className="chart-picker-empty">No compatible columns available.</em>
          )}
          {options.map((h) => {
            const checked = arr.includes(h)
            return (
              <label key={h} className="chart-picker-check">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => {
                    if (e.target.checked) onChange([...arr, h])
                    else onChange(arr.filter((x) => x !== h))
                  }}
                />
                <span>{h}</span>
              </label>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <label className="chart-picker-field">
      <span>
        {field.label}
        {field.required && <em className="chart-picker-required"> *</em>}
      </span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={options.length === 0}
      >
        <option value="">
          {options.length === 0 ? '— no compatible columns —' : '— select a column —'}
        </option>
        {options.map((h) => (
          <option key={h} value={h}>{h}</option>
        ))}
      </select>
    </label>
  )
}

export default ChartPicker
