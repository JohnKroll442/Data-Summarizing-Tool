# COE Datasphere Performance Tool — AI Backend

Flask service that runs the multi-agent analysis pipeline.
The frontend sends a question + dataset; this service routes it through
the Orchestrator → subagents → Narrator and returns a structured response.

---

## Setup

```bash
cd backend
pip install -r requirements.txt
cp env.example .env          # then fill in AI_CORE_URL and AI_CORE_TOKEN
python app.py                # dev server on port 5000
```

Production:
```bash
gunicorn -w 2 -b 0.0.0.0:5000 app:app
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `AI_CORE_URL` | Yes | Full chat completions endpoint URL |
| `AI_CORE_TOKEN` | Yes | Bearer token |
| `AI_CORE_MODEL` | No | Model name (default: gpt-4o) |
| `AI_CORE_MAX_TOKENS` | No | Max tokens per response (default: 4000) |
| `AI_CORE_TIMEOUT` | No | Request timeout seconds (default: 120) |
| `PORT` | No | Server port (default: 5000) |
| `DATASET_TTL_SEC` | No | Dataset cache TTL seconds (default: 3600) |

---

## Routes

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/chat` | Main entry point — runs the agent pipeline |
| POST | `/api/dataset` | Store aggRows, get dataset_id |
| GET | `/api/actions` | Filtered row queries for Explorer Agent detail mode |
| GET | `/api/health` | Liveness probe |

---

## File structure

```
backend/
  app.py            Flask routes + dataset store
  llm.py            AI Core LLM wrapper  (call_llm stub — complete below)
  orchestrate.py    Multi-agent pipeline loop
  prompts/          Agent system prompt files (one per agent)
  requirements.txt
  env.example       Rename to .env and fill in credentials
```

---

## Step 1 — Implementing call_llm() in VS Code

Open `backend/llm.py`. Find `call_llm()` and replace the
`raise NotImplementedError(...)` with:

```python
    ai_core_url   = os.getenv("AI_CORE_URL",   "").strip()
    ai_core_token = os.getenv("AI_CORE_TOKEN", "").strip()

    if not ai_core_url:
        raise RuntimeError("AI_CORE_URL is not set in backend/.env")
    if not ai_core_token:
        raise RuntimeError("AI_CORE_TOKEN is not set in backend/.env")

    if ai_core_url.startswith("https://"):
        scheme, rest = "https", ai_core_url[8:]
    elif ai_core_url.startswith("http://"):
        scheme, rest = "http", ai_core_url[7:]
    else:
        raise ValueError(f"Unsupported scheme: {ai_core_url[:30]}")

    slash = rest.find("/")
    host  = rest if slash == -1 else rest[:slash]
    path  = "/"  if slash == -1 else rest[slash:]

    body_bytes = json.dumps({
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_message},
        ],
        "model":      AI_CORE_MODEL,
        "max_tokens": AI_CORE_MAX_TOKENS,
    }).encode("utf-8")

    headers = {
        "Content-Type":   "application/json",
        "Authorization":  f"Bearer {ai_core_token}",
        "Content-Length": str(len(body_bytes)),
    }

    import http.client
    conn = (http.client.HTTPSConnection if scheme == "https"
            else http.client.HTTPConnection)(host, timeout=AI_CORE_TIMEOUT)
    try:
        conn.request("POST", path, body=body_bytes, headers=headers)
        resp      = conn.getresponse()
        resp_body = resp.read().decode("utf-8")
    finally:
        conn.close()

    if resp.status >= 400:
        raise RuntimeError(f"AI Core HTTP {resp.status}: {resp_body[:500]}")

    return json.loads(resp_body)["choices"][0]["message"]["content"]
```

---

## Step 2 — Implementing _fetch_detail_rows() in VS Code

Open `backend/orchestrate.py`. Find `_fetch_detail_rows()` and replace the
`log.warning(...)` + `return []` stub with:

```python
    q_lower     = question.lower()
    user_filter = None

    apostrophe = question.find("'s")
    if apostrophe != -1:
        word_start  = question.rfind(" ", 0, apostrophe) + 1
        user_filter = question[word_start:apostrophe]

    if not user_filter:
        for prefix in ["for ", "by ", "show me "]:
            idx = q_lower.find(prefix)
            if idx != -1:
                candidate = question[idx + len(prefix):].split()[0].rstrip("'s,")
                if len(candidate) > 2:
                    user_filter = candidate
                    break

    if not user_filter:
        return []

    import http.client, json as _json
    path = f"/api/actions?dataset_id={dataset_id}&user={user_filter}"
    log.info("Detail fetch: %s", path)

    try:
        conn = http.client.HTTPConnection(BACKEND_HOST, BACKEND_PORT, timeout=10)
        conn.request("GET", path)
        resp      = conn.getresponse()
        resp_body = resp.read().decode("utf-8")
        conn.close()
        if resp.status == 200:
            return _json.loads(resp_body).get("rows", [])
    except Exception as exc:
        log.warning("Detail fetch failed: %s", exc)

    return []
```

---

## How the pipeline works

```
POST /api/chat  { question, payload, agg_rows }
        │
        ├── store agg_rows → dataset_id
        ├── inject dataset_id → payload.meta.dataset_id
        │
        └── orchestrate(question, payload, dataset_id)
                │
                ├── classify_intent()           1 LLM call
                │
                ├── KPI_SUMMARY                 1 LLM call
                ├── ANOMALY_SUMMARY             1 LLM call
                ├── ROOT_CAUSE_ANALYSIS         2 LLM calls (anomaly → root cause)
                ├── DATA_EXPLORATION            1 LLM call  (+ GET /api/actions if detail)
                └── FULL_ANALYSIS               3 LLM calls (stats + anomaly parallel → narrator)
```

