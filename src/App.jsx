import { useState } from 'react'
import FileUpload from './components/FileUpload'
import FileList from './components/FileList'
import './App.css'

function App() {
  // Holds metadata for files the user has selected/uploaded
  const [files, setFiles] = useState([])

  // Called by FileUpload when the user picks one or more files
  const handleFilesAdded = (newFiles) => {
    setFiles((prev) => [...prev, ...newFiles])
  }

  // Remove a file from the list by index
  const handleRemoveFile = (indexToRemove) => {
    setFiles((prev) => prev.filter((_, i) => i !== indexToRemove))
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-logo" aria-hidden="true">SAP</div>
        <div className="app-header-text">
          <h1>File Upload</h1>
          <p>Select one or more files to upload</p>
        </div>
      </header>

      <main className="app-main">
        <FileUpload onFilesAdded={handleFilesAdded} />
        <FileList files={files} onRemove={handleRemoveFile} />
      </main>
    </div>
  )
}

export default App
