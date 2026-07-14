import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, ArrowRight } from 'lucide-react'
import FileUpload from '../components/FileUpload'
import CsvValidationDialog from '../components/CsvValidationDialog'
import { parseCsvFile, validateSchema } from '../lib/parseCsv'
import { formatFileSize } from '../lib/format'
import { useCsvData } from '../context/useCsvData'
import sapLogo from '../assets/sap-logo.png'

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

  const [isParsing, setIsParsing] = useState(false)
  const [parseProgress, setParseProgress] = useState(0)
  const [parseError, setParseError] = useState('')

  const [pendingCsv, setPendingCsv] = useState(null)
  const [validation, setValidation] = useState(null)

  const [compareMode, setCompareMode] = useState(false)
  const [compareBaselineId, setCompareBaselineId] = useState(null)
  const [compareCurrentId, setCompareCurrentId] = useState(null)

  const canCompare = recentFiles.length >= 2

  const exitCompareMode = () => {
    setCompareMode(false)
    setCompareBaselineId(null)
    setCompareCurrentId(null)
  }

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
    setParseProgress(0)
    try {
      const { headers, rows } = await parseCsvFile(file, {
        onProgress: setParseProgress,
      })
      const parsed = {
        headers,
        rows,
        fileName: file.name,
        fileSize: file.size,
      }
      // Validate against a sample rather than the whole file: schema
      // validation only needs to detect which columns exist, so running the
      // three full aggregations over every row here would re-freeze the main
      // thread right after the (now off-thread) parse. A generous head sample
      // is enough to detect the column mapping.
      const sample = rows.length > 5000 ? rows.slice(0, 5000) : rows
      const result = validateSchema(headers, sample)
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

  return (
    <>
      <header className="app-header">
        <img src={sapLogo} alt="SAP" className="app-header-logo" />
        <div className="app-header-text">
          <p>Upload file to summarize</p>
        </div>
      </header>

      <main className="app-main">
        <FileUpload onFilesAdded={handleFilesAdded} accept=".csv" />
        {isParsing && (
          <p className="app-status" role="status">
            Parsing CSV… {Math.round(parseProgress * 100)}%
          </p>
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
                        <X size={16} />
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
                Compare <ArrowRight size={14} aria-hidden="true" />
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
