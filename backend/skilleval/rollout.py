"""
rollout.py — drive ONE question through the real backend pipeline, in process.

No HTTP server, no HITL gate: it calls orchestrate() directly. Mesh-native
agents (trace) read widget rows from mesh_store, which self-loads the fixed
dataset from backend/datasets/<id>.json — so the only external dependency is a
working LLM key in backend/.env.

CRITICAL: llm.py reads its provider/key/model from os.environ at IMPORT time,
so load_dotenv(backend/.env) MUST run before orchestrate/llm are imported.
"""
from __future__ import annotations
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent          # backend/skilleval
_BACKEND = _HERE.parent                            # backend

# 1) env before imports
from dotenv import load_dotenv
load_dotenv(_BACKEND / ".env")

# 2) make the backend package importable
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

# 3) now safe to import the pipeline (binds LLM env at import)
import orchestrate as _orch   # noqa: E402


def llm_configured() -> bool:
    """True if some LLM route is configured (mirrors llm.call_llm's own checks)."""
    import llm  # noqa: E402
    if llm.LLM_PROVIDER == "anthropic" and llm.LLM_URL and llm.LLM_API_KEY:
        return True
    if llm.OPENAI_API_KEY:
        return True
    import os
    return bool(os.getenv("AI_CORE_URL") and os.getenv("AI_CORE_TOKEN"))


def run_rollout(question: str, payload: dict, dataset_id: str,
                direct_agent: str = "auto") -> dict:
    """
    Run one rollout. STATELESS: no session_id, so reps/paraphrases never share
    conversation history (each is an independent measurement).

    Returns {intent, response_text, agent_outputs, session_notes, error}.
    """
    try:
        result = _orch.orchestrate(
            question=question,
            payload=payload,
            dataset_id=dataset_id,
            direct_agent=direct_agent,
            session_id=None,
        )
        return {
            "intent":        result.get("intent"),
            "response_text": result.get("response_text", ""),
            "agent_outputs": result.get("agent_outputs", {}) or {},
            "session_notes": result.get("session_notes", []) or [],
            "error":         None,
        }
    except Exception as e:  # noqa: BLE001 — a failed rollout is a data point, not a crash
        return {
            "intent": None, "response_text": "", "agent_outputs": {},
            "session_notes": [], "error": f"{type(e).__name__}: {e}",
        }


if __name__ == "__main__":
    import json
    print("LLM configured:", llm_configured())
    payload = json.loads((_HERE / "payload.json").read_text(encoding="utf-8"))
    gt = json.loads((_HERE / "ground_truth.json").read_text(encoding="utf-8"))
    q = sys.argv[1] if len(sys.argv) > 1 else "what's the p90 action duration?"
    out = run_rollout(q, payload, gt["dataset_id"], "auto")
    print("intent:", out["intent"], "| error:", out["error"])
    print("agents:", list(out["agent_outputs"].keys()))
    print("response_text[:400]:", out["response_text"][:400])
