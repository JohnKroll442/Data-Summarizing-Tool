import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import FileUpload from '../components/FileUpload'
import CsvValidationDialog from '../components/CsvValidationDialog'
import { parseCsvFile, validateSchema } from '../lib/parseCsv'
import { formatFileSize } from '../lib/format'
import { useCsvData } from '../context/useCsvData'
import sapLogo from '../assets/sap-logo.png'

/**
 * UploadPage — the landing screen. Asks for the user's name, accepts a CSV,
 * parses it client-side, and routes the user to the summary view.
 */
function UploadPage() {
  const navigate = useNavigate()
  const {
    setCsvData,
    recentFiles,
    selectRecentFile,
    removeRecentFile,
    setBaselineId,
    setCurrentId,
  } = useCsvData()

  // Persisted user name (so we can say "Hello, <name>"). Loaded from localStorage.
  const [userName, setUserName] = useState(
    () => localStorage.getItem('userName') || ''
  )

  // Controlled input for the name form / edit field
  const [nameDraft, setNameDraft] = useState('')
  const [isEditingName, setIsEditingName] = useState(false)

  // Tracks whether a CSV parse is in flight + any error to surface
  const [isParsing, setIsParsing] = useState(false)
  const [parseError, setParseError] = useState('')

  // When a parsed CSV is missing expected columns, we stash it here and open
  // a confirmation dialog instead of navigating immediately.
  const [pendingCsv, setPendingCsv] = useState(null)
  const [validation, setValidation] = useState(null)

  // Compare mode selection lives locally until the user hits "Compare →" —
  // that way toggling on/off doesn't leak into the shared context.
  const [compareMode, setCompareMode] = useState(false)
  const [compareBaselineId, setCompareBaselineId] = useState(null)
  const [compareCurrentId, setCompareCurrentId] = useState(null)

  const canCompare = recentFiles.length >= 2

  const exitCompareMode = () => {
    setCompareMode(false)
    setCompareBaselineId(null)
    setCompareCurrentId(null)
  }

  // Assign a role (baseline/current) to a file, clearing that role from the
  // other file if it happened to hold it — a single file can't play both.
  const pickBaseline = (id) => {
    setCompareBaselineId(id)
    if (compareCurrentId === id) setCompareCurrentId(null)
  }
  const pickCurrent = (id) => {
    setCompareCurrentId(id)
    if (compareBaselineId === id) setCompareBaselineId(null)
  }

  const submitCompare = () => {
    if (!compareBaselineId || !compareCurrentId) return
    if (compareBaselineId === compareCurrentId) return
    setBaselineId(compareBaselineId)
    setCurrentId(compareCurrentId)
    navigate('/compare/session')
  }

  const closeValidation = () => {
    setPendingCsv(null)
    setValidation(null)
  }

  const confirmValidation = () => {
    if (!pendingCsv) return
    setCsvData(pendingCsv)
    setPendingCsv(null)
    setValidation(null)
    navigate('/summary/raw')
  }

  const saveName = (event) => {
    event.preventDefault()
    const trimmed = nameDraft.trim()
    if (!trimmed) return
    setUserName(trimmed)
    localStorage.setItem('userName', trimmed)
    setNameDraft('')
    setIsEditingName(false)
  }

  const startEditing = () => {
    setNameDraft(userName)
    setIsEditingName(true)
  }

  // Called by FileUpload after the user selects/drops one or more files.
  // For this flow we only care about the first CSV.
  const handleFilesAdded = async (newFiles) => {
    const file = newFiles[0]
    if (!file) return

    const lower = file.name.toLowerCase()
    const isCsv = lower.endsWith('.csv') || file.type === 'text/csv'
    if (!isCsv) {
      setParseError(`"${file.name}" is not a .csv file.`)
      return
    }

    setParseError('')
    setIsParsing(true)
    try {
      const { headers, rows } = await parseCsvFile(file)
      const parsed = {
        headers,
        rows,
        fileName: file.name,
        fileSize: file.size,
      }
      const result = validateSchema(headers, rows)
      if (result.missing.length === 0) {
        setCsvData(parsed)
        navigate('/summary/raw')
      } else {
        setPendingCsv(parsed)
        setValidation(result)
      }
    } catch (err) {
      setParseError(err.message || 'Failed to parse CSV.')
    } finally {
      setIsParsing(false)
    }
  }

  const showNameForm = !userName || isEditingName

  return (
    <>
      <header className="app-header">
        <img src={sapLogo} alt="SAP" className="app-header-logo" />
        <div className="app-header-text">
          {showNameForm ? (
            <form className="app-name-form" onSubmit={saveName}>
              <label htmlFor="user-name-input" className="app-name-label">
                What's your name?
              </label>
              <div className="app-name-row">
                <input
                  id="user-name-input"
                  type="text"
                  className="app-name-input"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  placeholder="Enter your name"
                  autoFocus
                />
                <button type="submit" className="app-name-submit">
                  Continue
                </button>
              </div>
            </form>
          ) : (
            <>
              <h1>
                Hello,{' '}
                <button
                  type="button"
                  className="app-header-name"
                  onClick={startEditing}
                  title="Click to change name"
                >
                  {userName}
                </button>
              </h1>
              <p>Upload file to summarize</p>
            </>
          )}
        </div>
      </header>

      <main className="app-main">
        <FileUpload onFilesAdded={handleFilesAdded} accept=".csv" />
        {isParsing && (
          <p className="app-status" role="status">Parsing CSV…</p>
        )}
        {parseError && (
          <p className="app-error" role="alert">{parseError}</p>
        )}
        <section className="recent-files" aria-label="Recently uploaded files">
          <div className="recent-files-header">
            <h2 className="recent-files-heading">Recent files</h2>
            {canCompare && !compareMode && (
              <button
                type="button"
                className="recent-files-compare-toggle"
                onClick={() => setCompareMode(true)}
              >
                Compare files
              </button>
            )}
            {compareMode && (
              <button
                type="button"
                className="recent-files-compare-toggle is-exit"
                onClick={exitCompareMode}
              >
                Exit compare
              </button>
            )}
          </div>
          {recentFiles.length === 0 ? (
            <p className="recent-files-empty">No files uploaded yet.</p>
          ) : (
            <ul className="recent-files-list">
              {recentFiles.map((file) => {
                const isBaseline = compareBaselineId === file.id
                const isCurrent = compareCurrentId === file.id
                return (
                  <li key={file.id} className="recent-files-item">
                    <button
                      type="button"
                      className="recent-files-pick"
                      disabled={compareMode}
                      onClick={() => {
                        if (compareMode) return
                        selectRecentFile(file.id)
                        navigate('/summary/raw')
                      }}
                    >
                      <span className="recent-files-name">{file.fileName}</span>
                      <span className="recent-files-meta">
                        {formatFileSize(file.fileSize)} · {file.rows.length.toLocaleString()} rows
                      </span>
                    </button>
                    {compareMode && (
                      <div className="compare-role-picker" role="group" aria-label={`Compare role for ${file.fileName}`}>
                        <button
                          type="button"
                          className={`compare-role-btn${isBaseline ? ' is-active' : ''}`}
                          onClick={() => pickBaseline(file.id)}
                          aria-pressed={isBaseline}
                        >
                          Baseline
                        </button>
                        <button
                          type="button"
                          className={`compare-role-btn${isCurrent ? ' is-active' : ''}`}
                          onClick={() => pickCurrent(file.id)}
                          aria-pressed={isCurrent}
                        >
                          Current
                        </button>
                      </div>
                    )}
                    {!compareMode && (
                      <button
                        type="button"
                        className="recent-files-remove"
                        title={`Remove ${file.fileName} from recent files`}
                        aria-label={`Remove ${file.fileName} from recent files`}
                        onClick={() => removeRecentFile(file.id)}
                      >
                        ×
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {compareMode &&
            compareBaselineId &&
            compareCurrentId &&
            compareBaselineId !== compareCurrentId && (
              <button
                type="button"
                className="recent-files-compare-submit"
                onClick={submitCompare}
              >
                Compare →
              </button>
            )}
        </section>
      </main>
      <CsvValidationDialog
        open={Boolean(validation)}
        fileName={pendingCsv?.fileName}
        available={validation?.available ?? []}
        missing={validation?.missing ?? []}
        affectedViews={validation?.affectedViews ?? []}
        canProceed={validation?.canProceed ?? false}
        onContinue={confirmValidation}
        onCancel={closeValidation}
      />
    </>
  )
}

export default UploadPage
