"""
AI Core Backend Service — COE Datasphere Performance Tool
==========================================================

Flask service that handles dataset storage and action filtering for the
Explorer Agent's detail-mode queries.

Routes
------
  POST /api/dataset                                Accept aggRows + widget_rows, return dataset_id
  GET  /api/actions                                Return filtered action rows by dataset_id
  GET  /api/widgets                                Return filtered widget rows by dataset_id
  POST /api/store/<id>/agent-output/<agent>        Store an agent's output in the mesh
  GET  /api/store/<id>/agent-output/<agent>        Read an agent's output from the mesh
  GET  /api/store/<id>/agent-output                List all agent outputs for a dataset
  POST /api/chat                                   Main chat entry point
  GET  /api/health                                 Liveness probe

NOTE — AI Core proxy (POST /api/chat)
--------------------------------------
The /api/chat route stores aggRows, injects dataset_id into the payload, then
forwards the question + payload to AI Core. The outbound call to AI Core must
be added in VS Code — it requires urllib or httpx which the sandbox cannot write.
See backend/README.md for the implementation pattern.

Run
---
  pip install -r requirements.txt
  python app.py               # dev  (http://localhost:5000)
  gunicorn -w 2 -b 0.0.0.0:5000 app:app   # production

Environment variables
---------------------
  PORT              Server port (default: 5000)
  DATASET_TTL_SEC   Dataset cache TTL in seconds (default: 3600)
  AI_CORE_URL       AI Core orchestration URL (for /api/chat)
  AI_CORE_TOKEN     Bearer token for AI Core
"""

from dotenv import load_dotenv
load_dotenv()

import os
import json
import time
import uuid
import logging
from flask import Flask, request, jsonify
from flask_cors import CORS
from orchestrate import orchestrate, plan_turn
from skills import AVAILABLE_SKILLS
import mesh_store

# ─── app setup ────────────────────────────────────────────────────────────────

app = Flask(__name__)
CORS(app)

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
log = logging.getLogger(__name__)


def _env_int(name: str, default: int) -> int:
    """Parse an int env var, falling back to the default on a bad value
    instead of crashing the server at import time."""
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except (ValueError, TypeError):
        log.warning("Invalid %s=%r — using default %d", name, raw, default)
        return default


PORT            = _env_int("PORT", 5000)
DATASET_TTL_SEC = _env_int("DATASET_TTL_SEC", 3600)

# ─── in-memory stores (shared via mesh_store module) ─────────────────────────
#
# All state lives in mesh_store.py so orchestrate.py can access the same dicts
# without a circular import. These aliases keep the rest of this file unchanged.

_datasets      = mesh_store.datasets
_agent_outputs = mesh_store.agent_outputs
mesh_store.DATASET_TTL_SEC = DATASET_TTL_SEC  # sync the TTL

def _evict_expired() -> None:
    mesh_store.evict_expired()


# ─── POST /api/dataset ────────────────────────────────────────────────────────

@app.route("/api/dataset", methods=["POST"])
def store_dataset():
    """
    Store the full aggRows and optional widget-aggregate rows from the frontend.

    Request body:
      { "rows": [...], "widget_rows": [...] (optional) }

    Response:
      { "dataset_id": "<uuid>", "row_count": N, "widget_row_count": N, "expires_in_sec": N }
    """
    body = request.get_json(force=True, silent=True) or {}
    rows = body.get("rows")
    widget_rows = body.get("widget_rows", [])

    if not isinstance(rows, list):
        return jsonify({"error": "Body must contain a 'rows' array"}), 400
    if len(rows) == 0:
        return jsonify({"error": "'rows' array is empty"}), 400

    _evict_expired()

    dataset_id = str(uuid.uuid4())
    safe_widget_rows = widget_rows if isinstance(widget_rows, list) else []
    stored_at = time.time()
    mesh_store.normalize_rows(rows)
    _datasets[dataset_id] = {
        "rows": rows,
        "widget_rows": safe_widget_rows,
        "stored_at": stored_at,
    }

    # Persist to disk for audit trail and agent fallback
    snapshot_path = mesh_store.persist_to_disk(dataset_id, rows, safe_widget_rows, stored_at)

    log.info("Stored dataset %s — %d action rows, %d widget rows", dataset_id, len(rows), len(safe_widget_rows))
    return jsonify({
        "dataset_id":       dataset_id,
        "row_count":        len(rows),
        "widget_row_count": len(safe_widget_rows),
        "expires_in_sec":   DATASET_TTL_SEC,
        "persisted":        snapshot_path is not None,
        "snapshot_path":    snapshot_path,
    }), 201


