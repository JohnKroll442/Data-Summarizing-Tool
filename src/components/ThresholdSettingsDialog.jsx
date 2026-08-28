import { useEffect, useState } from 'react'
import { Dialog, Bar, Button, MessageStrip } from '@ui5/webcomponents-react'
import { useCsvData } from '../context/useCsvData'
import { DEFAULT_THRESHOLDS } from '../context/CsvDataContext'
import './ThresholdSettingsDialog.css'

// Convert a ms value to a [numericValue, unit] pair, preferring the largest
// round unit: minutes if divisible by 60 000, seconds if divisible by 1 000,
// else raw milliseconds.
function fromMs(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return [n, 'ms']
  if (n % 60000 === 0) return [n / 60000, 'min']
  if (n % 1000 === 0) return [n / 1000, 's']
  return [n, 'ms']
}

// Convert a numeric value + unit string back to ms. Returns NaN for invalid input.
function toMs(val, unit) {
  const n = Number(val)
  if (!Number.isFinite(n) || n <= 0) return NaN
  if (unit === 'min') return n * 60000
  if (unit === 's') return n * 1000
  return n // ms
}

/**
 * ThresholdSettingsDialog — a UI5 Dialog (same pattern as CsvValidationDialog)
 * for configuring per-dataset anomaly detection thresholds.
 *
 * Props: { open, onClose }
 * Reads and writes thresholds via the CsvData context.
 */
function ThresholdSettingsDialog({ open, onClose }) {
  const { thresholds, setThresholds, resetThresholds } = useCsvData()

  const [slowValue, setSlowValue] = useState('')
  const [slowUnit, setSlowUnit] = useState('min')
  const [healthyValue, setHealthyValue] = useState('')
  const [healthyUnit, setHealthyUnit] = useState('s')

  // Seed fields from context thresholds whenever the dialog opens.
  useEffect(() => {
    if (!open) return
    const [sv, su] = fromMs(thresholds.slowActionMs)
    const [hv, hu] = fromMs(thresholds.healthyCeilingMs)
    setSlowValue(sv)
    setSlowUnit(su)
    setHealthyValue(hv)
    setHealthyUnit(hu)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const slowMs = toMs(slowValue, slowUnit)
  const healthyMs = toMs(healthyValue, healthyUnit)

  // Validation rules
  const slowError = !Number.isFinite(slowMs) || slowMs < 1000
    ? 'Slow-action threshold must be at least 1 second (1 000 ms).'
    : null
  const healthyError = !Number.isFinite(healthyMs) || healthyMs < 250
    ? 'Healthy ceiling must be at least 250 ms.'
    : null
  const orderError = !slowError && !healthyError && healthyMs >= slowMs
    ? 'Healthy ceiling must be less than the slow-action threshold.'
    : null
  const firstError = slowError ?? healthyError ?? orderError
  const isValid = firstError === null

  const handleApply = () => {
    if (!isValid) return
    setThresholds({ slowActionMs: slowMs, healthyCeilingMs: healthyMs })
    onClose()
  }

  const handleReset = () => {
    resetThresholds()
    onClose()
  }

  const handleInputKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (isValid) handleApply()
    }
  }

  return (
    <Dialog
      open={open}
      headerText="Detection Thresholds"
      onClose={onClose}
      footer={
        <Bar
          endContent={
            <>
              <Button design="Transparent" onClick={handleReset}>
                Reset to defaults
              </Button>
              <Button design="Default" onClick={onClose}>
                Cancel
              </Button>
              <Button design="Emphasized" onClick={handleApply} disabled={!isValid}>
                Apply
              </Button>
            </>
          }
        />
      }
    >
      <div className="threshold-dialog-body">
        {!isValid && (
          <MessageStrip design="Negative" hideCloseButton className="threshold-dialog-error">
            {firstError}
          </MessageStrip>
        )}

        <div className="threshold-dialog-row">
          <label className="threshold-dialog-label" htmlFor="threshold-slow-value">
            Slow action
          </label>
          <div className="threshold-dialog-inputs">
            <input
              id="threshold-slow-value"
              className="duration-filter-amount"
              type="number"
              min="1"
              step="1"
              value={slowValue}
              onChange={(e) => setSlowValue(e.target.value)}
              onKeyDown={handleInputKeyDown}
              aria-label="Slow action threshold value"
            />
            <select
              className="threshold-dialog-unit"
              value={slowUnit}
              onChange={(e) => setSlowUnit(e.target.value)}
              aria-label="Slow action threshold unit"
            >
              <option value="ms">ms</option>
              <option value="s">s</option>
              <option value="min">min</option>
            </select>
          </div>
          <p className="threshold-dialog-hint">
            Actions at or above this duration are flagged as <em>slow_action</em> anomalies and counted in the KPI tile.
          </p>
        </div>

        <div className="threshold-dialog-row">
          <label className="threshold-dialog-label" htmlFor="threshold-healthy-value">
            Healthy ceiling
          </label>
          <div className="threshold-dialog-inputs">
            <input
              id="threshold-healthy-value"
              className="duration-filter-amount"
              type="number"
              min="1"
              step="1"
              value={healthyValue}
              onChange={(e) => setHealthyValue(e.target.value)}
              onKeyDown={handleInputKeyDown}
              aria-label="Healthy ceiling value"
            />
            <select
              className="threshold-dialog-unit"
              value={healthyUnit}
              onChange={(e) => setHealthyUnit(e.target.value)}
              aria-label="Healthy ceiling unit"
            >
              <option value="ms">ms</option>
              <option value="s">s</option>
              <option value="min">min</option>
            </select>
          </div>
          <p className="threshold-dialog-hint">
            Actions below this duration are shown in the histogram&apos;s green &ldquo;good&rdquo; band.
          </p>
        </div>

        <p className="threshold-dialog-defaults">
          Defaults: slow action = {fromMs(DEFAULT_THRESHOLDS.slowActionMs)[0]}{' '}
          {fromMs(DEFAULT_THRESHOLDS.slowActionMs)[1]}, healthy ceiling ={' '}
          {fromMs(DEFAULT_THRESHOLDS.healthyCeilingMs)[0]}{' '}
          {fromMs(DEFAULT_THRESHOLDS.healthyCeilingMs)[1]}
        </p>
      </div>
    </Dialog>
  )
}

export default ThresholdSettingsDialog
