import { useRef, useState } from 'react'
import './FileUpload.css'

/**
 * FileUpload — compact drop zone with an inline action button.
 * Calls `onFilesAdded(files)` with an array of File objects when the user
 * selects or drops files. Pass `accept` (e.g. ".csv") to restrict the
 * file picker; drag-and-drop validation is left to the caller.
 */
function FileUpload({ onFilesAdded, accept }) {
  const fileInputRef = useRef(null)
  const [isDragging, setIsDragging] = useState(false)

  // Open the hidden <input type="file"> when the zone or button is clicked
  const openFilePicker = () => {
    fileInputRef.current?.click()
  }

  // Triggered after the user picks files via the file dialog
  const handleFileInputChange = (event) => {
    const selected = Array.from(event.target.files || [])
    if (selected.length > 0) {
      onFilesAdded(selected)
    }
    // Reset so picking the same file again still fires `change`
    event.target.value = ''
  }

  // Drag-and-drop handlers
  const handleDragOver = (event) => {
    event.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = (event) => {
    event.preventDefault()
    setIsDragging(false)
  }

  const handleDrop = (event) => {
    event.preventDefault()
    setIsDragging(false)
    const dropped = Array.from(event.dataTransfer.files || [])
    if (dropped.length > 0) {
      onFilesAdded(dropped)
    }
  }

  const subtitle = accept === '.csv'
    ? 'CSV files only · parsed in your browser'
    : 'Supports any file type · multiple files allowed'

  return (
    <div
      className={`file-upload ${isDragging ? 'dragging' : ''}`}
      onClick={openFilePicker}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      role="button"
      tabIndex={0}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept={accept}
        onChange={handleFileInputChange}
        style={{ display: 'none' }}
      />
      <div className="file-upload-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
             strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
      </div>
      <div className="file-upload-content">
        <p className="file-upload-title">Drop a CSV here or browse</p>
        <p className="file-upload-subtitle">{subtitle}</p>
      </div>
      <button
        type="button"
        className="file-upload-action"
        onClick={(e) => {
          e.stopPropagation()
          openFilePicker()
        }}
      >
        Browse
      </button>
    </div>
  )
}

export default FileUpload
