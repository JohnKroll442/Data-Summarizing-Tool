import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import FileUpload from '../components/FileUpload'
import { parseCsvFile } from '../lib/parseCsv'
import { formatFileSize } from '../lib/format'
import { useCsvData } from '../context/useCsvData'

/**
 * UploadPage — the landing screen. Asks for the user's name, accepts a CSV,
 * parses it client-side, and routes the user to the summary view.
 */
function UploadPage() {
  const navigate = useNavigate()
  const { setCsvData, recentFiles, selectRecentFile, removeRecentFile } = useCsvData()

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
      setCsvData({
        headers,
        rows,
        fileName: file.name,
        fileSize: file.size,
      })
      navigate('/summary/raw')
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
        <div className="app-header-logo" aria-hidden="true">SAP</div>
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
        {recentFiles.length > 0 && (
          <section className="recent-files" aria-label="Recently uploaded files">
            <h2 className="recent-files-heading">Recent files</h2>
            <ul className="recent-files-list">
              {recentFiles.map((file) => (
                <li key={file.id} className="recent-files-item">
                  <button
                    type="button"
                    className="recent-files-pick"
                    onClick={() => {
                      selectRecentFile(file.id)
                      navigate('/summary/raw')
                    }}
                  >
                    <span className="recent-files-name">{file.fileName}</span>
                    <span className="recent-files-meta">
                      {formatFileSize(file.fileSize)} · {file.rows.length.toLocaleString()} rows
                    </span>
                  </button>
                  <button
                    type="button"
                    className="recent-files-remove"
                    title={`Remove ${file.fileName} from recent files`}
                    aria-label={`Remove ${file.fileName} from recent files`}
                    onClick={() => removeRecentFile(file.id)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </>
  )
}

export default UploadPage
