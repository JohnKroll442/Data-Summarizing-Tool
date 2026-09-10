import { FileUploader as Ui5FileUploader, Button, FlexBox, Text } from '@ui5/webcomponents-react'
import '@ui5/webcomponents-icons/dist/upload.js'
import './FileUpload.css'

/**
 * FileUpload — a styled drop zone using UI5 FlexBox as the container and
 * UI5 FileUploader + Button for the interaction.
 * Calls `onFilesAdded(files)` with an array of File objects when the user
 * selects or drops files. Pass `accept` (e.g. ".csv") to restrict the
 * file picker.
 */
function FileUpload({ onFilesAdded, accept }) {
  const handleChange = (event) => {
    const files = event.target?.files || event.detail?.files
    if (files && files.length > 0) {
      onFilesAdded(Array.from(files))
    }
  }

  const subtitle = accept === '.csv'
    ? ''
    : 'Supports any file type · multiple files allowed'

  return (
    <FlexBox
      direction="Column"
      alignItems="Center"
      className="file-upload-zone"
    >
      <Ui5FileUploader
        accept={accept || undefined}
        hideInput
        onChange={handleChange}
      >
        <Button design="Emphasized" icon="upload">
          Browse or drop a file
        </Button>
      </Ui5FileUploader>
      <Text className="file-upload-subtitle">{subtitle}</Text>
    </FlexBox>
  )
}

export default FileUpload