# ─── GET /api/actions ─────────────────────────────────────────────────────────

@app.route("/api/actions", methods=["GET"])
def get_actions():
    """
    Return filtered action rows for a stored dataset.

    This is the endpoint the Explorer Agent calls in detail mode.

    Query parameters
    ----------------
    dataset_id         required   UUID from POST /api/dataset
    user               optional   exact match on 'user' (case-insensitive)
    story              optional   exact match on 'story_name' (case-insensitive)
    action_name        optional   exact match on 'action_name' (case-insensitive)
    session            optional   exact match on 'session_id'
    date               optional   'YYYY-MM-DD' — actions on that calendar day
    hour_of_day        optional   int 0-23 — actions in that hour of day
    duration_min_ms    optional   inclusive lower bound (ms)
    duration_max_ms    optional   inclusive upper bound (ms)
    limit              optional   max rows returned (default 500, max 5000)

    Response
    --------
    {
      "dataset_id":      "<uuid>",
      "filters_applied": { ... },
      "total_matching":  N,
      "rows": [ { action_name, story_name, user, session_id,
                  action_duration_ms, action_timestamp }, ... ]
    }

    Rows are sorted by action_duration_ms descending (slowest first).
    """
    dataset_id = request.args.get("dataset_id", "").strip()
    if not dataset_id:
        return jsonify({"error": "dataset_id query parameter is required"}), 400

    entry = mesh_store.get_dataset(dataset_id)
    if entry is None:
        return jsonify({"error": f"Dataset '{dataset_id}' not found or expired (checked memory and disk)"}), 404

    rows = entry["rows"]

    # ── parse filters ──────────────────────────────────────────────────────────
    user_filter        = request.args.get("user",        "").strip() or None
    story_filter       = request.args.get("story",       "").strip() or None
    action_name_filter = request.args.get("action_name", "").strip() or None
    session_filter     = request.args.get("session",     "").strip() or None
    date_filter        = request.args.get("date",        "").strip() or None
    hour_filter        = _to_int(request.args.get("hour_of_day", ""))
    duration_min       = _to_int(request.args.get("duration_min_ms", ""))
    duration_max       = _to_int(request.args.get("duration_max_ms", ""))
    limit              = min(_to_int(request.args.get("limit", "")) or 500, 5000)

    # Single source of truth: filter through the SAME engine the on-demand
    # aggregation uses (query_engine.filter_rows), so a scoped count and this
    # row list for the same query can never disagree. Entity matches are
    # case-insensitive; duration bounds and hour/date are exact.
    filter_spec = {
        "user":            user_filter,
        "story":           story_filter,
        "action":          action_name_filter,
        "session":         session_filter,
        "date":            date_filter,
        "hour_of_day":     hour_filter,
        "duration_min_ms": duration_min,
        "duration_max_ms": duration_max,
    }
    filters_applied = {k: v for k, v in filter_spec.items() if v is not None}

    # ── apply filters ──────────────────────────────────────────────────────────
    import query_engine as _qe
    filtered = list(_qe.filter_rows(rows, filter_spec))
    total_matching = len(filtered)

    # Slowest first — most useful default for perf-analysis queries
    filtered.sort(key=lambda r: _qe._row_duration(r) or 0, reverse=True)

    log.info(
        "GET /api/actions  dataset=%s  filters=%s  matched=%d  returned=%d",
        dataset_id, filters_applied, total_matching, min(total_matching, limit),
    )

    return jsonify({
        "dataset_id":      dataset_id,
        "filters_applied": filters_applied,
        "total_matching":  total_matching,
        "rows":            filtered[:limit],
    })


