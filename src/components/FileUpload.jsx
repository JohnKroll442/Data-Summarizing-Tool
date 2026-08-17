import { FileUploader as Ui5FileUploader } from '@ui5/webcomponents-react'
import { Button } from '@ui5/webcomponents-react'
import './FileUpload.css'

/**
 * FileUpload — uses the UI5 FileUploader component with drag-and-drop support.
 * Calls `onFilesAdded(files)` with an array of File objects when the user
 * selects or drops files. Pass `accept` (e.g. ".csv") to restrict the
 * file picker.
 */
function FileUpload({ onFilesAdded, accept }) {
  const handleChange = (event) => {
    // UI5 FileUploader: files available on event.target.files (native input)
    // or on the component ref's files property
    const files = event.target?.files || event.detail?.files
    if (files && files.length > 0) {
      onFilesAdded(Array.from(files))
    }
  }

  const subtitle = accept === '.csv'
    ? 'CSV files only · parsed in your browser'
    : 'Supports any file type · multiple files allowed'

  return (
    <div className="file-upload">
      <Ui5FileUploader
        accept={accept || undefined}
        hideInput
        onChange={handleChange}
        className="file-upload-uploader"
      >
        <Button design="Emphasized" icon="upload">
          Browse or drop a file
        </Button>
      </Ui5FileUploader>
      <p className="file-upload-subtitle">{subtitle}</p>
    </div>
  )
}

export default FileUpload
