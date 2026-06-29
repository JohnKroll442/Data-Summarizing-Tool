import { useContext } from 'react'
import { CsvDataContext } from './CsvDataContext.jsx'

/**
 * Hook accessor for the CsvDataContext. Throws if used outside its provider.
 */
export function useCsvData() {
  const ctx = useContext(CsvDataContext)
  if (!ctx) {
    throw new Error('useCsvData must be used inside a <CsvDataProvider>')
  }
  return ctx
}