# ─── GET /api/widgets ─────────────────────────────────────────────────────────

@app.route("/api/widgets", methods=["GET"])
def get_widgets():
    """
    Return widget-level timing rows for a stored dataset, filtered by action_key.

    This is the endpoint the Trace Agent calls for widget-level phase data.
    Widget rows come from aggregateByWidget() on the frontend — one row per
    WIDGET_ID with exclusive render/network/backend/offset/total timings.

    Query parameters
    ----------------
    dataset_id         required   UUID from POST /api/dataset
    action_key         optional   composite 'action_name::action_timestamp' key
    session_id         optional   exact match on 'session_id'
    widget_name        optional   exact match on 'widget_name'
    limit              optional   max rows returned (default 500, max 5000)

    Response
    --------
    {
      "dataset_id":      "<uuid>",
      "filters_applied": { ... },
      "total_matching":  N,
      "rows": [ { widget_id, widget_name, session_id, render, network,
                  backend, offset, total, render_start, render_end,
                  network_start, network_end, backend_start, backend_end } ]
    }

    Rows are sorted by total descending (slowest widget first).
    """
    dataset_id = request.args.get("dataset_id", "").strip()
    if not dataset_id:
        return jsonify({"error": "dataset_id query parameter is required"}), 400

    entry = mesh_store.get_dataset(dataset_id)
    if entry is None:
        return jsonify({"error": f"Dataset '{dataset_id}' not found or expired (checked memory and disk)"}), 404

    widget_rows = entry.get("widget_rows", [])
    if not widget_rows:
        return jsonify({
            "dataset_id":      dataset_id,
            "filters_applied": {},
            "total_matching":  0,
            "rows":            [],
            "note":            "No widget rows stored for this dataset. Frontend must send widget_rows in POST /api/dataset.",
        })

    # ── parse filters ──────────────────────────────────────────────────────────
    action_key_filter  = request.args.get("action_key",   "").strip() or None
    session_filter     = request.args.get("session_id",   "").strip() or None
    widget_name_filter = request.args.get("widget_name",  "").strip() or None
    limit              = min(_to_int(request.args.get("limit", "")) or 500, 5000)

    filters_applied = {}
    if action_key_filter:  filters_applied["action_key"]   = action_key_filter
    if session_filter:     filters_applied["session_id"]   = session_filter
    if widget_name_filter: filters_applied["widget_name"]  = widget_name_filter

    # ── apply filters ──────────────────────────────────────────────────────────
    def matches(row: dict) -> bool:
        if action_key_filter and row.get("action_key") != action_key_filter: return False
        if session_filter    and row.get("session_id")  != session_filter:    return False
        if widget_name_filter and row.get("widget_name") != widget_name_filter: return False
        return True

    filtered = [r for r in widget_rows if matches(r)]
    total_matching = len(filtered)

    # Slowest widget first
    filtered.sort(key=lambda r: r.get("total") if isinstance(r.get("total"), (int, float)) else 0, reverse=True)

    log.info(
        "GET /api/widgets  dataset=%s  filters=%s  matched=%d  returned=%d",
        dataset_id, filters_applied, total_matching, min(total_matching, limit),
    )

    return jsonify({
        "dataset_id":      dataset_id,
        "filters_applied": filters_applied,
        "total_matching":  total_matching,
        "rows":            filtered[:limit],
    })


# ─── POST /api/chat ───────────────────────────────────────────────────────────

