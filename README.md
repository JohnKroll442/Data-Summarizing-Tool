# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and Oxlint's TypeScript related rules in your project.

## Copilot (agentic AI)

The app ships a chat drawer (bottom-right) that lets analysts ask questions of the currently-loaded CSV data. Claude answers by calling in-app tools that query the aggregators in `src/lib/` — no raw rows are sent to the API, and results are capped at 50 rows per call.

### Local setup (sample data only)

Create a `.env` file at the repo root:

```
VITE_ANTHROPIC_API_KEY=sk-ant-...
VITE_COPILOT_MODE=direct
```

`direct` mode calls the Anthropic API from the browser with `dangerouslyAllowBrowser: true`. **This exposes the API key to anyone who loads the page.** Use it only for local dev with non-sensitive sample data. A one-time console warning fires whenever direct mode is used.

### Production / customer data path

When the CSVs contain real customer telemetry:

1. Stand up a small backend that owns the API key server-side. The minimum shape is `POST /api/chat` accepting `{ system, messages, tools }` and forwarding to `anthropic.messages.create` (either non-streaming JSON pass-through, or streaming — the client handles both).
2. Set `VITE_COPILOT_MODE=proxy` in the frontend env. No client code changes needed — `src/lib/copilot/client.js` switches to `fetch('/api/chat', ...)`.
3. Populate `PII_COLUMNS` in `src/lib/copilot/tools.js` with the column names that must not leave the server (`USERNAME`, `SESSION_ID`, `BROWSERSESSION_ID`, etc.). Every tool return path already runs rows through `redactRow`.

### What the agent can do

Backed by 7 tools in `src/lib/copilot/tools.js`:

- `describe_dataset` — column names, row counts, which files are loaded
- `top_regressions` — biggest baseline→current deltas (action / widget / session)
- `compare_entity` — baseline/current/delta for a single named entity
- `list_slow` — slowest entities in the active file, filterable by phase
- `get_session_actions` — what a specific session did, sorted by max duration
- `filter_rows` — generic predicate filter over aggregated or raw rows
- `phase_breakdown` — frontend/network/backend split for one action or widget

Model: `claude-sonnet-4-6`, with prompt caching on the static instructions and the dataset schema block.
