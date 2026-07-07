import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { CsvDataProvider } from './context/CsvDataContext.jsx'

// Fonts — self-hosted via fontsource, no external requests.
// Geist (default) and IBM Plex are available; swap the --font-sans var
// in index.css to try a different one.
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@fontsource-variable/ibm-plex-sans'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'

import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <CsvDataProvider>
        <App />
      </CsvDataProvider>
    </BrowserRouter>
  </StrictMode>,
)