@app.route("/api/chat", methods=["POST"])
def chat():
    """
    Main chat entry point.

    Request body:
      {
        "question":  "<user's question>",
        "payload":   { <agent payload from buildAgentPayload.js> },
        "agg_rows":  [ <full aggRows from aggregateByAction()> ]
      }

    This route:
      1. Stores agg_rows, gets a dataset_id
      2. Injects dataset_id into payload.meta
      3. Forwards { question, payload } to AI Core  ← add in VS Code (see README)
      4. Returns AI Core's response

    The outbound AI Core call is a TODO — implement it in VS Code by adding
    an HTTP POST to os.getenv("AI_CORE_URL") with Bearer os.getenv("AI_CORE_TOKEN").
    """
    body = request.get_json(force=True, silent=True) or {}

    question     = body.get("question", "").strip()
    payload      = body.get("payload")
    agg_rows     = body.get("agg_rows", [])
    direct_agent = body.get("agent", "auto").strip() or "auto"

    if not question:
        return jsonify({"error": "'question' is required"}), 400
    if not isinstance(payload, dict):
        return jsonify({"error": "'payload' must be a JSON object"}), 400

    # Store the dataset so agents can call GET /api/actions and GET /api/widgets
    dataset_id = None
    widget_rows = body.get("widget_rows", [])
    if isinstance(agg_rows, list) and agg_rows:
        _evict_expired()
        dataset_id = str(uuid.uuid4())
        safe_widget_rows = widget_rows if isinstance(widget_rows, list) else []
        stored_at = time.time()
        _datasets[dataset_id] = {
            "rows": agg_rows,
            "widget_rows": safe_widget_rows,
            "stored_at": stored_at,
        }
        # Persist to disk for audit trail and agent fallback
        mesh_store.persist_to_disk(dataset_id, agg_rows, safe_widget_rows, stored_at)
        log.info("Chat: stored dataset %s — %d action rows, %d widget rows",
                 dataset_id, len(agg_rows), len(safe_widget_rows))

    # Inject dataset_id so agents know which dataset to query
    if dataset_id:
        payload.setdefault("meta", {})["dataset_id"] = dataset_id

    # Run the multi-agent orchestration pipeline
    try:
        result = orchestrate(question, payload, dataset_id, direct_agent=direct_agent)
        return jsonify(result)
    except NotImplementedError:
        # call_llm() not yet implemented — return setup instructions
        return jsonify({
            "status":  "not_configured",
            "message": (
                "call_llm() in backend/llm.py is not yet implemented. "
                "Paste the network call from backend/README.md into the function, "
                "then set AI_CORE_URL and AI_CORE_TOKEN in backend/.env."
            ),
            "dataset_id": dataset_id,
        }), 503
    except RuntimeError as exc:
        log.error("Orchestration error: %s", exc)
        return jsonify({"error": str(exc)}), 502
    except Exception as exc:  # noqa: BLE001 — never leak a raw 500/traceback
        log.exception("Unexpected orchestration failure")
        return jsonify({"error": f"Internal error: {exc}"}), 500


# ─── Agent Output Store (mesh backbone) ──────────────────────────────────────

@app.route("/api/store/<dataset_id>/agent-output/<agent_name>", methods=["POST"])
def store_agent_output(dataset_id, agent_name):
    """
    Store an agent's confirmed output in the mesh.

    Any agent can write its own output here after confirmation.
    Other agents can then read it via GET without Orchestrator involvement.

    Request body: the agent's full output JSON object.

    Response:
      { "dataset_id": "<uuid>", "agent": "<name>", "stored": true }
    """
    _evict_expired()
    if dataset_id not in _datasets:
        return jsonify({"error": f"Dataset '{dataset_id}' not found or expired"}), 404

    body = request.get_json(force=True, silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "Body must be a JSON object"}), 400

    if dataset_id not in _agent_outputs:
        _agent_outputs[dataset_id] = {}

    _agent_outputs[dataset_id][agent_name] = {
        "output":    body,
        "stored_at": time.time(),
    }

    log.info("Stored agent output: dataset=%s agent=%s", dataset_id, agent_name)
    return jsonify({
        "dataset_id": dataset_id,
        "agent":      agent_name,
        "stored":     True,
    }), 201


