// Installs the Python backend dependencies after `npm install`.
// Finds whichever Python command exists and uses `python -m pip` so it works
// even when a bare `pip` is not on PATH (common on Windows).

import { spawnSync } from 'node:child_process'

const candidates =
  process.platform === 'win32'
    ? ['py', 'python', 'python3']
    : ['python3', 'python']

const works = (cmd) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0
const python = candidates.find(works)

if (!python) {
  console.warn('\n[backend] Python not found on PATH — skipping backend dependency install.')
  console.warn('[backend] Install Python 3.10+, then run this from the project root:')
  console.warn('[backend]   python -m pip install -r backend/requirements.txt\n')
  process.exit(0)
}

const result = spawnSync(python, ['-m', 'pip', 'install', '-r', 'backend/requirements.txt'], {
  stdio: 'inherit',
})

if (result.status !== 0) {
  console.warn('\n[backend] Backend dependency install failed. Run it manually from the project root:')
  console.warn(`[backend]   ${python} -m pip install -r backend/requirements.txt\n`)
}

// Always exit 0 — a pip failure is non-fatal for frontend-only environments (e.g. Vercel).
process.exit(0)
