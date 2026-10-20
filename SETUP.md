# Setup Guide — Data Summarizing Tool

Follow these steps in order. By the end you will have the app running in your browser.
The whole process takes about 15 minutes on a machine that already has the prerequisites.

This guide covers **Windows**, **macOS**, and **Linux**. Where commands differ, both are shown.

---

## What you are setting up

- A **frontend** (React, runs in your browser on port `5173`)
- A **backend** (Python/Flask, runs in the background on port `5000`)

Both start together with a single command. No database or other infrastructure is required.

---

## Step 1 — Install the prerequisites

You need three things installed **before** you start. Install any that are missing.

### 1a. Git

- Download: https://git-scm.com/downloads
- Verify it works by opening a terminal and running:
  ```bash
  git --version
  ```
  You should see a version number (e.g. `git version 2.56.0`).

### 1b. Node.js (version 18 or higher)

- Download the **LTS** version: https://nodejs.org
- Verify:
  ```bash
  node --version
  ```
  You should see `v18.x.x` or higher.

### 1c. Python (version 3.10 or higher)

- Download: https://www.python.org/downloads/
- **Windows users — this is important:** on the first screen of the installer,
  check the box **"Add python.exe to PATH"** before clicking Install. If you skip
  this, the commands below will not be found.
- Verify:
  ```bash
  python --version
  ```
  You should see `Python 3.10.x` or higher.

  **If `python` is not recognized on Windows**, try:
  ```bash
  py --version
  ```
  If `py` works but `python` does not, that is fine — this project handles both.
  If neither works, re-install Python and make sure "Add python.exe to PATH" is checked,
  then **close and reopen your terminal**.

> After installing anything in this step, **close and reopen your terminal** so the
> new commands are picked up.

---

## Step 2 — Clone the project

Pick a folder where you keep code, open a terminal there, and run:

```bash
git clone -b merged-agents https://github.com/JohnKroll442/Data-Summarizing-Tool.git
cd Data-Summarizing-Tool
```

This downloads the `merged-agents` branch and moves you into the project folder.
Run every remaining command from inside this folder.

---

## Step 3 — Install all dependencies

Run:

```bash
npm install
```

This installs **both** the frontend packages **and** the Python backend packages
(`flask`, `flask-cors`, `gunicorn`, `python-dotenv`) automatically. It may take a
few minutes the first time.

> If you see a message that says `Python not found on PATH — skipping backend
> dependency install`, go back to Step 1c, install Python correctly, reopen your
> terminal, and run `npm install` again.

---

## Step 4 — Add your API credentials

The backend talks to an AI service, and it needs credentials for that service.
These are secret, so they are **not** included in the project — you add them yourself.

### 4a. Create the credentials file

Copy the provided template:

- **macOS / Linux:**
  ```bash
  cp backend/env.example backend/.env
  ```
- **Windows (Command Prompt):**
  ```cmd
  copy backend\env.example backend\.env
  ```
- **Windows (PowerShell):**
  ```powershell
  Copy-Item backend\env.example backend\.env
  ```

### 4b. Fill in your credentials

Open the new file `backend/.env` in any text editor. Fill in **only one** of the
three options below — whichever matches the AI service you have access to. Delete
or ignore the other two.

**Option A — HyperSpace / corporate proxy (most common for SAP teams):**
```
LLM_URL=<paste your proxy URL here>
LLM_API_KEY=<paste your API key here>
LLM_MODEL=claude-3-5-sonnet-20241022
LLM_PROVIDER=anthropic
```

**Option B — OpenAI:**
```
OPENAI_API_KEY=<paste your OpenAI key here>
```

**Option C — SAP AI Core:**
```
AI_CORE_URL=<paste your AI Core URL here>
AI_CORE_TOKEN=<paste your bearer token here>
```

Leave every other line in the file as-is — those already have working defaults.

> **Where do I get credentials?** From whoever gave you access to this tool (your
> team lead or the project owner). If you do not have them yet, you can still finish
> this guide — the app will open, but the AI analysis features will return an error
> until valid credentials are in place.

> **Note:** There may also be a `.env` file in the project **root** folder. That one
> is unrelated to this app (it is for editor tooling). You do **not** need to touch it.
> The only credentials file that matters is `backend/.env`.

---

## Step 5 — Start the app

Run:

```bash
npm run dev
```

This starts the frontend and backend together. You will see two coloured log
streams in the terminal:

- `[web]`  — the frontend
- `[api]`  — the backend

Wait until the `[web]` stream prints a line like:

```
Local:   http://localhost:5173/
```

Leave this terminal open — closing it stops the app.

---

## Step 6 — Open the app

In your browser, go to:

```
http://localhost:5173
```

The app should load. The frontend automatically connects to the backend on port
`5000`, so you only ever open the `5173` address.

---

## Stopping the app

In the terminal running `npm run dev`, press **Ctrl + C**. Both the frontend and
backend stop together.

To start it again later, just run `npm run dev` from the project folder. You do
**not** need to repeat Steps 1–4.

---

## Troubleshooting

**`'npm' is not recognized` / `command not found: npm`**
Node.js is not installed or not on PATH. Redo Step 1b, then close and reopen your terminal.

**`npm install` fails with a Python or `pip` error**
Python is missing or not on PATH. Redo Step 1c (on Windows, make sure "Add python.exe
to PATH" was checked), reopen your terminal, and run `npm install` again. You can also
install the backend packages manually from the project root:
```bash
python -m pip install -r backend/requirements.txt
```
On Windows, if `python` is not recognized, use:
```bash
py -m pip install -r backend/requirements.txt
```

**The app opens but AI features show "AI service not configured" or an error**
Your `backend/.env` file is missing or its credentials are blank. Redo Step 4, then
stop the app (Ctrl + C) and run `npm run dev` again.

**`Port already in use` (5000 or 5173)**
Another program is using that port. Either close that program, or change the backend
port: open `backend/.env`, set `PORT=5001`, then create a file named `.env.local` in
the project **root** containing:
```
VITE_BACKEND_URL=http://localhost:5001
```
Restart the app.

**Backend changes don't show up**
The backend does not auto-reload. Stop the app (Ctrl + C) and run `npm run dev` again.

**Nothing loads at http://localhost:5173**
Make sure `npm run dev` is still running and that the `[web]` stream printed the
`Local: http://localhost:5173/` line. If only `[api]` started, check the terminal for
a Python error and see the troubleshooting items above.