@app.route("/api/store/<dataset_id>/agent-output/<agent_name>", methods=["GET"])
def read_agent_output(dataset_id, agent_name):
    """
    Read another agent's confirmed output from the mesh.

    Returns the full output JSON that agent stored, or 404 if it hasn't
    run yet for this dataset.
    """
    _evict_expired()
    if dataset_id not in _datasets:
        return jsonify({"error": f"Dataset '{dataset_id}' not found or expired"}), 404

    agent_store = _agent_outputs.get(dataset_id, {})
    entry = agent_store.get(agent_name)

    if entry is None:
        return jsonify({
            "error":      f"No output stored for agent '{agent_name}' on dataset '{dataset_id}'",
            "available":  list(agent_store.keys()),
        }), 404

    return jsonify(entry["output"])


@app.route("/api/store/<dataset_id>/agent-output", methods=["GET"])
def list_agent_outputs(dataset_id):
    """
    List all agent outputs stored for a dataset.

    Returns agent names and timestamps — useful for mesh discovery
    (an agent can check which other agents have already run).
    """
    _evict_expired()
    if dataset_id not in _datasets:
        return jsonify({"error": f"Dataset '{dataset_id}' not found or expired"}), 404

    agent_store = _agent_outputs.get(dataset_id, {})
    agents = []
    for name, entry in agent_store.items():
        agents.append({
            "agent":     name,
            "status":    entry["output"].get("status", "unknown"),
            "stored_at": entry["stored_at"],
        })

    return jsonify({
        "dataset_id": dataset_id,
        "agents":     agents,
    })


# ─── Session routes (multi-turn conversation with HITL) ───────────────────────
#
# Every question goes through two phases:
#
#   Phase 1 — Plan     POST /api/session  or  POST /api/session/<id>/continue
#     Classifies the intent and returns a plan (agents + LLM call count).
#     No agents run. Response status = "awaiting_confirmation".
#
#   Phase 2 — Execute  POST /api/session/<id>/confirm
#     Runs the agents. Response is the full analysis result.
#
#   Cancel             POST /api/session/<id>/reject
#     Clears the pending turn; session stays alive for a new question.
#
# Read-only:
#   GET    /api/session/<id>            Session state + history (payload excluded)
#   GET    /api/session/<id>/history    Conversation history only
#   DELETE /api/session/<id>            End / clear the session entirely


