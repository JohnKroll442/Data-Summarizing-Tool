# Local Setup Guide

## Prerequisites

Make sure you have the following installed before you begin:

- **Node.js** v18 or higher — [nodejs.org](https://nodejs.org)
- **Python** 3.10 or higher — [python.org](https://python.org)
- **Git**
- Access to an LLM API (one of: HyperSpace/corporate proxy, OpenAI, or SAP AI Core)

---

## Step 1 — Clone the branch

```bash
git clone -b merged-agents <repo-url>
cd <repo-folder>
```

Replace `<repo-url>` with the repository URL and `<repo-folder>` with the folder name it clones into.

---

## Step 2 — Install all dependencies

From the root of the project:

```bash
npm install
```

This installs everything — React, ECharts, SAP UI5 components, and the Python backend packages (Flask etc.) in one shot.

---

## Step 3 — Configure your API credentials

The backend needs credentials for one LLM provider. Copy the example file:

```bash
cp backend/env.example backend/.env
```

On Windows:
```cmd
copy backend\env.example backend\.env
```

Open `backend/.env` in a text editor. Fill in **one** of the three options below — you only need one:

**Option A — HyperSpace or corporate proxy (most common for SAP teams):**
```
LLM_URL=<your proxy URL>
LLM_API_KEY=<your API key>
LLM_MODEL=claude-3-5-sonnet-20241022
LLM_PROVIDER=anthropic
```

**Option B — OpenAI direct:**
```
OPENAI_API_KEY=<your OpenAI key>
```

**Option C — SAP AI Core:**
```
AI_CORE_URL=<your AI Core URL>
AI_CORE_TOKEN=<your bearer token>
```

Everything else in the file already has sensible defaults — leave it as-is.

---

## Step 4 — Start the app

From the root of the project:

```bash
npm run dev
```

This starts both the frontend and backend at the same time. You will see two labelled log streams in your terminal — `[web]` for the frontend and `[api]` for the backend.

---

## Step 5 — Open the app

Once both services are running, open your browser and go to:

```
http://localhost:5173
```

The backend runs on port `5000` in the background — the frontend communicates with it automatically.

---

## Stopping the app

Press `Ctrl + C` in the terminal where `npm run dev` is running. Both the frontend and backend will stop.

---

## Troubleshooting

**"Module not found" or Python import errors**
Run `pip install -r backend/requirements.txt` again from the `backend/` folder.

**"AI service not configured" error in the chat**
Your `backend/.env` file is missing or the credentials are empty. Re-check Step 3.

**Port already in use**
Something else is running on port 5000 or 5173. Stop those processes, or set `PORT=5001` in `backend/.env` and `VITE_BACKEND_URL=http://localhost:5001` in a `.env.local` file at the root.

**Changes to backend Python files not reflected**
The backend does not auto-reload in production mode. Stop the app (`Ctrl + C`) and run `npm run dev` again.
