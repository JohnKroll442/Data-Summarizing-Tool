import { Dialog, Bar, Button, Title, MessageStrip } from '@ui5/webcomponents-react'
import './CsvValidationDialog.css'

/**
 * CsvValidationDialog — uses the UI5 Dialog component for a Fiori-compliant
 * modal with built-in focus-trap, Escape-to-close, and footer slot.
 */
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
  const heading = canProceed
    ? 'Some expected columns are missing'
    : 'This file can’t be summarized'

  const handleAfterClose = () => {
    onCancel()
  }

  return (
    <Dialog
      open={open}
      headerText={heading}
      state={canProceed ? 'Warning' : 'Error'}
      onClose={handleAfterClose}
      footer={
        <Bar
          endContent={
            <>
              <Button design="Transparent" onClick={onCancel}>
                Upload a different file
              </Button>
              {canProceed && (
                <Button design="Emphasized" onClick={onContinue}>
                  Continue anyway
                </Button>
              )}
            </>
          }
        />
      }
    >
      <div className="csv-validation-body">
        {fileName && (
          <p className="csv-validation-file">
            <span className="csv-validation-file-label">File:</span>{' '}
            <span className="csv-validation-file-name">{fileName}</span>
          </p>
        )}

        {!canProceed && (
          <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.75rem' }}>
            None of the expected columns were found in this CSV. There is
            nothing to summarize — please pick a different file.
          </MessageStrip>
        )}

        {affectedViews.length > 0 && (
          <section className="csv-validation-section">
            <Title level="H5" style={{ marginBottom: '0.25rem' }}>Views that will be limited</Title>
            <ul className="csv-validation-affected">
              {affectedViews.map((v) => (
                <li key={v}>{v}</li>
              ))}
            </ul>
          </section>
        )}

        <div className="csv-validation-columns">
          <section className="csv-validation-section">
            <Title level="H5" style={{ marginBottom: '0.25rem' }}>Missing columns ({missing.length})</Title>
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
            <Title level="H5" style={{ marginBottom: '0.25rem' }}>Found columns ({available.length})</Title>
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
    </Dialog>
  )
}

export default CsvValidationDialog
