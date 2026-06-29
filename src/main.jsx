import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { CsvDataProvider } from './context/CsvDataContext.jsx'
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
