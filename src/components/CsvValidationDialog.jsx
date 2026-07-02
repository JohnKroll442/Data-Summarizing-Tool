import { useEffect } from 'react'
import './CsvValidationDialog.css'

function CsvValidationDialog({
  open,
  fileName,
  available,
  missing,
  affectedViews,
  canProceed,
  onContinue,
  onCancel,
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  const titleId = 'csv-validation-title'
  const heading = canProceed
    ? 'Some expected columns are missing'
    : 'This file can’t be summarized'

  return (
    <div className="csv-validation-backdrop" onClick={onCancel}>
      <div
        className="csv-validation-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="csv-validation-header">
          <h2 id={titleId}>{heading}</h2>
          <button
            type="button"
            className="csv-validation-close"
            onClick={onCancel}
            aria-label="Close"
          >
            &times;
          </button>
        </header>
        <div className="csv-validation-body">
          {fileName && (
            <p className="csv-validation-file">
              <span className="csv-validation-file-label">File:</span>{' '}
              <span className="csv-validation-file-name">{fileName}</span>
            </p>
          )}

          {!canProceed && (
            <p className="csv-validation-fatal" role="alert">
              None of the expected columns were found in this CSV. There is
              nothing to summarize — please pick a different file.
            </p>
          )}

          {affectedViews.length > 0 && (
            <section className="csv-validation-section">
              <h3>Views that will be limited</h3>
              <ul className="csv-validation-affected">
                {affectedViews.map((v) => (
                  <li key={v}>{v}</li>
                ))}
              </ul>
            </section>
          )}

          <div className="csv-validation-columns">
            <section className="csv-validation-section">
              <h3>Missing columns ({missing.length})</h3>
              {missing.length === 0 ? (
                <p className="csv-validation-empty">None.</p>
              ) : (
                <ul className="csv-validation-list csv-validation-list-missing">
                  {missing.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              )}
            </section>

            <section className="csv-validation-section">
              <h3>Found columns ({available.length})</h3>
              {available.length === 0 ? (
                <p className="csv-validation-empty">None.</p>
              ) : (
                <ul className="csv-validation-list csv-validation-list-available">
                  {available.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
        <footer className="csv-validation-footer">
          <button
            type="button"
            className="csv-validation-btn csv-validation-btn-secondary"
            onClick={onCancel}
          >
            Upload a different file
          </button>
          {canProceed && (
            <button
              type="button"
              className="csv-validation-btn csv-validation-btn-primary"
              onClick={onContinue}
              autoFocus
            >
              Continue anyway
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

export default CsvValidationDialog