@app.route("/api/session", methods=["POST"])
def create_session_route():
    """
    HITL Phase 1 — Start a new session and classify the first question.

    Returns an execution plan for the user to review. No agents run yet.
    Call POST /api/session/<id>/confirm to execute, or /reject to cancel.

    Request body:
      {
        "question":    "<first user question>",
        "payload":     { <agent payload from buildAgentPayload.js> },
        "agg_rows":    [ <full aggRows> ],
        "widget_rows": [ <optional widget rows> ],
        "agent":       "<optional direct agent key>"
      }

    Response:
      {
        "status":          "awaiting_confirmation",
        "session_id":      "<uuid>",
        "intent":          "<classified intent>",
        "acknowledgement": "<friendly description>",
        "plan": {
          "description":         "<what will run>",
          "steps":               [ {step, agents, description}, ... ],
          "estimated_llm_calls": N
        },
        "turn": 1
      }
    """
    body         = request.get_json(force=True, silent=True) or {}
    question     = body.get("question", "").strip()
    payload      = body.get("payload")
    agg_rows     = body.get("agg_rows", [])
    widget_rows  = body.get("widget_rows", [])
    direct_agent = body.get("agent", "auto").strip() or "auto"

    if not question:
        return jsonify({"error": "'question' is required"}), 400
    if not isinstance(payload, dict):
        return jsonify({"error": "'payload' must be a JSON object"}), 400

    # ── Store dataset ─────────────────────────────────────────────────────────
    dataset_id = None
    if isinstance(agg_rows, list) and agg_rows:
        _evict_expired()
        dataset_id = str(uuid.uuid4())
        safe_widget_rows = widget_rows if isinstance(widget_rows, list) else []
        stored_at = time.time()
        mesh_store.normalize_rows(agg_rows)   # canonical fields for all read paths
        _datasets[dataset_id] = {
            "rows":        agg_rows,
            "widget_rows": safe_widget_rows,
            "stored_at":   stored_at,
        }
        # Persist to disk for audit trail and agent fallback
        mesh_store.persist_to_disk(dataset_id, agg_rows, safe_widget_rows, stored_at)
        log.info("Session: stored dataset %s — %d action rows, %d widget rows",
                 dataset_id, len(agg_rows), len(safe_widget_rows))

    if dataset_id:
        payload.setdefault("meta", {})["dataset_id"] = dataset_id

    # ── Create session ────────────────────────────────────────────────────────
    session_id = str(uuid.uuid4())
    mesh_store.create_session(session_id, dataset_id, question, payload,
                               intent="pending", steps=[])

    # ── Phase 1: classify intent and return plan (no agents run yet) ──────────
    result = plan_turn(question, payload, dataset_id,
                       session_id=session_id, direct_agent=direct_agent)
    return jsonify(result), 200


@app.route("/api/session/<session_id>/continue", methods=["POST"])
def continue_session(session_id):
    """
    HITL Phase 1 — Ask a follow-up question in an existing session.

    Returns a plan for confirmation. Call /confirm to run agents.

    Request body:
      {
        "question": "<follow-up question>",
        "agent":    "<optional direct agent key>"
      }

    Response: same shape as POST /api/session
      { "status": "awaiting_confirmation", "plan": {...}, "turn": N, ... }
    """
    session = mesh_store.get_session(session_id)
    if session is None:
        return jsonify({"error": f"Session '{session_id}' not found or expired"}), 404

    body         = request.get_json(force=True, silent=True) or {}
    question     = body.get("question", "").strip()
    direct_agent = body.get("agent", "auto").strip() or "auto"

    if not question:
        return jsonify({"error": "'question' is required"}), 400

    # Re-use the session's stored payload and dataset_id — no re-upload needed
    payload    = session["payload"]
    dataset_id = session.get("dataset_id")

    # Phase 1: classify and return plan — do NOT run agents yet
    result = plan_turn(question, payload, dataset_id,
                       session_id=session_id, direct_agent=direct_agent)
    return jsonify(result), 200