Total per request: 2–4 LLM calls.

---

## Testing without AI Core

With `AI_CORE_URL` unset, `POST /api/chat` returns:
```json
{ "status": "not_configured", "message": "..." }
```

With `AI_CORE_URL` set but `call_llm()` not yet implemented, it returns HTTP 503.
Once `call_llm()` is pasted in and credentials are set, the full pipeline runs.

# COE Datasphere Performance Tool — Backend Service

Flask service that bridges the React frontend and AI Core agents.

## Architecture

```
Browser (React tool)
        │
        │  POST /api/chat  { question, payload, agg_rows }
        ▼
backend/app.py  (this service)
        │
        ├── stores agg_rows in memory → dataset_id
        ├── injects dataset_id into payload.meta
        │
        │  POST AI_CORE_URL  { question, payload }
        ▼
SAP AI Core Orchestration
        │
        │  (Explorer Agent, detail mode)
        │  GET /api/actions?dataset_id=<id>&user=<user>
        ▼
backend/app.py  /api/actions  → filtered rows → Explorer Agent
```

## Setup

```bash
cd backend
pip install -r requirements.txt
```

## Run (development)

```bash
python app.py
# → http://localhost:5000
```

## Run (production)

```bash
gunicorn -w 2 -b 0.0.0.0:5000 app:app
```

## Environment variables

| Variable         | Required | Description |
|------------------|----------|-------------|
| `PORT`           | No       | Server port (default: 5000) |
| `DATASET_TTL_SEC`| No       | Dataset cache TTL seconds (default: 3600) |
| `AI_CORE_URL`    | Yes      | AI Core orchestration endpoint URL |
| `AI_CORE_TOKEN`  | Yes      | Bearer token for AI Core authentication |

Set them in a `.env` file (or CF manifest / K8s secret in production):

```
AI_CORE_URL=https://<your-ai-core-endpoint>/chat
AI_CORE_TOKEN=<your-token>
```

## TODO — Wire up the AI Core proxy (VS Code step)

In `app.py`, the `POST /api/chat` route has a TODO comment where the outbound
call to AI Core must be added. Pattern to implement:

```python
import httpx  # or use http.client from stdlib

ai_core_url   = os.getenv("AI_CORE_URL")
ai_core_token = os.getenv("AI_CORE_TOKEN")

if not ai_core_url:
    return jsonify({"error": "AI_CORE_URL not configured"}), 503

headers = {
    "Content-Type":  "application/json",
    "Authorization": f"Bearer {ai_core_token}",
}
body = json.dumps({"question": question, "payload": payload}).encode("utf-8")

# httpx (recommended — handles timeouts cleanly):
with httpx.Client(timeout=120) as client:
    resp = client.post(ai_core_url, content=body, headers=headers)
    resp.raise_for_status()
    return jsonify(resp.json()), resp.status_code
```

Add `httpx>=0.27.0` to `requirements.txt` when you implement this.

## API reference

### POST /api/dataset

Store the full aggRows array from the frontend. Called by the frontend
before or alongside /api/chat to enable row-level detail queries.

**Request:**
```json
{
  "rows": [
    {
      "action_name":       "Display Vendor Invoice",
      "story_name":        "LS_OPEX_SG&A_PM_STORY",
      "user":              "DVIJAYAN",
      "session_id":        "1785410815681vd9vb5C",
      "action_duration_ms": 187432,
      "action_timestamp":  "2026-09-15T10:23:00"
    }
  ]
}
```

**Response:**
```json
{
  "dataset_id":     "3f2e1a0b-...",
  "row_count":      2070,
  "expires_in_sec": 3600
}
```

---

### GET /api/actions

Return filtered rows for a stored dataset. The Explorer Agent calls this
when the user asks for row-level detail (e.g. "show me all DVIJAYAN's actions").

**Query params:**

| Param            | Required | Type   | Description |
|------------------|----------|--------|-------------|
| `dataset_id`     | Yes      | string | UUID from /api/dataset |
| `user`           | No       | string | Exact match on user field |
| `story`          | No       | string | Exact match on story_name |
| `action_name`    | No       | string | Exact match on action_name |
| `duration_min_ms`| No       | int    | Min duration inclusive (ms) |
| `duration_max_ms`| No       | int    | Max duration inclusive (ms) |
| `limit`          | No       | int    | Max rows to return (default 500, max 5000) |

**Example:**
```
GET /api/actions?dataset_id=3f2e1a0b-...&user=DVIJAYAN&duration_min_ms=60000
```

**Response:**
```json
{
  "dataset_id":      "3f2e1a0b-...",
  "filters_applied": { "user": "DVIJAYAN", "duration_min_ms": 60000 },
  "total_matching":  12,
  "rows": [
    {
      "action_name":        "Display Vendor Invoice",
      "story_name":         "LS_OPEX_SG&A_PM_STORY",
      "user":               "DVIJAYAN",
      "session_id":         "1785410815681vd9vb5C",
      "action_duration_ms": 187432,
      "action_timestamp":   "2026-09-15T10:23:00"
    }
  ]
}
```

Rows are sorted by `action_duration_ms` descending (slowest first).

---

### GET /api/health

```json
{ "status": "ok", "datasets_cached": 3 }
```
