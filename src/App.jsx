import { Navigate, Route, Routes } from 'react-router-dom'
import UploadPage from './pages/UploadPage'
import SummaryPage from './pages/SummaryPage'
import RawDataView from './pages/views/RawDataView'
import SessionView from './pages/views/SessionView'
import ActionView from './pages/views/ActionView'
import WidgetView from './pages/views/WidgetView'
import './App.css'

/**
 * App — the route host. The full-screen gradient and centered layout live
 * in `.app` (App.css); each route owns its own header / content.
 */
function App() {
  return (
    <div className="app">
      <Routes>
        <Route path="/" element={<UploadPage />} />
        <Route path="/summary" element={<SummaryPage />}>
          <Route index element={<Navigate to="raw" replace />} />
          <Route path="raw" element={<RawDataView />} />
          <Route path="session" element={<SessionView />} />
          <Route path="action" element={<ActionView />} />
          <Route path="widget" element={<WidgetView />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  )
}

export default App
