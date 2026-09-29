"""
mesh_store.py — Shared in-memory stores for the mesh backbone.

Extracted from app.py to avoid circular imports between app.py and orchestrate.py.
Both modules import from here instead of from each other.

Stores
------
  datasets        Raw action / widget rows keyed by dataset_id
  agent_outputs   Confirmed agent outputs keyed by dataset_id → agent_name
  sessions        Multi-turn conversation state keyed by session_id

Disk persistence
----------------
  When DATASET_DIR is set (default: backend/datasets/), every dataset is also
  written to disk as a JSON snapshot. If the in-memory cache expires (TTL), the
  read helpers fall back to the on-disk copy. This gives agents and verification
  scripts permanent access to the raw data.

For production scale, replace with Redis or SAP HANA Cloud.
"""

import os
import json
import time
import logging
import threading

log = logging.getLogger(__name__)

# Guards the module-level dicts below. The Flask dev server serves requests on
# multiple threads, so compound read-modify-write sequences (and iteration in
# evict_expired) must be serialized to avoid "dict changed size during
# iteration" errors and lost writes. Reentrant so a locked helper can call
# another locked helper.
_lock = threading.RLock()

# ─── in-memory dataset store ────────────────────────────────────────────────
#
# Keyed by dataset_id (UUID).
# Entry shape: { "rows": [...], "widget_rows": [...], "stored_at": float }

datasets: dict[str, dict] = {}

# ─── in-memory agent output store (mesh backbone) ────────────────────────────
#
# Keyed by dataset_id, then agent_name.
# Entry shape: { "<agent_name>": { "output": {...}, "stored_at": float } }
# Shares TTL with datasets — evicted alongside them.

agent_outputs: dict[str, dict[str, dict]] = {}

# ─── in-memory session store (multi-turn conversation state) ─────────────────
#
# Keyed by session_id (UUID).
# Entry shape:
#   {
#       "session_id":        str,
#       "dataset_id":        str,
#       "question":          str,          # original user question
#       "payload":           dict,         # original payload (for agent inputs)
#       "intent":            str,          # classified intent
#       "current_step":      int,          # index into the step sequence
#       "steps":             list[dict],   # ordered step definitions
#       "completed_agents":  list[str],    # agents that have run
#       "status":            str,          # awaiting_confirmation | complete | error
#       "last_response":     dict | None,  # most recent step response
#       "stored_at":         float,
#   }

sessions: dict[str, dict] = {}

DATASET_TTL_SEC = 3600   # overridden by app.py at startup
SESSION_TTL_SEC = 14400  # 4 hours — sessions live longer than dataset memory TTL
                         # so conversations survive across dataset cache evictions.
                         # Only applies when disk persistence keeps the dataset alive.

# ─── disk persistence ────────────────────────────────────────────────────────
#
# Directory where dataset snapshots are saved. Relative paths are resolved from
# the backend/ directory. Set to None to disable disk persistence entirely.

DATASET_DIR: str = os.path.join(os.path.dirname(os.path.abspath(__file__)), "datasets")


def _ensure_dataset_dir() -> None:
    """Create the snapshots directory if it doesn't exist."""
    if DATASET_DIR:
        os.makedirs(DATASET_DIR, exist_ok=True)


def normalize_rows(rows: list) -> list:
    """Normalize action rows to a canonical field set so every read path agrees.

    The frontend posts each action row with `action_duration` (already in ms)
    and `action_timestamp`, but parts of the backend sort/filter on
    `action_duration_ms` and time code prefers `action_timestamp` /
    `_action_timestamp`. Historically that mismatch meant duration sorts and
    filters silently compared against None. This fills in the aliases in place
    so both spellings always exist. Idempotent — safe to call repeatedly.
    """
    if not isinstance(rows, list):
        return rows
    for r in rows:
        if not isinstance(r, dict):
            continue
        # ── duration alias ──
        if r.get("action_duration_ms") is None:
            dur = r.get("action_duration")
            if isinstance(dur, (int, float)):
                r["action_duration_ms"] = int(round(dur))
        if r.get("action_duration") is None:
            dur_ms = r.get("action_duration_ms")
            if isinstance(dur_ms, (int, float)):
                r["action_duration"] = dur_ms
        # ── timestamp alias ──
        ts = r.get("action_timestamp") or r.get("_action_timestamp")
        if ts:
            if not r.get("action_timestamp"):
                r["action_timestamp"] = ts
            if not r.get("_action_timestamp"):
                r["_action_timestamp"] = ts
    return rows


