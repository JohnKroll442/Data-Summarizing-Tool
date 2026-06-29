import './FileList.css'

/**
 * FileList — displays the list of selected files with their name and size,
 * plus a remove button per file. When the upload-to-server logic is added,
 * this is also where per-file progress and status indicators would live.
 */
function FileList({ files, onRemove }) {
  if (files.length === 0) {
    return null
  }

  return (
    <div className="file-list">
      <div className="file-list-header">
        <h2 className="file-list-title">Selected files</h2>
        <span className="file-list-count">{files.length}</span>
      </div>
      <ul className="file-list-items">
        {files.map((file, index) => (
          <li key={`${file.name}-${index}`} className="file-list-item">
            <div className="file-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
            </div>
            <div className="file-info">
              <span className="file-name" title={file.name}>{file.name}</span>
              <span className="file-size">{formatFileSize(file.size)}</span>
            </div>
            <button
              type="button"
              className="file-remove"
              onClick={() => onRemove(index)}
              aria-label={`Remove ${file.name}`}
              title="Remove"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// Convert raw bytes into a human-readable string (e.g. "1.2 MB")
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export default FileList
