// Launches the Flask backend for `npm run dev`.
// Finds whichever Python command exists (py / python / python3) so the dev
// server starts even on machines where a bare `python` is not on PATH.

import { spawn, spawnSync } from 'node:child_process'

const candidates =
  process.platform === 'win32'
    ? ['py', 'python', 'python3']
    : ['python3', 'python']

const works = (cmd) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0
const python = candidates.find(works)

if (!python) {
  console.error('\n[backend] Python not found on PATH. Install Python 3.10+ and reopen your terminal.\n')
  process.exit(1)
}

const child = spawn(python, ['app.py'], { cwd: 'backend', stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))