@app.route("/api/session/<session_id>/confirm", methods=["POST"])
def confirm_session(session_id):
    """
    HITL Phase 2 — Execute the pending turn after user confirmation.

    The session must be in 'awaiting_confirmation' status. The pending
    question and agent key are read from the session — no body required.

    Optional body:
      { "agent": "<override agent key>" }   (rarely needed)

    Response: full analysis result
      {
        "intent":        "<intent>",
        "response_text": "<agent output>",
        "agent_outputs": { ... },
        "session_id":    "<uuid>",
        "turn":          N,
        ...
      }
    """
    session = mesh_store.get_session(session_id)
    if session is None:
        return jsonify({"error": f"Session '{session_id}' not found or expired"}), 404

    if session.get("status") != "awaiting_confirmation":
        return jsonify({
            "error":   "Session is not awaiting confirmation.",
            "status":  session.get("status"),
            "hint":    "Call /continue with a question first, then /confirm to execute.",
        }), 409

    question     = session.get("pending_question", "")
    payload      = session["payload"]
    dataset_id   = session.get("dataset_id")
    direct_agent = session.get("pending_direct_agent", "auto")

    if not question:
        return jsonify({
            "error": "No pending question found. Call /continue with a question first."
        }), 400

    # Allow an optional agent override in the body
    body = request.get_json(force=True, silent=True) or {}
    if body.get("agent"):
        direct_agent = body["agent"].strip() or direct_agent

    mesh_store.update_session(session_id, status="running")
    try:
        result = orchestrate(question, payload, dataset_id,
                             direct_agent=direct_agent, session_id=session_id)
        mesh_store.update_session(session_id, status="active",
                                  pending_question=None, pending_direct_agent=None)
        return jsonify(result), 200
    except RuntimeError as exc:
        mesh_store.update_session(session_id, status="error")
        log.error("Session confirm error (session=%s): %s", session_id, exc)
        return jsonify({"error": str(exc), "session_id": session_id}), 502
    except Exception as exc:  # noqa: BLE001 — reset status so the session isn't stuck "running"
        mesh_store.update_session(session_id, status="error")
        log.exception("Unexpected session confirm failure (session=%s)", session_id)
        return jsonify({"error": f"Internal error: {exc}", "session_id": session_id}), 500


@app.route("/api/session/<session_id>/reject", methods=["POST"])
def reject_session(session_id):
    """
    Cancel a pending turn without running any agents.

    The session is reset to 'active' — the original dataset and full
    conversation history are preserved. The user can call /continue with
    a different question afterwards.

    Optional body:
      { "reason": "<optional note for logging>" }

    Response:
      {
        "session_id": "<uuid>",
        "status":     "active",
        "message":    "Turn rejected. Ask a new question via /continue."
      }
    """
    session = mesh_store.get_session(session_id)
    if session is None:
        return jsonify({"error": f"Session '{session_id}' not found or expired"}), 404

    body   = request.get_json(force=True, silent=True) or {}
    reason = body.get("reason", "")
    log.info("Session %s: turn rejected%s", session_id,
             f" — {reason}" if reason else "")

    mesh_store.update_session(
        session_id,
        status               = "active",
        pending_question     = None,
        pending_direct_agent = None,
    )
    return jsonify({
        "session_id": session_id,
        "status":     "active",
        "message":    "Turn rejected. Ask a new question via /continue.",
    }), 200


@app.route("/api/session/<session_id>", methods=["GET"])
def get_session_route(session_id):
    """
    Return the current state of a session.

    The full payload is excluded from the response (it can be several MB).
    Use this to poll session status, check which agents have run, or
    retrieve the full conversation history.

    Response:
      {
        "session_id":           "<uuid>",
        "dataset_id":           "<uuid>",
        "intent":               "<last classified intent>",
        "turn_count":           N,
        "completed_agents":     ["stats-agent", ...],
        "status":               "active",
        "last_response":        { ... },
        "conversation_history": [ {role, content, agent, intent, turn}, ... ]
      }
    """
    session = mesh_store.get_session(session_id)
    if session is None:
        return jsonify({"error": f"Session '{session_id}' not found or expired"}), 404

    # Return everything except the raw payload (too large for a status call)
    safe = {k: v for k, v in session.items() if k != "payload"}
    safe["turn_count"] = mesh_store.get_turn_count(session_id)
    return jsonify(safe)


@app.route("/api/session/<session_id>/history", methods=["GET"])
def get_session_history(session_id):
    """
    Return only the conversation history for a session.

    Each entry: { role, content, agent, intent, turn }

    Response:
      {
        "session_id": "<uuid>",
        "turn_count": N,
        "history":    [ ... ]
      }
    """
    session = mesh_store.get_session(session_id)
    if session is None:
        return jsonify({"error": f"Session '{session_id}' not found or expired"}), 404

    return jsonify({
        "session_id": session_id,
        "turn_count": mesh_store.get_turn_count(session_id),
        "history":    session.get("conversation_history", []),
    })


