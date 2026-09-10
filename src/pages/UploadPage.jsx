import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  MessageStrip,
  BusyIndicator,
  Title,
  Text,
  Card,
  CardHeader,
  List,
  ListItemCustom,
  Button,
  FlexBox,
} from '@ui5/webcomponents-react'
import '@ui5/webcomponents-icons/dist/decline.js'
import '@ui5/webcomponents-icons/dist/arrow-right.js'
import FileUpload from '../components/FileUpload'
import CsvValidationDialog from '../components/CsvValidationDialog'
import { parseCsvFile, validateSchema } from '../lib/parseCsv'
import { formatFileSize, formatRelativeTime } from '../lib/format'
import { useCsvData } from '../context/useCsvData'
import sapLogo from '../assets/sap-logo.png'

function UploadPage() {
  const navigate = useNavigate()
  const {
    setCsvData,
    recentFiles,
    selectRecentFile,
    removeRecentFile,
    setBaselineId,
    setCurrentId,
  } = useCsvData()

  const [isParsing, setIsParsing] = useState(false)
  const [parseProgress, setParseProgress] = useState(0)
  const [parseError, setParseError] = useState('')

  const [pendingCsv, setPendingCsv] = useState(null)
  const [validation, setValidation] = useState(null)

  const [compareMode, setCompareMode] = useState(false)
  const [compareBaselineId, setCompareBaselineId] = useState(null)
  const [compareCurrentId, setCompareCurrentId] = useState(null)

  const canCompare = recentFiles.length >= 2

  const exitCompareMode = () => {
    setCompareMode(false)
    setCompareBaselineId(null)
    setCompareCurrentId(null)
  }

  const pickBaseline = (id) => {
    setCompareBaselineId(id)
    if (compareCurrentId === id) setCompareCurrentId(null)
  }
  const pickCurrent = (id) => {
    setCompareCurrentId(id)
    if (compareBaselineId === id) setCompareBaselineId(null)
  }

  const submitCompare = () => {
    if (!compareBaselineId || !compareCurrentId) return
    if (compareBaselineId === compareCurrentId) return
    setBaselineId(compareBaselineId)
    setCurrentId(compareCurrentId)
    navigate('/compare/session')
  }

  const closeValidation = () => {
    setPendingCsv(null)
    setValidation(null)
  }

  const confirmValidation = () => {
    if (!pendingCsv) return
    setCsvData(pendingCsv)
    setPendingCsv(null)
    setValidation(null)
    navigate('/summary/raw')
  }

  const handleFilesAdded = async (newFiles) => {
    const file = newFiles[0]
    if (!file) return

    const lower = file.name.toLowerCase()
    const isCsv = lower.endsWith('.csv') || file.type === 'text/csv'
    if (!isCsv) {
      setParseError(`"${file.name}" is not a .csv file.`)
      return
    }

    setParseError('')
    setIsParsing(true)
    setParseProgress(0)
    try {
      const { headers, rows } = await parseCsvFile(file, {
        onProgress: setParseProgress,
      })
      const parsed = {
        headers,
        rows,
        fileName: file.name,
        fileSize: file.size,
      }
      // Validate against a sample rather than the whole file: schema
      // validation only needs to detect which columns exist, so running the
      // three full aggregations over every row here would re-freeze the main
      // thread right after the (now off-thread) parse. A generous head sample
      // is enough to detect the column mapping.
      const sample = rows.length > 5000 ? rows.slice(0, 5000) : rows
      const result = validateSchema(headers, sample)
      if (result.missing.length === 0) {
        setCsvData(parsed)
        navigate('/summary/raw')
      } else {
        setPendingCsv(parsed)
        setValidation(result)
      }
    } catch (err) {
      setParseError(err.message || 'Failed to parse CSV.')
    } finally {
      setIsParsing(false)
    }
  }

  return (
    <>
      {/* Header */}
      <FlexBox
        direction="Column"
        alignItems="Center"
        style={{ width: '100%', maxWidth: '960px', margin: '0 auto 1.75rem', gap: '0.1rem', textAlign: 'center' }}
      >
        <img
          src={sapLogo}
          alt="SAP"
          style={{
            height: '200px',
            width: 'auto',
            objectFit: 'contain',
            filter: 'drop-shadow(0 8px 24px rgba(0,0,0,0.18))',
            marginBottom: '-1rem',
          }}
        />
        <FlexBox direction="Column" alignItems="Center" style={{ gap: '0.25rem' }}>
          <Title level="H1" wrappingType="Normal">CSV Summarizer</Title>
          <Text style={{ fontSize: '1rem', color: 'var(--sapContent_LabelColor)' }}>
            Upload file to summarize
          </Text>
        </FlexBox>
      </FlexBox>

      {/* Main content */}
      <FlexBox
        direction="Column"
        style={{ width: '100%', maxWidth: '880px', margin: '0 auto', gap: '1.25rem' }}
      >
        <FileUpload onFilesAdded={handleFilesAdded} accept=".csv" />

        {isParsing && (
          <BusyIndicator
            active
            size="M"
            text={`Parsing CSV… ${Math.round(parseProgress * 100)}%`}
            style={{ display: 'flex', justifyContent: 'center', padding: '0.6rem 0' }}
          />
        )}
        {parseError && (
          <MessageStrip design="Negative" onClose={() => setParseError('')}>
            {parseError}
          </MessageStrip>
        )}

        {/* Recent files */}
        <Card
          header={
            <CardHeader
              titleText="Recent files"
              action={
                compareMode ? (
                  <Button design="Transparent" onClick={exitCompareMode}>Exit compare</Button>
                ) : canCompare ? (
                  <Button design="Transparent" onClick={() => setCompareMode(true)}>Compare files</Button>
                ) : null
              }
            />
          }
        >
          {recentFiles.length === 0 ? (
            <FlexBox style={{ padding: '0.75rem 1rem' }}>
              <Text style={{ fontStyle: 'italic' }}>No files uploaded yet.</Text>
            </FlexBox>
          ) : (
            <List selectionMode="None" separators="Inner" className="recent-files-list" style={{ paddingBottom: '0.75rem' }}>
              {recentFiles.map((file) => {
                const isBaseline = compareBaselineId === file.id
                const isCurrent = compareCurrentId === file.id
                return (
                  <ListItemCustom
                    key={file.id}
                    type={compareMode ? 'Inactive' : 'Active'}
                    onClick={compareMode ? undefined : () => {
                      selectRecentFile(file.id)
                      navigate('/summary/raw')
                    }}
                  >
                    <FlexBox
                      alignItems="Center"
                      style={{ width: '100%', gap: '0.5rem', padding: '0.25rem 0' }}
                    >
                      <FlexBox direction="Column" className="recent-file-pick">
                        <Text style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {file.fileName}
                        </Text>
                        <Text style={{ fontSize: 'var(--sapFontSmallSize)', color: 'var(--sapContent_LabelColor)' }}>
                          {formatFileSize(file.fileSize)} · {file.rows.length.toLocaleString()} rows · {formatRelativeTime(file.uploadedAt)}
                        </Text>
                      </FlexBox>
                      {compareMode ? (
                        <FlexBox style={{ gap: '0.25rem', flexShrink: 0 }}>
                          <Button
                            design={isBaseline ? 'Emphasized' : 'Default'}
                            onClick={() => pickBaseline(file.id)}
                          >
                            Baseline
                          </Button>
                          <Button
                            design={isCurrent ? 'Emphasized' : 'Default'}
                            onClick={() => pickCurrent(file.id)}
                          >
                            Current
                          </Button>
                        </FlexBox>
                      ) : (
                        <Button
                          design="Transparent"
                          icon="decline"
                          tooltip={`Remove ${file.fileName} from recent files`}
                          onClick={(e) => {
                            e.stopPropagation()
                            removeRecentFile(file.id)
                          }}
                        />
                      )}
                    </FlexBox>
                  </ListItemCustom>
                )
              })}
            </List>
          )}
          {compareMode && compareBaselineId && compareCurrentId && compareBaselineId !== compareCurrentId && (
            <FlexBox justifyContent="End" style={{ padding: '0.5rem 1rem 0.75rem' }}>
              <Button design="Emphasized" icon="arrow-right" iconEnd onClick={submitCompare}>
                Compare
              </Button>
            </FlexBox>
          )}
        </Card>
      </FlexBox>

      <CsvValidationDialog
        open={Boolean(validation)}
        fileName={pendingCsv?.fileName}
        available={validation?.available ?? []}
        missing={validation?.missing ?? []}
        affectedViews={validation?.affectedViews ?? []}
        canProceed={validation?.canProceed ?? false}
        onContinue={confirmValidation}
        onCancel={closeValidation}
      />
    </>
  )
}

export default UploadPage
