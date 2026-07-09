import ReactMarkdown from 'react-markdown'

function TableCard({ node }) {
  const thead = node.children.find((c) => c.tagName === 'thead')
  const tbody = node.children.find((c) => c.tagName === 'tbody')
  if (!thead || !tbody) return null

  const headerRow = thead.children.find((c) => c.tagName === 'tr')
  const headers = headerRow
    ? headerRow.children.filter((c) => c.tagName === 'th').map(cellText)
    : []

  const dataRows = tbody.children
    .filter((c) => c.tagName === 'tr')
    .map((tr) => tr.children.filter((c) => c.tagName === 'td').map(cellText))

  // Single data column: metric list (e.g. describe_dataset output)
  if (headers.length === 2 && dataRows.every((r) => r.length === 2)) {
    return (
      <dl className="md-kv">
        {dataRows.map((row, i) => (
          <div key={i} className="md-kv-row">
            <dt dangerouslySetInnerHTML={{ __html: row[0] }} />
            <dd dangerouslySetInnerHTML={{ __html: row[1] }} />
          </div>
        ))}
      </dl>
    )
  }

  // Multi-column: one card per data row
  return (
    <div className="md-cards">
      {dataRows.map((row, ri) => (
        <div key={ri} className="md-card">
          {headers[0] && row[0] && (
            <div className="md-card-title" dangerouslySetInnerHTML={{ __html: row[0] }} />
          )}
          {headers.slice(1).map((h, hi) => (
            <div key={hi} className="md-card-row">
              <span className="md-card-key" dangerouslySetInnerHTML={{ __html: h }} />
              <span className="md-card-val" dangerouslySetInnerHTML={{ __html: row[hi + 1] ?? '—' }} />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function cellText(cell) {
  return extractText(cell)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
}

function extractText(node) {
  if (!node) return ''
  if (node.type === 'text') return node.value || ''
  if (node.children) return node.children.map(extractText).join('')
  return ''
}

const components = {
  table: ({ node }) => <TableCard node={node} />,
  p: ({ children }) => <p className="md-p">{children}</p>,
  ul: ({ children }) => <ul className="md-ul">{children}</ul>,
  ol: ({ children }) => <ol className="md-ol">{children}</ol>,
  li: ({ children }) => <li className="md-li">{children}</li>,
  strong: ({ children }) => <strong className="md-strong">{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  code: ({ inline, children }) =>
    inline
      ? <code className="md-code-inline">{children}</code>
      : <pre className="md-code-block"><code>{children}</code></pre>,
  h1: ({ children }) => <p className="md-heading">{children}</p>,
  h2: ({ children }) => <p className="md-heading">{children}</p>,
  h3: ({ children }) => <p className="md-subheading">{children}</p>,
  hr: () => <hr className="md-hr" />,
  blockquote: ({ children }) => <blockquote className="md-blockquote">{children}</blockquote>,
}

function MarkdownMessage({ content }) {
  return (
    <div className="md-root">
      <ReactMarkdown components={components}>{content}</ReactMarkdown>
    </div>
  )
}

export default MarkdownMessage