@app.route("/api/session/<session_id>", methods=["DELETE"])
def delete_session(session_id):
    """
    End and clear a session.

    The associated dataset and agent outputs remain in memory until their
    TTL expires — this only removes the conversation state.

    Response:
      { "deleted": true, "session_id": "<uuid>" }
    """
    if session_id in mesh_store.sessions:
        del mesh_store.sessions[session_id]
        log.info("Session deleted: %s", session_id)
        return jsonify({"deleted": True, "session_id": session_id})
    return jsonify({"error": f"Session '{session_id}' not found"}), 404


# ─── Dataset snapshots (disk persistence) ─────────────────────────────────────

@app.route("/api/datasets", methods=["GET"])
def list_datasets():
    """
    List all persisted dataset snapshots on disk.

    Returns summary info for each snapshot — dataset_id, row counts, timestamp,
    and file path. Agents and verification scripts use this to discover which
    datasets are available for re-analysis.

    Response:
      {
        "datasets": [
          { "dataset_id": "...", "row_count": N, "widget_row_count": N,
            "stored_at": float, "path": "..." },
          ...
        ],
        "in_memory_count": N
      }
    """
    persisted = mesh_store.list_persisted_datasets()
    return jsonify({
        "datasets":        persisted,
        "in_memory_count": len(_datasets),
    })


@app.route("/api/dataset/<dataset_id>/snapshot", methods=["GET"])
def get_dataset_snapshot(dataset_id):
    """
    Return the full raw dataset — from memory or disk.

    This is the endpoint verification scripts and agents use to get the
    complete, unfiltered dataset for independent analysis. Unlike GET /api/actions
    (which filters and sorts), this returns the raw rows exactly as uploaded.

    Response:
      {
        "dataset_id":       "...",
        "row_count":        N,
        "widget_row_count": N,
        "source":           "memory" | "disk",
        "rows":             [...],
        "widget_rows":      [...]
      }
    """
    # Try memory first
    entry = _datasets.get(dataset_id)
    source = "memory"
    if entry is None:
        entry = mesh_store.load_from_disk(dataset_id)
        source = "disk"
    if entry is None:
        return jsonify({
            "error": f"Dataset '{dataset_id}' not found in memory or on disk",
        }), 404

    rows = entry.get("rows", [])
    widget_rows = entry.get("widget_rows", [])

    return jsonify({
        "dataset_id":       dataset_id,
        "row_count":        len(rows),
        "widget_row_count": len(widget_rows),
        "source":           source,
        "rows":             rows,
        "widget_rows":      widget_rows,
    })


# ─── GET /api/health ──────────────────────────────────────────────────────────

@app.route("/api/skills", methods=["GET"])
def skills():
    """Return the list of available skills for the frontend dropdown."""
    return jsonify({"skills": AVAILABLE_SKILLS})


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({
        "status":              "ok",
        "datasets_cached":     len(_datasets),
        "datasets_on_disk":    len(mesh_store.list_persisted_datasets()),
        "sessions_active":     len(mesh_store.sessions),
        "persistence_enabled": mesh_store.DATASET_DIR is not None,
        "dataset_dir":         mesh_store.DATASET_DIR,
    })


# ─── helpers ──────────────────────────────────────────────────────────────────

def _to_int(value: str):
    try:
        return int(value)
    except (ValueError, TypeError):
        return None


# ─── entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Debug (interactive traceback + reloader) is OFF unless explicitly enabled.
    # Leaving it on exposes the Werkzeug debugger and source to anyone hitting
    # the server — never safe for a shared/demo deployment.
    debug = os.getenv("FLASK_DEBUG", "").strip().lower() in ("1", "true", "yes", "on")
    log.info("Starting on port %d (debug=%s)", PORT, debug)
    app.run(host="0.0.0.0", port=PORT, debug=debug)
