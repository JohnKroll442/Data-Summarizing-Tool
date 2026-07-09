import { FileText, X } from 'lucide-react'
import { useCsvData } from '../../context/useCsvData'
import { formatFileSize } from '../../lib/format'

function FileContextPanel() {
  const {
    fileName, fileSize, rows,
    recentFiles,
    activeFileId,
    baselineId,
    setBaselineId,
    clearComparison,
  } = useCsvData()

  const hasActive = Boolean(rows?.length)
  const candidates = recentFiles.filter((f) => f.id !== activeFileId)

  if (!hasActive) return null

  return (
    <div className="copilot-file-panel">
      <div className="copilot-file-row">
        <FileText size={13} className="copilot-file-icon" />
        <span className="copilot-file-label">Active</span>
        <span className="copilot-file-name" title={fileName}>{fileName}</span>
        <span className="copilot-file-meta">{formatFileSize(fileSize)} · {rows.length.toLocaleString()} rows</span>
      </div>

      {candidates.length > 0 && (
        <div className="copilot-file-row">
          <FileText size={13} className="copilot-file-icon copilot-file-icon--baseline" />
          <span className="copilot-file-label">Baseline</span>
          {baselineId ? (
            <>
              <span className="copilot-file-name copilot-file-name--baseline" title={recentFiles.find(f => f.id === baselineId)?.fileName}>
                {recentFiles.find(f => f.id === baselineId)?.fileName}
              </span>
              <button
                type="button"
                className="copilot-file-clear"
                aria-label="Remove baseline file"
                onClick={clearComparison}
              >
                <X size={12} />
              </button>
            </>
          ) : (
            <select
              className="copilot-file-select"
              value=""
              onChange={(e) => setBaselineId(e.target.value)}
              aria-label="Select baseline file for comparison"
            >
              <option value="" disabled>Select file…</option>
              {candidates.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.fileName} ({f.rows.length.toLocaleString()} rows)
                </option>
              ))}
            </select>
          )}
        </div>
      )}
    </div>
  )
}

export default FileContextPanel