def persist_to_disk(dataset_id: str, rows: list, widget_rows: list,
                    stored_at: float | None = None) -> str | None:
    """
    Write a dataset snapshot to disk as JSON.

    Returns the snapshot file path on success, None on failure.
    The snapshot is a plain JSON file that any script (Python, Node, etc.)
    can load independently — no server required.
    """
    if not DATASET_DIR:
        return None
    try:
        _ensure_dataset_dir()
        normalize_rows(rows)
        snapshot = {
            "dataset_id":  dataset_id,
            "rows":        rows,
            "widget_rows": widget_rows,
            "stored_at":   stored_at or time.time(),
            "row_count":   len(rows),
            "widget_row_count": len(widget_rows) if isinstance(widget_rows, list) else 0,
        }
        path = os.path.join(DATASET_DIR, f"{dataset_id}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(snapshot, f, ensure_ascii=False)
        log.info("Persisted dataset %s to disk — %s", dataset_id, path)
        return path
    except Exception:
        log.exception("Failed to persist dataset %s to disk", dataset_id)
        return None


def load_from_disk(dataset_id: str) -> dict | None:
    """
    Load a dataset snapshot from disk. Returns the entry dict
    (same shape as the in-memory store: rows, widget_rows, stored_at)
    or None if not found.

    If the snapshot is found on disk it is also re-loaded into the
    in-memory cache so subsequent reads are fast.
    """
    if not DATASET_DIR:
        return None
    path = os.path.join(DATASET_DIR, f"{dataset_id}.json")
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            snapshot = json.load(f)
        entry = {
            "rows":        normalize_rows(snapshot.get("rows", [])),
            "widget_rows": snapshot.get("widget_rows", []),
            "stored_at":   time.time(),  # reset TTL on reload
        }
        # Re-hydrate into the in-memory cache
        with _lock:
            datasets[dataset_id] = entry
        log.info("Reloaded dataset %s from disk into memory", dataset_id)
        return entry
    except Exception:
        log.exception("Failed to load dataset %s from disk", dataset_id)
        return None


def list_persisted_datasets() -> list[dict]:
    """
    List all dataset snapshots on disk.

    Returns a list of { dataset_id, row_count, widget_row_count, stored_at, path }.
    """
    if not DATASET_DIR or not os.path.isdir(DATASET_DIR):
        return []
    result = []
    for fname in os.listdir(DATASET_DIR):
        if not fname.endswith(".json"):
            continue
        path = os.path.join(DATASET_DIR, fname)
        try:
            with open(path, "r", encoding="utf-8") as f:
                snapshot = json.load(f)
            result.append({
                "dataset_id":       snapshot.get("dataset_id", fname.replace(".json", "")),
                "row_count":        snapshot.get("row_count", len(snapshot.get("rows", []))),
                "widget_row_count": snapshot.get("widget_row_count", 0),
                "stored_at":        snapshot.get("stored_at"),
                "path":             path,
            })
        except Exception:
            log.warning("Skipping unreadable snapshot: %s", path)
    result.sort(key=lambda d: d.get("stored_at") or 0, reverse=True)
    return result


def get_dataset(dataset_id: str) -> dict | None:
    """
    Get a dataset by ID — checks in-memory first, falls back to disk.

    This is the single entry point all read paths should use instead of
    accessing the _datasets dict directly, so the disk fallback is automatic.
    """
    _evict_if_needed()
    entry = datasets.get(dataset_id)
    if entry is not None:
        return entry
    # Not in memory — try disk
    return load_from_disk(dataset_id)


def _evict_if_needed():
    """Thin wrapper so get_dataset can trigger eviction without a circular call."""
    evict_expired()


def _dataset_recoverable(dataset_id: str) -> bool:
    """Check if a dataset exists on disk (without loading it into memory).

    Used by evict_expired to avoid killing sessions whose dataset
    is still recoverable from disk even after the in-memory TTL expires.
    """
    if not dataset_id or not DATASET_DIR:
        return False
    return os.path.isfile(os.path.join(DATASET_DIR, f"{dataset_id}.json"))


def evict_expired() -> None:
    """Remove expired datasets from memory and their agent outputs.

    Sessions are only evicted when their dataset is BOTH gone from memory
    AND not recoverable from disk. This preserves conversation history
    across TTL boundaries when disk persistence is enabled — the next
    agent call via get_dataset() will transparently reload the data.
    """
    now = time.time()
    with _lock:
        expired = [k for k, v in datasets.items() if now - v["stored_at"] > DATASET_TTL_SEC]
        for k in expired:
            del datasets[k]
            agent_outputs.pop(k, None)
            log.info("Evicted dataset %s from memory (TTL expired)", k)

        # Evict sessions in two passes:
        #
        # Pass 1 — Sessions whose dataset is truly gone (not in memory AND
        # not recoverable from disk). These have no data to work with.
        #
        # Pass 2 — Sessions that exceed their own TTL regardless of dataset
        # availability. Prevents unbounded session growth when disk persistence
        # keeps datasets alive indefinitely.
        orphaned = [
            sid for sid, s in sessions.items()
            if s.get("dataset_id") not in datasets
            and not _dataset_recoverable(s.get("dataset_id"))
        ]
        stale = [
            sid for sid, s in sessions.items()
            if sid not in orphaned  # don't double-count
            and now - s.get("stored_at", 0) > SESSION_TTL_SEC
        ]
        for sid in orphaned:
            del sessions[sid]
            log.info("Evicted session %s (dataset gone from memory and disk)", sid)
        for sid in stale:
            del sessions[sid]
            log.info("Evicted session %s (session TTL %ds expired)", sid, SESSION_TTL_SEC)


def store_agent_output(dataset_id: str, agent_name: str, output: dict) -> None:
    """Write an agent's confirmed output to the shared mesh store."""
    if not dataset_id:
        return
    with _lock:
        if dataset_id not in agent_outputs:
            agent_outputs[dataset_id] = {}
        agent_outputs[dataset_id][agent_name] = {
            "output":    output,
            "stored_at": time.time(),
        }
    log.info("Mesh store: wrote %s output for dataset %s", agent_name, dataset_id)


def read_agent_output(dataset_id: str, agent_name: str) -> dict | None:
    """Read another agent's output from the mesh store. Returns None if not found."""
    if not dataset_id:
        return None
    entry = agent_outputs.get(dataset_id, {}).get(agent_name)
    return entry["output"] if entry else None


def agent_outputs_by_recency(dataset_id: str, agent_names=None) -> list[tuple[str, dict]]:
    """
    Return [(agent_name, output), ...] sorted most-recently-stored first.

    Selection is by the stored_at write timestamp — the ACTUAL turn order —
    not by any caller-supplied ordering. Follow-up reference resolution relies
    on this so "why is that?" resolves against the latest turn's output rather
    than whichever agent happens to sort first in a fixed priority list.

    Restrict to specific agents by passing agent_names (any iterable of names);
    pass None to consider every stored agent. Returns [] when nothing is stored.
    """
    if not dataset_id:
        return []
    allow = set(agent_names) if agent_names is not None else None
    with _lock:
        items = [
            (name, entry)
            for name, entry in agent_outputs.get(dataset_id, {}).items()
            if allow is None or name in allow
        ]
    items.sort(key=lambda ne: ne[1].get("stored_at", 0), reverse=True)
    return [(name, entry["output"]) for name, entry in items]


# ─── session helpers ─────────────────────────────────────────────────────────

def create_session(session_id: str, dataset_id: str, question: str,
                   payload: dict, intent: str, steps: list) -> dict:
    """Create a new multi-turn session and store it."""
    session = {
        "session_id":           session_id,
        "dataset_id":           dataset_id,
        "question":             question,
        "payload":              payload,
        "intent":               intent,
        "current_step":         0,
        "steps":                steps,
        "completed_agents":     [],
        "status":               "active",
        "last_response":        None,
        "conversation_history": [],   # list of {role, content, agent, intent, turn}
        "stored_at":            time.time(),
    }
    sessions[session_id] = session
    log.info("Session created: %s (intent=%s, %d steps)", session_id, intent, len(steps))
    return session


def get_session(session_id: str) -> dict | None:
    """Retrieve a session by ID. Returns None if not found."""
    return sessions.get(session_id)


def update_session(session_id: str, **updates) -> dict | None:
    """Update fields on an existing session. Returns the updated session."""
    with _lock:
        session = sessions.get(session_id)
        if session is None:
            return None
        session.update(updates)
        session["stored_at"] = time.time()
        return session


def list_completed_agents(dataset_id: str) -> list[str]:
    """Return agent names that have stored output for this dataset."""
    return list(agent_outputs.get(dataset_id, {}).keys())


# ─── conversation history helpers ────────────────────────────────────────────


def append_to_history(session_id: str, role: str, content: str,
                      agent: str = None, intent: str = None) -> None:
    """
    Append one message to a session's conversation history.

    role    — "user" or "assistant"
    content — the text of the message (question or response_text)
    agent   — optional agent key that produced this message
    intent  — optional intent that was classified for this turn
    """
    session = sessions.get(session_id)
    if session is None:
        return
    with _lock:
        history = session.setdefault("conversation_history", [])
        # Turn number = completed user+assistant pairs so far
        turn = (len(history) // 2) + 1
        history.append({
            "role":    role,
            "content": content,
            "agent":   agent,
            "intent":  intent,
            "turn":    turn,
        })
    log.debug("Session %s: appended %s message (turn %d)", session_id, role, turn)


def get_llm_history(session_id: str) -> list:
    """
    Return the conversation history for a session in LLM-compatible format:
    [ {role: "user"|"assistant", content: str}, ... ]

    The metadata fields (agent, intent, turn) are stripped — only the role
    and content fields that the LLM API expects are returned.
    """
    session = sessions.get(session_id)
    if not session:
        return []
    return [
        {"role": h["role"], "content": h["content"]}
        for h in session.get("conversation_history", [])
    ]


def get_turn_count(session_id: str) -> int:
    """Return the number of completed question→answer turns in this session."""
    session = sessions.get(session_id)
    if not session:
        return 0
    return len(session.get("conversation_history", [])) // 2
