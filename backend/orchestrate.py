"""
orchestrate.py — Multi-agent orchestration loop
=================================================

Entry point: orchestrate(question, payload, dataset_id) -> dict

Flow
----
  classify_intent()              Orchestrator prompt → intent string
  route by intent                call the right agent(s)
  store outputs to mesh          each agent's output goes to the shared store
  collect outputs                structured JSON from each agent
  return final response          { response_text, agent_outputs, intent, ... }

Mesh pattern: agents write confirmed outputs to the shared store
(app.py's _agent_outputs dict). Other agents can read from the store
to get context without Orchestrator hand-assembly.

Each agent is one LLM call:
  system  = contents of backend/prompts/<agent>.txt
  user    = relevant payload slice as JSON + the question

FULL_ANALYSIS runs Stats Agent and Anomaly Agent concurrently
using concurrent.futures.ThreadPoolExecutor.

All agents run in PIPELINE MODE — they return CONFIRMED / COMPLETE
without human-in-the-loop checkpoints.

NOTE: _fetch_detail_rows() makes an internal call to GET /api/actions.
The network stub must be completed in VS Code — see README.md.
"""

import json
import logging
import os
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from llm import call_llm, extract_json_from_response
from skills import get_skill

log = logging.getLogger(__name__)

BACKEND_HOST = os.getenv("BACKEND_HOST", "localhost")
BACKEND_PORT = int(os.getenv("BACKEND_PORT", "5000"))


# ─── mesh store helpers ──────────────────────────────────────────────────────
#
# Imported from mesh_store.py — the shared module both app.py and orchestrate.py
# use, avoiding a circular import. In production these would be HTTP calls.

from mesh_store import store_agent_output, read_agent_output
import mesh_store as _mesh


# ─── HITL intent plan catalogue ──────────────────────────────────────────────
#
# One entry per intent. Shown to the user before any agent runs so they can
# confirm or reject the proposed action. estimated_llm_calls is informational.

_INTENT_PLANS: dict = {
    "FULL_ANALYSIS": {
        "description": "Full pipeline — KPI stats + anomaly detection in parallel, then a Narrator synthesis",
        "steps": [
            {
                "step": 1,
                "agents": ["Stats Agent", "Anomaly Agent"],
                "description": "Compute KPI percentiles and detect active anomaly types (2 LLM calls, run in parallel)",
            },
            {
                "step": 2,
                "agents": ["Narrator"],
                "description": "Synthesise KPI + anomaly findings into a headline summary (1 LLM call)",
            },
        ],
        "estimated_llm_calls": 3,
    },
    "KPI_SUMMARY": {
        "description": "KPI and latency statistics",
        "steps": [
            {
                "step": 1,
                "agents": ["Stats Agent"],
                "description": "Report total actions, threshold breaches, and duration percentiles (1 LLM call)",
            },
        ],
        "estimated_llm_calls": 1,
    },
    "ANOMALY_SUMMARY": {
        "description": "Anomaly type detection and flagging",
        "steps": [
            {
                "step": 1,
                "agents": ["Anomaly Agent"],
                "description": "Identify which anomaly types are active and how many actions were flagged per type (1 LLM call)",
            },
        ],
        "estimated_llm_calls": 1,
    },
    "ROOT_CAUSE_ANALYSIS": {
        "description": "Root cause analysis of active anomaly types",
        "steps": [
            {
                "step": 1,
                "agents": ["Anomaly Agent"],
                "description": "Detect active anomaly types (1 LLM call)",
            },
            {
                "step": 2,
                "agents": ["Root Cause Agent"],
                "description": "Explain why each type occurs and surface specific actions and users involved (1 LLM call)",
            },
        ],
        "estimated_llm_calls": 2,
    },
    "DATA_EXPLORATION": {
        "description": "Full-dataset frequency rankings and row-level exploration",
        "steps": [
            {
                "step": 1,
                "agents": ["Explorer Agent"],
                "description": "Rank users, stories, and actions by frequency; fetch row-level detail for named entities (1 LLM call)",
            },
        ],
        "estimated_llm_calls": 1,
    },
    "WIDGET_TRACE": {
        "description": "Widget-level timing trace for the slowest actions",
        "steps": [
            {
                "step": 1,
                "agents": ["Trace Agent"],
                "description": "Identify the bottleneck widget, break down render/network/backend phases, and check loading patterns (1 LLM call)",
            },
        ],
        "estimated_llm_calls": 1,
    },
    "CONVERSATIONAL": {
        "description": "Conversational answer using session context",
        "steps": [
            {
                "step": 1,
                "agents": ["Conversational"],
                "description": "Answer the follow-up question by synthesising prior findings from this session (1 LLM call)",
            },
        ],
        "estimated_llm_calls": 1,
    },
}


def _build_plan(intent: str) -> dict:
    """Return a copy of the execution plan for the given intent."""
    return dict(_INTENT_PLANS.get(intent, _INTENT_PLANS["FULL_ANALYSIS"]))


# ─── Post-response next-step suggestions ──────────────────────────────────────
#
# Shown after every completed turn. Each entry is a list of
# { "label": str, "question": str } objects the frontend renders as
# clickable chips. Clicking one auto-submits the question through
# the HITL plan flow (plan → confirm → result).

_INTENT_NEXT_STEPS: dict = {
    "FULL_ANALYSIS": [
        {"label": "Explain root causes",        "question": "What is causing the performance issues?"},
        {"label": "Explore top users",           "question": "Show me the top users with the most flagged actions"},
        {"label": "Trace widget timings",        "question": "Which widget was the bottleneck for the slowest actions?"},
    ],
    "ANOMALY_SUMMARY": [
        {"label": "Get root causes",             "question": "What is causing these anomalies?"},
        {"label": "Run full analysis",           "question": "Give me a full performance summary"},
        {"label": "Explore top users",           "question": "Show me the users with the most flagged actions"},
    ],
    "ROOT_CAUSE_ANALYSIS": [
        {"label": "Explore affected users",      "question": "Show me the top users with the most flagged actions"},
        {"label": "Trace widget timings",        "question": "Which widget was the bottleneck for the slowest actions?"},
        {"label": "View KPI statistics",         "question": "Show me the KPI and latency statistics"},
    ],
    "KPI_SUMMARY": [
        {"label": "Detect anomalies",            "question": "What anomalies were detected in this dataset?"},
        {"label": "Run full analysis",           "question": "Give me a full performance summary"},
        {"label": "Find root causes",            "question": "What is causing the performance issues?"},
    ],
    "DATA_EXPLORATION": [
        {"label": "Investigate root causes",     "question": "What is causing the performance issues?"},
        {"label": "Trace widget timings",        "question": "Which widget was the bottleneck for the slowest actions?"},
        {"label": "View anomaly summary",        "question": "What anomalies were detected in this dataset?"},
    ],
    "WIDGET_TRACE": [
        {"label": "Get root causes",             "question": "What is causing these performance issues?"},
        {"label": "Explore affected users",      "question": "Show me the top users with the most flagged actions"},
        {"label": "Run full analysis",           "question": "Give me a full performance summary"},
    ],
    "CONVERSATIONAL": [
        {"label": "Run full analysis",           "question": "Give me a full performance summary"},
        {"label": "Explore top users",           "question": "Show me the users with the most flagged actions"},
        {"label": "Check anomalies",             "question": "What anomalies were detected in this dataset?"},
    ],
}


def _get_next_steps(intent: str) -> list:
    """Return the next-step suggestions for the given intent."""
    return _INTENT_NEXT_STEPS.get(intent, [])


# ─── conversational system prompt ─────────────────────────────────────────────
#
# Used when intent == CONVERSATIONAL and a session exists. The LLM is given
# the full conversation history and answers the user's follow-up directly.

_CONVERSATIONAL_SYSTEM = """\
You are a performance-data analysis assistant for COE Datasphere.
The user is asking a follow-up question in an ongoing analysis session.
Use the conversation history to understand prior findings and answer accurately.
Be concise and data-focused. Do not repeat prior answers — build on them.
If the question asks for a summary, synthesise all prior findings into one clear response.

The DATA CONTEXT below may include:
  - Quick Insights, Busiest Periods, Rankings, and Session Summary (pre-computed rollups).
  - "On-demand breakdown" — a table computed directly from the FULL dataset when the
    question named a concrete drilldown (a user, story, action, session, date, or hour)
    or asked for a by-hour / by-day / per-user breakdown. This carries real per-group
    counts and duration statistics (median, p90, max, total, count over threshold).
When an on-demand breakdown is present, ANSWER FROM IT with the actual numbers —
you DO have hour-by-hour and per-entity detail there. Never claim the data is
unavailable when a breakdown table is provided.
"""


# ─── HITL Phase 1: plan (classify, no agents run) ────────────────────────────

def _resolve_followup_references(question: str, dataset_id) -> str:
    """
    Enrich the question with context from the most recent agent output so that
    ANY follow-up — "rank 2", "that user", "explore more", "tell me about it",
    or just a short ambiguous phrase — can be understood by downstream agents.

    Two mechanisms (both zero LLM cost — pure dict lookup + regex):

    1. Explicit rank references ("rank 1", "#2", "the second user")
       → resolved to actual entity names inline.

    2. Session context injection — whenever previous results exist, a compact
       context tag is prepended so agents can interpret pronouns ("that",
       "it", "those"), implicit references ("explore more", "drill deeper"),
       and entity names that appeared in the previous output.
    """
    import re
    import mesh_store as _ms

    if not dataset_id:
        return question

    q_lower = question.lower()

    # ── Find the most recent agent output with top_results ───────────────────
    # Ordered by stored_at (actual turn order), not a fixed priority list, so a
    # follow-up resolves against the latest turn — a fresh root-cause output
    # wins over a stale explorer output rather than the reverse.
    prev_output   = None
    prev_agent    = None
    for agent_name, prev in _ms.agent_outputs_by_recency(
        dataset_id,
        ("explorer-agent", "root-cause-agent", "anomaly-agent",
         "stats-agent", "trace-agent"),
    ):
        if prev and (prev.get("top_results") or prev.get("question_answered")):
            prev_output = prev
            prev_agent  = agent_name
            break

    if not prev_output:
        return question

    top_results = prev_output.get("top_results", [])

    # ── Mechanism 1: Explicit rank resolution ────────────────────────────────
    rank_num = None

    m = re.search(r'\brank\s*#?\s*(\d+)\b', q_lower)
    if m:
        rank_num = int(m.group(1))

    if rank_num is None:
        m = re.search(r'#(\d+)\s*(?:user|action|story|entity)?\b', q_lower)
        if m:
            rank_num = int(m.group(1))

    if rank_num is None:
        if re.search(r'\bthe\s+(?:top|first|#?1(?:st)?)\s+(?:action|user|story)\b', q_lower):
            rank_num = 1

    _ordinals = {"second": 2, "third": 3, "fourth": 4, "fifth": 5}
    if rank_num is None:
        for word, num in _ordinals.items():
            if re.search(rf'\bthe\s+{word}\s+(?:action|user|story|one)\b', q_lower):
                rank_num = num
                break

    if rank_num is not None and top_results:
        for result in top_results:
            if result.get("rank") == rank_num:
                etype  = result.get("entity_type", "entity")
                evalue = result.get("entity_value", "")
                ecount = result.get("flagged_count") or result.get("action_count")
                if evalue:
                    count_note = f", {ecount} flagged" if ecount else ""
                    resolved_tag = f"{etype} '{evalue}' (rank {rank_num}{count_note})"
                    replaced = re.sub(
                        r'\brank\s*#?\s*\d+\s*(?:of\s+the\s+)?\s*(?:\d+\s+)?(?:flagged\s+)?(?:action|user|story|entity)?s?',
                        resolved_tag, question, count=1, flags=re.IGNORECASE,
                    )
                    if replaced != question:
                        log.info("Reference resolved: rank %d → %s '%s'",
                                 rank_num, etype, evalue)
                        return replaced
                    return f"[Context: rank {rank_num} = {resolved_tag}] {question}"

    # ── Mechanism 2: Session context injection ───────────────────────────────
    # Detect follow-up signals: pronouns, implicit references, or short queries
    # that clearly build on the previous turn.
    _followup_signals = re.search(
        r'\b(?:that|those|them|it|this|these|same|previous|prior|above|earlier'
        r'|more|further|deeper|again|also|too|continue|follow.?up'
        r'|explore|drill|expand|elaborate|detail|explain)\b',
        q_lower,
    )
    _is_short_query = len(question.split()) <= 8

    if _followup_signals or _is_short_query:
        # Build a compact context tag from the previous output
        prev_q = prev_output.get("question_answered") or "prior analysis"
        brief_parts = []
        for r in top_results[:5]:
            ev = r.get("entity_value")
            et = r.get("entity_type", "")
            rk = r.get("rank", "")
            if ev:
                brief_parts.append(f"#{rk} {et} '{ev}'")
        brief = ", ".join(brief_parts) if brief_parts else "see prior output"
        context_tag = f"[Previous: {prev_q} → {brief}]"
        log.info("Session context injected: %s", context_tag[:120])
        return f"{context_tag} {question}"

    return question


def plan_turn(question: str, payload: dict, dataset_id=None,
              session_id: str = None, direct_agent: str = None) -> dict:
    """
    Phase 1 of the human-in-the-loop flow.

    Classifies the intent and builds an execution plan, but does NOT run any
    agents. Returns the plan for the user to review. The caller should then
    call orchestrate() (Phase 2) only after the user confirms.

    Stores the pending question and agent key in the session so the confirm
    endpoint can execute without the client re-sending the full payload.

    Returns:
      {
        "status":          "awaiting_confirmation",
        "session_id":      str | None,
        "intent":          str,
        "acknowledgement": str,
        "plan": {
          "description":        str,
          "steps":              [ {step, agents, description}, ... ],
          "estimated_llm_calls": int
        },
        "turn": int
      }
    """
    # ── Resolve follow-up references before any routing ──────────────────────
    question = _resolve_followup_references(question, dataset_id)

    log.info("Planning turn: %s (direct_agent=%s, session=%s)",
             question[:100], direct_agent, session_id)

    llm_history = _mesh.get_llm_history(session_id) if session_id else []
    turn        = _mesh.get_turn_count(session_id) + 1 if session_id else 1

    # Determine intent — either from the direct_agent override or the classifier
    if direct_agent and direct_agent != "auto":
        intent = _DIRECT_AGENT_INTENT_MAP.get(direct_agent, "FULL_ANALYSIS")
        ack    = f"Running {direct_agent.replace('_', ' ').title()} directly."
    else:
        intent_result = classify_intent(question, payload, llm_history=llm_history)
        intent = intent_result.get("intent", "FULL_ANALYSIS")
        ack    = intent_result.get("acknowledgement", "Analysing your dataset...")

    plan = _build_plan(intent)

    # Persist pending state so the confirm endpoint has everything it needs.
    # pending_intent / pending_ack are stored so orchestrate() can skip
    # re-classifying the same question — eliminating one wasted LLM call.
    if session_id:
        _mesh.update_session(
            session_id,
            intent               = intent,
            steps                = plan["steps"],
            status               = "awaiting_confirmation",
            pending_question     = question,
            pending_direct_agent = direct_agent or "auto",
            pending_intent       = intent,   # ← consumed by orchestrate() on confirm
            pending_ack          = ack,      # ← consumed by orchestrate() on confirm
        )

    log.info("Plan ready — intent=%s  steps=%d  est_calls=%d",
             intent, len(plan["steps"]), plan["estimated_llm_calls"])

    return {
        "status":          "awaiting_confirmation",
        "session_id":      session_id,
        "intent":          intent,
        "acknowledgement": ack,
        "plan":            plan,
        "turn":            turn,
    }


# ─── HITL Phase 2: execute (runs agents, called after confirmation) ───────────

def orchestrate(question: str, payload: dict, dataset_id=None,
                direct_agent: str = None, session_id: str = None) -> dict:
    """
    Run the multi-agent pipeline for a user question.

    direct_agent — optional skill key (from skills.AVAILABLE_SKILLS).
      When set, skip intent classification and call that agent directly.
      Pass "auto" or None to let the Orchestrator classify the intent.

    session_id — optional session ID from mesh_store.sessions.
      When set, prior conversation history is loaded and passed to the
      intent classifier (for accurate follow-up routing) and the
      CONVERSATIONAL agent (for context-aware answers).
      Each turn's question and response_text are appended back to the
      session history so the next turn has full context.

    Returns:
      {
        "intent":          str,
        "acknowledgement": str,
        "response_text":   str,
        "agent_outputs":   dict,
        "session_notes":   list,
        "dataset_id":      str | None,
        "session_id":      str | None,
        "turn":            int
      }
    """
    # ── HITL check: if plan_turn already resolved references, don't re-resolve ─
    # In the HITL flow, plan_turn() already called _resolve_followup_references()
    # and stored the enriched question as pending_question. The confirm endpoint
    # reads it and passes it here. Re-resolving would double-inject context tags
    # (e.g. "[Previous: ...] [Previous: ...] show me rank 2"), corrupting the
    # question string for every downstream agent.
    #
    # We detect the HITL-confirm path by checking for pending_intent — if it
    # exists, plan_turn already ran and the question is already resolved.
    # The non-HITL path (POST /api/chat) has no session, so resolution runs once.
    _pending_intent = None
    _pending_ack    = None
    _from_plan_turn = False
    if session_id:
        _s = _mesh.get_session(session_id)
        if _s:
            _pending_intent = _s.get("pending_intent")
            _pending_ack    = _s.get("pending_ack")
            if _pending_intent:
                _from_plan_turn = True
                # Clear the pending fields now that we're consuming them
                _mesh.update_session(session_id, pending_intent=None, pending_ack=None)

    if not _from_plan_turn:
        # Only resolve references when NOT coming from plan_turn (which already did)
        question = _resolve_followup_references(question, dataset_id)

    log.info("Orchestrating: %s (direct_agent=%s, session=%s, from_plan=%s)",
             question[:100], direct_agent, session_id, _from_plan_turn)

    # ── Load conversation history from the session ─────────────────────────────
    llm_history = _mesh.get_llm_history(session_id) if session_id else []
    turn        = _mesh.get_turn_count(session_id) + 1 if session_id else 1

    # ── Direct agent mode: skip intent classification ──────────────────────────
    if direct_agent and direct_agent != "auto":
        result = _run_direct_agent(question, payload, dataset_id, direct_agent,
                                   session_id=session_id, llm_history=llm_history)
        _save_turn(session_id, question, result.get("response_text", ""),
                   agent=direct_agent, intent=result.get("intent", ""))
        result["session_id"] = session_id
        result["turn"]       = turn
        return result

    # ── Intent classification — reuse plan_turn result when available ──────────
    # In the HITL flow, plan_turn already classified the intent and stored it in
    # the session as pending_intent. Reusing it skips one full LLM call per turn.

    if _pending_intent:
        intent = _pending_intent
        ack    = _pending_ack or "Analysing your dataset..."
        log.info("Intent reused from plan_turn: %s (classify_intent skipped)", intent)
    else:
        intent_result = classify_intent(question, payload, llm_history=llm_history)
        intent        = intent_result.get("intent", "FULL_ANALYSIS")
        ack           = intent_result.get("acknowledgement", "Analysing your dataset...")

    log.info("Intent: %s", intent)

    agent_outputs  = {}
    response_parts = [ack, ""]
    session_notes  = []

    if intent == "KPI_SUMMARY":
        out = run_stats_agent(payload.get("kpis", []), question, payload.get("meta", {}))
        agent_outputs["stats"] = out
        response_parts.append(out.get("_response_text", ""))
        session_notes.extend(out.get("session_notes", []))
        _guard_store(dataset_id, "stats-agent", out)

    elif intent == "ANOMALY_SUMMARY":
        out = run_anomaly_agent(payload.get("anomalies", {}), question)
        agent_outputs["anomaly"] = out
        response_parts.append(out.get("_response_text", ""))
        session_notes.extend(out.get("session_notes", []))
        _guard_store(dataset_id, "anomaly-agent", out)

    elif intent == "ROOT_CAUSE_ANALYSIS":
        anomaly_out = run_anomaly_agent(payload.get("anomalies", {}), question)
        agent_outputs["anomaly"] = anomaly_out
        _guard_store(dataset_id, "anomaly-agent", anomaly_out)
        # Phase 3 mesh pattern: Root Cause reads anomaly output from store
        # (store_agent_output was called above after anomaly agent ran)
        # Cap flagged_actions to the 50 slowest — the agent needs representative
        # examples, not all 300+ rows. flagged_by_type is also slimmed: only the
        # first 10 actions per type (enough for pattern identification).
        _all_flagged   = payload.get("anomalies", {}).get("flagged_actions", [])
        _flagged_by_t  = payload.get("anomalies", {}).get("flagged_by_type", {})
        _top_flagged   = _sorted_flagged(_all_flagged)[:50]

        rc_input = {
            "active_headline_types": anomaly_out.get("active_headline_types", []),
            "active_phase_types":    anomaly_out.get("active_phase_types",    []),
            "total_flagged":         anomaly_out.get("total_flagged",         {}),
            "total_actions":         anomaly_out.get("total_actions",          0),
            "flagged_by_type":       _flagged_by_t,   # full — runner slims for the LLM
            "flagged_actions":       _top_flagged,    # top 50 by duration
            # Mesh enrichment: other agents' outputs (if available from prior runs)
            "trace_output":          read_agent_output(dataset_id, "trace-agent"),
            "explorer_context":      _get_explorer_context(dataset_id),
        }
        rc_out = run_root_cause_agent(rc_input, question)
        agent_outputs["root_cause"] = rc_out
        response_parts.append(rc_out.get("_response_text", ""))
        session_notes.extend(rc_out.get("session_notes", []))
        _guard_store(dataset_id, "root-cause-agent", rc_out)

    elif intent == "DATA_EXPLORATION":
        explorer_input = _build_explorer_input(question, payload, dataset_id,
                                               llm_history=llm_history)
        out = run_explorer_agent(explorer_input)
        agent_outputs["explorer"] = out
        response_parts.append(out.get("_response_text", ""))
        session_notes.extend(out.get("session_notes", []))
        _guard_store(dataset_id, "explorer-agent", out)

    elif intent == "FULL_ANALYSIS":
        stats_out, anomaly_out = _run_parallel(
            payload.get("kpis", []),
            payload.get("anomalies", {}),
            question,
            payload.get("meta", {}),
        )
        agent_outputs["stats"]   = stats_out
        agent_outputs["anomaly"] = anomaly_out
        session_notes.extend(stats_out.get("session_notes",   []))
        session_notes.extend(anomaly_out.get("session_notes", []))
        _guard_store(dataset_id, "stats-agent", stats_out)
        _guard_store(dataset_id, "anomaly-agent", anomaly_out)

        flagged = _sorted_flagged(payload.get("anomalies", {}).get("flagged_actions", []))
        narrator_input = {
            "stats":              stats_out,
            "anomalies":          anomaly_out,
            "meta":               payload.get("meta", {}),
            "top_flagged_action": flagged[0] if flagged else None,
            # Phase 4 mesh: include any trace findings if available
            "trace_output":       read_agent_output(dataset_id, "trace-agent"),
        }
        narrator_out = run_narrator(narrator_input, question)
        agent_outputs["narrator"] = narrator_out
        response_parts.append(narrator_out.get("_response_text", ""))
        session_notes.extend(narrator_out.get("session_notes", []))
        _guard_store(dataset_id, "narrator", narrator_out)

    elif intent == "WIDGET_TRACE":
        # Mesh-native: trace agent reads from store + API, not hand-assembled packages
        trace_input = _build_trace_input(question, payload, dataset_id)
        out = run_trace_agent(trace_input)
        agent_outputs["trace"] = out
        response_parts.append(out.get("_response_text", ""))
        session_notes.extend(out.get("session_notes", []))
        # Phase 2: store output for mesh consumption
        _guard_store(dataset_id, "trace-agent", out)

    elif intent == "CONVERSATIONAL":
        response_parts.append(
            _conversational_answer(question, payload, llm_history=llm_history,
                                   dataset_id=dataset_id)
        )

    else:
        # Unknown intent — fall back to the cheapest single-call path (one LLM
        # call) rather than the 4-call FULL_ANALYSIS pipeline.
        log.warning("Unknown intent '%s' — falling back to ANOMALY_SUMMARY (1 call)", intent)
        out = run_anomaly_agent(payload.get("anomalies", {}), question)
        agent_outputs["anomaly"] = out
        response_parts.append(out.get("_response_text", ""))
        session_notes.extend(out.get("session_notes", []))
        intent = "ANOMALY_SUMMARY"

    final_response = "\n".join(p for p in response_parts if p)

    log.info("CHART-DEBUG orchestrate: intent=%s fence_in_final=%s len=%d",
             intent, _CHART_FENCE in final_response, len(final_response))

    # ── Persist this turn to the session ──────────────────────────────────────
    _save_turn(session_id, question, final_response, agent="orchestrator", intent=intent)
    if session_id:
        _mesh.update_session(
            session_id,
            intent=intent,
            completed_agents=list(agent_outputs.keys()),
            last_response={"intent": intent, "response_text": final_response},
        )

    return {
        "intent":          intent,
        "acknowledgement": ack,
        "response_text":   final_response,
        "agent_outputs":   agent_outputs,
        "session_notes":   session_notes,
        "dataset_id":      dataset_id,
        "session_id":      session_id,
        "turn":            turn,
        "next_steps":      _get_next_steps(intent),
    }


# ─── direct agent dispatch ────────────────────────────────────────────────────

_DIRECT_AGENT_INTENT_MAP = {
    "stats_agent":      "KPI_SUMMARY",
    "anomaly_agent":    "ANOMALY_SUMMARY",
    "root_cause_agent": "ROOT_CAUSE_ANALYSIS",
    "explorer_agent":   "DATA_EXPLORATION",
    "trace_agent":      "WIDGET_TRACE",
    "narrator":         "FULL_ANALYSIS",
}


def _run_direct_agent(question: str, payload: dict, dataset_id, agent_key: str,
                      session_id: str = None, llm_history: list = None) -> dict:
    """Call a specific agent directly, bypassing intent classification."""
    intent = _DIRECT_AGENT_INTENT_MAP.get(agent_key, "FULL_ANALYSIS")
    log.info("Direct dispatch to %s (intent: %s)", agent_key, intent)

    agent_outputs = {}
    session_notes = []
    response_text = ""

    if agent_key == "stats_agent":
        out = run_stats_agent(payload.get("kpis", []), question, payload.get("meta", {}))
        agent_outputs["stats"] = out
        response_text = out.get("_response_text", "")
        session_notes.extend(out.get("session_notes", []))
        _guard_store(dataset_id, "stats-agent", out)

    elif agent_key == "anomaly_agent":
        out = run_anomaly_agent(payload.get("anomalies", {}), question)
        agent_outputs["anomaly"] = out
        response_text = out.get("_response_text", "")
        session_notes.extend(out.get("session_notes", []))
        _guard_store(dataset_id, "anomaly-agent", out)

    elif agent_key == "root_cause_agent":
        anomaly_out = run_anomaly_agent(payload.get("anomalies", {}), question)
        agent_outputs["anomaly"] = anomaly_out
        _guard_store(dataset_id, "anomaly-agent", anomaly_out)
        _all_flagged = payload.get("anomalies", {}).get("flagged_actions", [])
        _flagged_by_t = payload.get("anomalies", {}).get("flagged_by_type", {})
        rc_input = {
            "active_headline_types": anomaly_out.get("active_headline_types", []),
            "active_phase_types":    anomaly_out.get("active_phase_types",    []),
            "total_flagged":         anomaly_out.get("total_flagged",         {}),
            "total_actions":         anomaly_out.get("total_actions",          0),
            "flagged_by_type":       _flagged_by_t,   # full — runner slims for the LLM
            "flagged_actions":       sorted(_all_flagged, key=lambda a: a.get("action_duration_ms") or 0, reverse=True)[:50],
            # Mesh enrichment: other agents' outputs from prior runs
            "trace_output":          read_agent_output(dataset_id, "trace-agent"),
            "explorer_context":      _get_explorer_context(dataset_id),
        }
        out = run_root_cause_agent(rc_input, question)
        agent_outputs["root_cause"] = out
        response_text = out.get("_response_text", "")
        session_notes.extend(out.get("session_notes", []))
        _guard_store(dataset_id, "root-cause-agent", out)

    elif agent_key == "explorer_agent":
        explorer_input = _build_explorer_input(question, payload, dataset_id,
                                               llm_history=llm_history)
        out = run_explorer_agent(explorer_input)
        agent_outputs["explorer"] = out
        response_text = out.get("_response_text", "")
        session_notes.extend(out.get("session_notes", []))
        _guard_store(dataset_id, "explorer-agent", out)

    elif agent_key == "trace_agent":
        trace_input = _build_trace_input(question, payload, dataset_id)
        out = run_trace_agent(trace_input)
        agent_outputs["trace"] = out
        response_text = out.get("_response_text", "")
        session_notes.extend(out.get("session_notes", []))
        _guard_store(dataset_id, "trace-agent", out)

    elif agent_key == "narrator":
        stats_out, anomaly_out = _run_parallel(
            payload.get("kpis", []),
            payload.get("anomalies", {}),
            question,
            payload.get("meta", {}),
        )
        agent_outputs["stats"]   = stats_out
        agent_outputs["anomaly"] = anomaly_out
        _guard_store(dataset_id, "stats-agent",   stats_out)
        _guard_store(dataset_id, "anomaly-agent", anomaly_out)
        flagged = _sorted_flagged(payload.get("anomalies", {}).get("flagged_actions", []))
        narrator_input = {
            "stats":              stats_out,
            "anomalies":          anomaly_out,
            "meta":               payload.get("meta", {}),
            "top_flagged_action": flagged[0] if flagged else None,
            # Mesh enrichment: trace findings if available from a prior run
            "trace_output":       read_agent_output(dataset_id, "trace-agent"),
        }
        out = run_narrator(narrator_input, question)
        agent_outputs["narrator"] = out
        response_text = out.get("_response_text", "")
        session_notes.extend(out.get("session_notes", []))
        _guard_store(dataset_id, "narrator", out)

    return {
        "intent":          intent,
        "acknowledgement": f"Running {agent_key.replace('_', ' ').title()} directly...",
        "response_text":   response_text,
        "agent_outputs":   agent_outputs,
        "session_notes":   session_notes,
        "dataset_id":      dataset_id,
        "direct_agent":    agent_key,
        "session_id":      session_id,
        "next_steps":      _get_next_steps(intent),
    }


# ─── intent classification ────────────────────────────────────────────────────

def classify_intent(question: str, payload: dict, llm_history: list = None) -> dict:
    """
    Classify the user's question into an intent string.

    llm_history — optional prior conversation turns ({role, content} list).
    When provided, the classifier sees what questions have already been answered
    so it can correctly route follow-ups like "tell me more" or "why is that?".
    The history is serialised into the user message rather than passed as native
    multi-turn messages, keeping the orchestrator prompt format stable across
    LLM providers.
    """
    system = get_skill("orchestrator")

    payload_context = {
        "question":              question,
        "payload_meta":          payload.get("meta", {}),
        "has_kpis":              bool(payload.get("kpis")),
        "has_anomalies":         bool(payload.get("anomalies", {}).get("counts")),
        "has_data_summary":      bool(payload.get("data_summary", {}).get("by_user")),
        "total_actions":         payload.get("anomalies", {}).get("total_actions", 0),
        "total_flagged_actions": payload.get("anomalies", {}).get("total_flagged", {}).get("actions", 0),
    }

    # Prepend a compact conversation summary when continuing a session.
    # Only the last 3 turns (6 messages) are included — older turns are rarely
    # relevant for intent classification and would grow token count unboundedly.
    if llm_history:
        recent = llm_history[-6:]   # last 3 user+assistant pairs
        prior_turns = []
        for msg in recent:
            role    = msg.get("role", "")
            content = msg.get("content", "")[:600]   # enough to see ranking tables
            prior_turns.append(f"[{role}]: {content}")
        payload_context["prior_conversation"] = prior_turns

    # Include last Explorer Agent output summary for reference resolution.
    # This lets the Orchestrator understand "rank 2" → "user KIZUMI (33 flagged)"
    # when the previous turn showed a ranked table.
    _ds_id = payload.get("meta", {}).get("dataset_id")
    if _ds_id:
        import mesh_store as _ms
        for _agent_name, _prev in _ms.agent_outputs_by_recency(
            _ds_id, ("explorer-agent", "root-cause-agent", "anomaly-agent")
        ):
            if _prev and _prev.get("top_results"):
                payload_context["last_agent_results"] = {
                    "agent": _agent_name,
                    "top_results": _prev.get("top_results", [])[:10],
                    "question_answered": _prev.get("question_answered"),
                }
                break  # most recent relevant output

    user = json.dumps(payload_context, indent=2)

    try:
        response = call_llm(system, user)
        return extract_json_from_response(response)
    except Exception:
        # Classification failed — default to the cheap single-call ANOMALY_SUMMARY
        # rather than the expensive 4-call FULL_ANALYSIS. Log the traceback so a
        # persistently misrouting classifier is debuggable, not silently masked.
        log.exception("Intent classification failed — defaulting to ANOMALY_SUMMARY")
        return {"intent": "ANOMALY_SUMMARY", "acknowledgement": "Summarising anomalies..."}


# ─── individual agents ────────────────────────────────────────────────────────

def run_stats_agent(kpis: list, question: str = "", meta: dict = None) -> dict:
    payload_in = {"kpis": kpis}
    # Pass meta so the agent can derive threshold_label from
    # meta.slow_action_threshold_ms (otherwise it emits threshold_label: null and
    # the Narrator KPI table shows a blank threshold row). See stats-agent Step 2.
    if meta:
        payload_in["meta"] = meta
    if question:
        payload_in["user_request"] = question
    resp   = call_llm(get_skill("stats_agent"), json.dumps(payload_in, indent=2))
    result = _safe_json(resp, "stats-agent")
    result["_response_text"] = _prose(resp)
    return result


def run_anomaly_agent(anomalies: dict, question: str = "") -> dict:
    # Send ONLY the fields the Anomaly Agent's input contract uses. Callers pass
    # the whole anomalies blob (which also carries flagged_actions[] and
    # flagged_by_type{} — often thousands of tokens the agent never reads).
    slim = {
        "counts":        anomalies.get("counts", {}),
        "total_flagged": anomalies.get("total_flagged", {}),
        "total_actions": anomalies.get("total_actions", 0),
    }
    payload_in = {"anomalies": slim}
    if question:
        payload_in["user_request"] = question
    resp   = call_llm(get_skill("anomaly_agent"), json.dumps(payload_in, indent=2))
    result = _safe_json(resp, "anomaly-agent")
    result["_response_text"] = _prose(resp)
    return result


# ─── Phase-scoped root cause (deterministic, no LLM) ──────────────────────────
# Phase-attribution flags (frontend/network/backend_bound) live on the flagged
# rows, but the LLM only receives 10 slimmed examples per type and can't rank
# them. When the user scopes the question to a single phase we aggregate the
# FULL row list in code and render the answer ourselves.

_PHASE_LABEL = {
    "frontend_bound": "Frontend",
    "network_bound":  "Network",
    "backend_bound":  "Backend",
}

# Canonical root-cause blurbs — kept in sync with skills._ROOT_CAUSE_CATALOGUE.
_PHASE_ROOT_CAUSE = {
    "frontend_bound": ("The majority of the action's widget busy time was spent in "
                       "browser rendering — heavy DOM manipulation, complex layout "
                       "calculations, large JavaScript bundles executing synchronously, "
                       "or CSS reflow triggered repeatedly."),
    "network_bound":  ("The majority of the action's widget busy time was spent waiting "
                       "for network responses — slow server response times (high TTFB), "
                       "large payload sizes, or network latency between client and server."),
    "backend_bound":  ("The majority of the action's widget busy time was spent in backend "
                       "processing — slow database queries, complex business logic, resource "
                       "contention on the application server, or missing database indices."),
}

# Word → phase family. Matched with word boundaries to avoid false positives.
_PHASE_ALIASES = {
    "frontend_bound": ["frontend", "front end", "front-end", "client", "browser", "ui"],
    "network_bound":  ["network", "ttfb"],
    "backend_bound":  ["backend", "back end", "back-end", "server", "database"],
}


def _detect_phase_scope(question: str) -> str | None:
    """Return the single phase key the question scopes to, or None.

    Returns None if the question names zero phases or more than one (e.g.
    "compare frontend and backend" → let the normal path show every phase).
    """
    q = _strip_context_tag(question or "").lower()
    hits = set()
    for phase_key, words in _PHASE_ALIASES.items():
        for w in words:
            if re.search(r"\b" + re.escape(w) + r"\b", q):
                hits.add(phase_key)
                break
    return next(iter(hits)) if len(hits) == 1 else None


def _build_phase_drill(question: str, flagged_by_type: dict) -> dict | None:
    """Aggregate the full flagged-row list for one phase, ranked by action name.

    Returns None when the question is not scoped to exactly one phase (so the
    caller falls back to the normal LLM path).
    """
    phase_key = _detect_phase_scope(question)
    if not phase_key:
        return None

    rows = flagged_by_type.get(phase_key, []) or []
    agg: dict = {}
    for r in rows:
        name = r.get("action_name") or "(unnamed)"
        a = agg.setdefault(name, {"count": 0, "sum_ms": 0, "users": {}})
        a["count"]  += 1
        a["sum_ms"] += r.get("action_duration_ms") or 0
        u = r.get("user") or "—"
        a["users"][u] = a["users"].get(u, 0) + 1

    top = []
    for name, a in agg.items():
        top_user = max(a["users"].items(), key=lambda kv: kv[1])[0] if a["users"] else "—"
        top.append({
            "action_name": name,
            "count":       a["count"],
            "avg_ms":      round(a["sum_ms"] / a["count"]) if a["count"] else 0,
            "top_user":    top_user,
        })
    top.sort(key=lambda x: (-x["count"], -x["avg_ms"]))

    return {
        "phase_key":   phase_key,
        "label":       _PHASE_LABEL[phase_key],
        "total":       len(rows),
        "top_actions": top[:15],
    }


def _render_phase_drill(drill: dict) -> str:
    """Build the markdown answer: short explanation + ranked action list."""
    label = drill["label"]
    low   = label.lower()
    total = drill["total"]
    out   = [f"### Root Cause Analysis — {label} phase",
             "",
             f"*Filtered to: {low}-bound actions only.*",
             ""]

    if total == 0:
        out.append(f"No {low}-bound flagged actions in this dataset — no action spent the "
                   f"majority of its widget busy time in the {low} phase.")
        return "\n".join(out)

    out += [
        f"**{total:,} actions were flagged as {low}-bound** — the {low} phase held the "
        f"majority of widget busy time.",
        "",
        f"**Why {low} actions are slow:** {_PHASE_ROOT_CAUSE[drill['phase_key']]}",
        "",
        f"**Top {low}-flagged actions:**",
        "",
        "| Action | Flagged | Avg duration | Top user |",
        "|---|---|---|---|",
    ]
    for a in drill["top_actions"]:
        out.append(f"| {a['action_name']} | {a['count']:,} | {a['avg_ms']:,} ms | {a['top_user']} |")

    shown = sum(a["count"] for a in drill["top_actions"])
    if shown < total:
        out += ["",
                f"*Showing the top {len(drill['top_actions'])} action names "
                f"({shown:,} of {total:,} flagged {low}-bound actions).*"]
    return "\n".join(out)


def _phase_scoped_result(drill: dict, rc_input: dict) -> dict:
    """Synthesize a valid root-cause-agent output for a phase-scoped request,
    without calling the LLM. The JSON stays schema-complete for the mesh store."""
    note = (f"{drill['total']} actions were flagged {drill['label'].lower()}-bound"
            if drill["total"] else
            f"No {drill['label'].lower()}-bound actions were flagged")
    return {
        "agent":            "root-cause-agent",
        "status":           "CONFIRMED",
        "total_actions":    rc_input.get("total_actions"),
        "total_flagged":    rc_input.get("total_flagged", {}),
        "types_explained":  1,
        "root_causes":      [],
        "data_quality_flags": [],
        "phase_context": [{
            "type_key":   drill["phase_key"],
            "type_label": drill["label"],
            "actions":    drill["total"],
            "pct":        None,
            "root_cause": _PHASE_ROOT_CAUSE[drill["phase_key"]],
        }],
        "excluded_by_user":     [],
        "user_requested_drill": {"phase": drill["label"], "top_actions": drill["top_actions"]},
        "session_notes": [{
            "agent":        "root-cause-agent",
            "observation":  note + " (phase attribution: majority of widget busy time).",
            "significance": "medium",
        }],
        "_response_text": _render_phase_drill(drill),
    }


def run_root_cause_agent(rc_input: dict, question: str = "") -> dict:
    if question and "user_request" not in rc_input:
        rc_input = {**rc_input, "user_request": question}

    # ── Phase-scoped fast path ────────────────────────────────────────────────
    # "show me actions flagged by frontend", "network issues only", etc.
    # The LLM only ever sees 10 slimmed rows per type, so it can't produce an
    # accurate per-action ranking, and it has repeatedly failed to suppress the
    # non-matching sections. When the question names exactly one phase we build
    # the whole answer deterministically in code from the FULL flagged rows and
    # skip the model entirely — guaranteed accurate counts, guaranteed scope.
    full_fbt = rc_input.get("flagged_by_type", {}) or {}
    drill = _build_phase_drill(question, full_fbt)
    if drill is not None:
        return _phase_scoped_result(drill, rc_input)

    # ── Normal path ───────────────────────────────────────────────────────────
    # Slim flagged_by_type to 10 examples per type for the LLM (pattern ID only).
    llm_input = {**rc_input,
                 "flagged_by_type": {k: v[:10] for k, v in full_fbt.items()
                                     if isinstance(v, list)}}
    resp   = call_llm(get_skill("root_cause_agent"), json.dumps(llm_input, indent=2))
    result = _safe_json(resp, "root-cause-agent")
    prose  = _prose(resp)
    directive = _root_cause_chart_directive(rc_input, result, question)
    log.info("CHART-DEBUG root_cause: directive=%s fence_in_prose=%s", directive, _CHART_FENCE in (prose or ""))
    result["_response_text"] = _ensure_chart(prose, directive)
    return result


def run_explorer_agent(explorer_input: dict) -> dict:
    resp   = call_llm(get_skill("explorer_agent"), json.dumps(explorer_input, indent=2))
    result = _safe_json(resp, "explorer-agent")
    prose  = _prose(resp)
    directive = _explorer_chart_directive(explorer_input, result,
                                          explorer_input.get("user_request")
                                          or explorer_input.get("question", ""))
    log.info("CHART-DEBUG explorer: directive=%s fence_in_prose=%s", directive, _CHART_FENCE in (prose or ""))
    result["_response_text"] = _ensure_chart(prose, directive)
    return result


def run_narrator(narrator_input: dict, question: str = "") -> dict:
    if question and "user_request" not in narrator_input:
        narrator_input = {**narrator_input, "user_request": question}
    resp   = call_llm(get_skill("narrator"), json.dumps(narrator_input, indent=2))
    result = _safe_json(resp, "narrator")
    result["_response_text"] = _prose(resp)
    return result


def run_trace_agent(trace_input: dict) -> dict:
    resp   = call_llm(get_skill("trace_agent"), json.dumps(trace_input, indent=2))
    result = _safe_json(resp, "trace-agent")
    prose  = _prose(resp)
    directive = _trace_chart_directive(trace_input, result, trace_input.get("question", ""))
    log.info("CHART-DEBUG trace: directive=%s widgets_found=%s fence_in_prose=%s",
             directive, (result or {}).get("widgets_found"), _CHART_FENCE in (prose or ""))
    # replace=True: our deterministic directive is authoritative — override the
    # model's own (often malformed) fence rather than deferring to it.
    result["_response_text"] = _ensure_chart(prose, directive, replace=True)
    return result


def _run_parallel(kpis: list, anomalies: dict, question: str = "", meta: dict = None) -> tuple:
    """Run Stats Agent and Anomaly Agent concurrently via ThreadPoolExecutor."""
    with ThreadPoolExecutor(max_workers=2) as pool:
        f_stats   = pool.submit(run_stats_agent,   kpis,      question, meta)
        f_anomaly = pool.submit(run_anomaly_agent, anomalies, question)
        return f_stats.result(), f_anomaly.result()


# ─── explorer detail fetch ────────────────────────────────────────────────────

def _strip_context_tag(question: str) -> str:
    """Remove a leading ``[Previous: ...]`` / ``[Context: ...]`` enrichment tag.

    ``_resolve_followup_references`` prepends such a tag (containing prior-turn
    entity names, e.g. "#1 user 'SAP_SUPPORT_ACCESS9'") so the LLM can resolve
    pronouns. But the DETERMINISTIC parsers (``parse_query``, ``_fetch_detail_rows``,
    ``_inherit_time_context``) must never see it: they would match those injected
    names as if they were the user's filter — turning "NROS actions during that
    time" into a query for SAP_SUPPORT_ACCESS9. Strip the tag so deterministic
    scoping runs against the user's literal words only. The enriched question is
    still handed to the LLM unchanged for pronoun resolution.
    """
    if not question:
        return question
    import re
    return re.sub(r'^\s*\[(?:Previous|Context)\b[^\]]*\]\s*', '', question)


def _inherit_time_context(question: str, llm_history: list, dataset_id) -> str:
    """Resolve a deictic time reference in a follow-up question.

    When the CURRENT question refers to a time established in a PRIOR turn
    ("that time", "that hour", "that period/window", "then") but names no
    explicit time of its own, inherit the hour/date from the most recent prior
    USER turn that named one and append it as an explicit "hour N" / "on
    YYYY-MM-DD" clause. The deterministic parser (query_engine.parse_query,
    _fetch_detail_rows) only ever sees the current question string, so without
    this rewrite a follow-up like "show me NROS actions during that time" loses
    the hour-11 scope from the previous turn and the row list stops matching
    the breakdown count the user just saw.

    Returns the question unchanged unless ALL of: (a) it uses a deictic time
    phrase, (b) it names no explicit hour of its own, and (c) a prior user turn
    named an explicit hour/date. Idempotent — a rewritten question already
    carries an explicit hour, so re-running it is a no-op.
    """
    import re
    if not question or not llm_history or not dataset_id:
        return question
    q_lower = question.lower()
    deictic = re.search(
        r"\b(?:that|this|the\s+same|same)\s+"
        r"(?:time|hour|period|window|time\s*frame|timeframe|moment|point)\b"
        r"|\bthen\b",
        q_lower,
    )
    if not deictic:
        return question

    try:
        import query_engine as _qe
        import mesh_store as _ms
    except Exception:
        return question

    # The question already carries its own explicit hour → respect it.
    if _qe._detect_hour(question) is not None:
        return question

    entry = _ms.get_dataset(dataset_id)
    rows = (entry or {}).get("rows", []) or []
    own_date = _qe._detect_date(question, rows) if rows else None

    # Scan history newest-first for the most recent user turn naming a time.
    for msg in reversed(llm_history):
        if msg.get("role") != "user":
            continue
        prior = msg.get("content") or ""
        h = _qe._detect_hour(prior)
        d = _qe._detect_date(prior, rows) if rows else None
        if h is None and d is None:
            continue
        suffix = ""
        if h is not None:
            suffix += f" hour {h}"
        if d is not None and own_date is None:
            suffix += f" on {d}"
        log.info("Follow-up time-context: inherited hour=%s date=%s from prior "
                 "turn for deictic question %r", h, d, question)
        return question + suffix
    return question


def _build_explorer_input(question: str, payload: dict, dataset_id,
                          llm_history: list = None) -> dict:
    """
    Build the Explorer Agent's input.  Three distinct modes:

    CROSS mode  (mode = "cross")
      Triggered when the question names a specific entity from one dimension
      while asking about another (e.g. "which users have issues on story X?").
      Provides cross_filter (what was filtered on) + cross_results (pre-ranked
      answer for the result dimension scoped to that entity).
      Takes priority over ranking and detail when a cross-dimensional pattern
      is detected — it is the most specific signal.

    RANKING mode  (mode = "ranking")
      Triggered when the question asks for a top-N list of any dimension
      (users, stories, or action types).  Provides pre-sorted flagged rankings
      for all three dimensions.  No user_filter, no detail rows.

    DETAIL mode  (mode = "detail")
      Triggered when a specific username was extracted from the question text,
      or when dimension="users" and rank==1 (single worst user).
      Provides detail_rows + scoped flagged_by_type for that one user.

    All modes always receive all three global flagged rankings for context.
    """
    import re
    import mesh_store as _ms

    # Resolve deictic time references ("that time / that hour / then") to the
    # explicit hour/date established in a prior turn, so the row-detail and
    # aggregation paths scope a follow-up the same way the previous breakdown
    # was scoped. The dimension / rank / cross detectors strip the enrichment
    # tag internally (see _strip_context_tag) so none of them ever match an
    # injected prior-turn entity name as a filter.
    scoped_question = _inherit_time_context(
        _strip_context_tag(question), llm_history, dataset_id)

    user_filter     = None
    detail_rows     = []
    ranking_request = None
    cross_filter    = None
    cross_results   = []

    # Pre-compute all three flagged rankings in a single pass
    all_rankings            = _compute_flagged_rankings(payload)
    all_ranked_users        = all_rankings["users"]
    all_ranked_stories      = all_rankings["stories"]
    all_ranked_action_types = all_rankings["action_types"]

    # ── Cross-dimensional check (highest specificity — runs first) ────────────
    filter_dim, filter_val, result_dim = _detect_cross_dimensional_query(question, payload)

    if filter_dim is not None:
        cross_results = _compute_cross_dimensional_results(
            payload, filter_dim, filter_val, result_dim
        )
        log.info(
            "Explorer: cross-dimensional %s='%s' → %s (%d results)",
            filter_dim, filter_val, result_dim, len(cross_results),
        )
        if not cross_results:
            log.info(
                "Explorer: cross-dimensional %s='%s' — 0 flagged actions in filter",
                filter_dim, filter_val,
            )
        cross_filter = {
            "filter_dimension": filter_dim,
            "filter_value":     filter_val,
            "result_dimension": result_dim,
            "found_in_filter":  len(cross_results) > 0,   # sentinel for empty-result case
        }
        mode      = "cross"
        dimension = result_dim

        # Detect optional top-N within cross queries: "top 3 users on story X"
        _n_match = re.search(r'\btop\s+(\d+)\b', _strip_context_tag(question).lower())
        if _n_match:
            ranking_request = int(_n_match.group(1))
            log.info("Explorer: cross-mode top-%d request", ranking_request)

    else:
        # ── Single-dimension ranking or detail ────────────────────────────────
        dimension, rank = _detect_dimension_and_rank(question)

        if dimension == "users":
            if rank is None:
                # No rank — try to extract an explicit username from the question
                if dataset_id:
                    detail_rows = _fetch_detail_rows(scoped_question, dataset_id)
                    if detail_rows:
                        user_filter = detail_rows[0].get("user")
                mode = "detail" if user_filter else "ranking"

            elif rank == 1:
                # Single worst user → detail drill on the #1 flagged user
                if all_ranked_users:
                    user_filter = all_ranked_users[0]["user"]
                    log.info("Explorer: rank-1 user query → '%s'", user_filter)
                    if dataset_id:
                        entry = _ms.get_dataset(dataset_id)
                        if entry:
                            rows = entry.get("rows", [])
                            detail_rows = sorted(
                                [r for r in rows if r.get("user") == user_filter],
                                key=lambda r: r.get("action_duration_ms") or 0,
                                reverse=True,
                            )[:200]
                mode = "detail"

            else:
                # rank > 1 → top-N user ranking — DO NOT filter to a single user
                ranking_request = rank
                log.info("Explorer: top-%d user ranking request", rank)
                mode = "ranking"

        elif dimension == "stories":
            if rank:
                ranking_request = rank
                log.info("Explorer: top-%d story ranking request", rank)
            mode = "ranking"

        elif dimension == "action_types":
            if rank:
                ranking_request = rank
                log.info("Explorer: top-%d action-type ranking request", rank)
            mode = "ranking"

        else:
            # No dimension detected — only try username extraction for questions
            # that plausibly target a specific person. Skip for analytical overviews
            # ("breakdown", "distribution", "across all users", etc.) to avoid the
            # _fetch_detail_rows try-and-fail loop on aggregate questions.
            _analytical_signal = re.search(
                r'\b(?:breakdown|overview|analysis|summary|compare|distribution|'
                r'ranking|rankings|across|all\s+users|all\s+stories|all\s+actions?)\b',
                question.lower(),
            )
            if dataset_id and not _analytical_signal:
                detail_rows = _fetch_detail_rows(scoped_question, dataset_id)
                if detail_rows:
                    user_filter = detail_rows[0].get("user")
            mode = "detail" if user_filter else "ranking"

    # ── Scope flagged_by_type only in user detail mode ────────────────────────
    raw_fbt = payload.get("anomalies", {}).get("flagged_by_type", {})
    if user_filter:
        flagged_by_type = {
            type_key: [
                a for a in (actions if isinstance(actions, list) else [])
                if a.get("user") == user_filter
            ]
            for type_key, actions in raw_fbt.items()
            if any(a.get("user") == user_filter
                   for a in (actions if isinstance(actions, list) else []))
        }
    else:
        # Ranking / cross mode: slim to max 5 examples per type to save tokens
        flagged_by_type = {k: v[:5] for k, v in raw_fbt.items()
                           if isinstance(v, list)}

    # ── Slice each ranking to the requested count (only for its own dimension) ─
    # In cross mode ranking_request is None — pass full rankings as context.
    slice_users   = ranking_request if dimension == "users"        else None
    slice_stories = ranking_request if dimension == "stories"      else None
    slice_actions = ranking_request if dimension == "action_types" else None

    if mode == "cross":
        # In cross mode the global rankings are context only — cap to top 10
        # to prevent token explosion (e.g. 48 users × 44 affected_stories each).
        displayed_user_ranking   = all_ranked_users[:10]
        displayed_story_ranking  = all_ranked_stories[:10]
        displayed_action_ranking = all_ranked_action_types[:10]
    else:
        displayed_user_ranking   = all_ranked_users[:slice_users]   if slice_users   else all_ranked_users
        displayed_story_ranking  = all_ranked_stories[:slice_stories] if slice_stories else all_ranked_stories
        displayed_action_ranking = all_ranked_action_types[:slice_actions] if slice_actions else all_ranked_action_types

    # ── On-demand aggregation (time/story/action/session drilldowns) ──────────
    # Gives DATA_EXPLORATION the same view-parity slices the conversational path
    # gets: a filtered + grouped table computed from the full stored rows when
    # the question names a concrete drilldown or a by-hour/day/user breakdown.
    aggregation = None
    if dataset_id:
        try:
            import query_engine as _qe
            spec = _qe.parse_query(scoped_question, dataset_id)
            if spec:
                entry = _ms.get_dataset(dataset_id)
                rows = (entry or {}).get("rows", []) or []
                if rows:
                    agg = _qe.aggregate_rows(rows, filters=spec.get("filters"),
                                             group_by=spec.get("group_by"))
                    if agg.get("groups"):
                        aggregation = {
                            "filters":  spec.get("filters"),
                            "group_by": spec.get("group_by"),
                            "total_matching": agg.get("total_matching"),
                            "groups":   agg.get("groups"),
                            "table":    _qe.format_aggregation(spec, agg),
                            "answer":   _qe.format_answer(spec, agg),
                        }
                        log.info("Explorer: on-demand aggregation "
                                 "(filters=%s group_by=%s groups=%d)",
                                 spec.get("filters"), spec.get("group_by"),
                                 len(agg.get("groups", [])))
        except Exception:
            log.exception("Explorer on-demand aggregation failed — continuing without it")

    # ── Single-source enforcement (deterministic, structural) ─────────────────
    # When the question is SCOPED (the aggregation carries a concrete filter such
    # as user / story / action / session / date / hour), the full-dataset ranking
    # material below reports DIFFERENT counts for the same entity and is exactly
    # what the LLM grabs to fabricate a contradicting answer (e.g. answering "NROS
    # had 0/139 actions" when the scoped truth is 19). Prompt guards alone did not
    # stop this, so remove the competing numbers from the input entirely: the
    # aggregation becomes the ONLY per-entity numeric source the model can see.
    scoped_agg = bool(aggregation and aggregation.get("filters"))
    ds_out = payload.get("data_summary", {})  # pass full arrays — cap removed (see _slim_data_summary)
    if scoped_agg:
        displayed_user_ranking = displayed_story_ranking = displayed_action_ranking = []
        if ds_out:
            ds_out = {k: v for k, v in ds_out.items()
                      if k not in ("by_user", "by_story", "by_action")}

    return {
        "data_summary":                 ds_out,
        "flagged_users_ranking":        displayed_user_ranking,
        "flagged_stories_ranking":      displayed_story_ranking,
        "flagged_action_types_ranking": displayed_action_ranking,
        "flagged_by_type":              flagged_by_type,
        "question":                     question,
        "user_request":                 question,       # for _SCOPE_FILTER consistency
        "anomaly_context":              _get_anomaly_context(dataset_id),
        "detail_rows":                  detail_rows,
        "user_filter":                  user_filter,
        "mode":                         mode,           # "ranking" | "detail" | "cross"
        "dimension":                    dimension,
        "ranking_request":              ranking_request,
        "cross_filter":                 cross_filter,   # None unless mode = "cross"
        "cross_results":                (cross_results[:ranking_request] if ranking_request else cross_results),  # [] unless mode = "cross"
        "metric_rankings":              (None if scoped_agg else _compute_widget_metric_rankings(dataset_id, payload)),
        "previous_results":             _get_previous_explorer_context(dataset_id),
        "aggregation":                  aggregation,    # None unless a drilldown was parsed
    }


def _get_anomaly_context(dataset_id) -> dict | None:
    """Read Anomaly Agent output from mesh_store for cross-agent enrichment."""
    import mesh_store as _ms
    if not dataset_id:
        return None
    prev = _ms.read_agent_output(dataset_id, "anomaly-agent")
    if not prev:
        return None
    return {
        "active_headline_types": [
            {"key": t.get("key"), "label": t.get("label"), "actions": t.get("actions")}
            for t in prev.get("active_headline_types", [])
        ],
        "active_phase_types": [
            {"key": t.get("key"), "label": t.get("label"), "actions": t.get("actions")}
            for t in prev.get("active_phase_types", [])
        ],
        "total_flagged": prev.get("total_flagged"),
    }


def _get_explorer_context(dataset_id) -> dict | None:
    """Read Explorer Agent output from mesh_store for cross-agent enrichment."""
    import mesh_store as _ms
    if not dataset_id:
        return None
    prev = _ms.read_agent_output(dataset_id, "explorer-agent")
    if not prev:
        return None
    return {
        "question_answered":  prev.get("question_answered"),
        "dimension_explored": prev.get("dimension_explored"),
        "top_results":        prev.get("top_results", [])[:10],
    }


def _get_previous_explorer_context(dataset_id) -> dict | None:
    """
    Read the last Explorer Agent output from mesh_store for context threading.
    Returns a compact summary (top_results, dimension, question) so follow-up
    questions can resolve references like "rank 2" or "the second user".
    """
    import mesh_store as _ms
    if not dataset_id:
        return None
    prev = _ms.read_agent_output(dataset_id, "explorer-agent")
    if not prev:
        return None
    return {
        "question_answered":  prev.get("question_answered"),
        "dimension_explored": prev.get("dimension_explored"),
        "mode":               prev.get("mode"),
        "top_results":        prev.get("top_results", [])[:20],
    }


# ── helpers used by _build_explorer_input ─────────────────────────────────────

# Words that look like identifiers but aren't usernames.
# Prevents "for the top 1 user" → user_filter = "the"
_FETCH_STOPWORDS = {
    # Determiners / pronouns
    "the", "a", "an", "this", "that", "my", "our", "your", "their",
    "me", "all", "any", "some", "every", "each", "both", "other",
    # Rank references (handled separately by rank detection)
    "top", "first", "last", "one", "1", "2", "3",
    "most", "least", "worst", "best", "highest", "lowest",
    # Entity type nouns — prevent "for each user" → user_filter="each"
    "user", "users", "person", "people", "action", "actions",
    "story", "stories", "session", "sessions", "widget", "widgets",
    # Analytical / technical terms — prevent "by duration" → user_filter="duration"
    "duration", "time", "period", "hour", "day", "week", "month",
    "backend", "frontend", "network", "render", "offset", "phase",
    "performance", "anomaly", "anomalies", "issue", "issues",
    "slow", "fast", "average", "total", "count", "type", "types",
    "threshold", "flagged", "active", "inactive",
    # Preposition completions — prevent "sorted by X" false matches
    "sorted", "grouped", "filtered", "broken", "split",
    "data", "dataset", "file", "report", "summary", "analysis",
}


def _detect_user_rank_reference(question: str) -> int | None:
    """
    Return a 1-based rank if the question references a ranked user position.

    Matches patterns like:
      "top 1 user", "rank 1", "#1 user", "first user",
      "most flagged user", "highest flagged user", "worst user",
      "top user" (implied rank 1)
    Returns None if no rank is detected.
    """
    import re
    question = _strip_context_tag(question)
    q = question.lower()

    # User-vocabulary context words — the number must appear alongside these
    # so "top 3 stories" or "top 5 action types" do NOT match.
    _uv = r'(?:worst\s+)?(?:users?|people|persons?|performers?|offenders?)'

    # "top 3 users", "top 3 worst users", "top 3 worst performers"
    m = re.search(rf'\btop\s+(\d+)\s+(?:worst\s+)?{_uv}\b', q)
    if m: return int(m.group(1))

    # "3 worst users", "3 top users"
    m = re.search(rf'\b(\d+)\s+(?:worst|top)\s+{_uv}\b', q)
    if m: return int(m.group(1))

    # "rank 2 user", "#2 user"
    m = re.search(rf'\b(?:rank|#)\s*(\d+)\s*{_uv}\b', q)
    if m: return int(m.group(1))

    # Implicit rank-1 phrases (clearly about a single worst/top user)
    rank1_patterns = [
        r'\btop\s+user\b', r'\bfirst\s+user\b',
        r'\bhighest\s+flagged\s+user\b', r'\bmost\s+flagged\s+user\b',
        r'\bworst\s+user\b', r'\bworst\s+performer\b',
    ]
    if any(re.search(p, q) for p in rank1_patterns):
        return 1

    return None


def _detect_dimension_and_rank(question: str) -> tuple:
    """
    Detect the primary query dimension and requested top-N count.

    Returns (dimension, rank) where:
        dimension: "users" | "stories" | "action_types" | None
        rank:      int (explicit N) | 1 (implicit single worst) | None (show all)

    Vocabulary guards prevent false matches — e.g. "top 3 users on story X"
    must not resolve to dimension="stories", and "top 3 action types" must not
    fire the user detector.
    """
    import re
    question = _strip_context_tag(question)
    q = question.lower()

    # ── Story dimension ───────────────────────────────────────────────────────
    _sv = r'(?:stories|story|reports?|dashboards?|workbooks?)'

    m = re.search(rf'\btop\s+(\d+)\s+(?:worst\s+)?{_sv}\b', q)
    if m: return ("stories", int(m.group(1)))

    m = re.search(rf'\b(\d+)\s+(?:worst|top)\s+{_sv}\b', q)
    if m: return ("stories", int(m.group(1)))

    story_rank1 = [
        r'\bworst\s+story\b', r'\bworst\s+(?:report|dashboard)\b',
        r'\bmost\s+(?:flagged|problematic|performance\s+issues?)\s+story\b',
        r'\btop\s+story\b',
    ]
    if any(re.search(p, q) for p in story_rank1):
        return ("stories", 1)

    # ── Action-type dimension — require "type(s)" or "name(s)" to avoid ──────
    # matching plain "actions" which is too ambiguous (could mean KPI durations)
    _atv = r'(?:action\s+types?|action\s+names?)'

    m = re.search(rf'\btop\s+(\d+)\s+(?:worst\s+)?{_atv}\b', q)
    if m: return ("action_types", int(m.group(1)))

    m = re.search(rf'\b(\d+)\s+(?:worst|top)\s+{_atv}\b', q)
    if m: return ("action_types", int(m.group(1)))

    action_type_rank1 = [
        r'\bworst\s+action\s+type\b',
        r'\bmost\s+(?:flagged|problematic)\s+action\s+type\b',
        r'\bmost\s+(?:flagged|problematic)\s+action\s+name\b',
        r'\btop\s+action\s+type\b',
    ]
    if any(re.search(p, q) for p in action_type_rank1):
        return ("action_types", 1)

    # ── User dimension — delegate to existing detector ────────────────────────
    rank = _detect_user_rank_reference(question)
    if rank is not None:
        return ("users", rank)

    # ── Looser story detection (no top-N, but clearly about stories) ──────────
    story_general = [
        r'\bwhich\s+(?:stories|story|reports?|dashboards?)\b',
        r'\b(?:stories|story|reports?|dashboards?)\s+(?:have|has|with|most|are)\b',
        r'\bmost\s+(?:issues?|problems?|flagged|anomalies)\s+(?:in|on|per)?\s*(?:stor|report|dashboard)',
        r'\bperformance\s+(?:issues?|problems?)\s+(?:by|per|in|on)\s+(?:stor|report|dashboard)',
        # "issues by story", "flagged per story", "breakdown by story", "group by story"
        r'\b(?:issues?|problems?|flagged|anomalies|actions?)\s+(?:by|per)\s+(?:stor|report|dashboard)',
        r'\bbreakdown\s+(?:by|per)\s+(?:stor|report|dashboard)',
        r'\bgroup(?:ed)?\s+by\s+(?:stor|report|dashboard)',
    ]
    if any(re.search(p, q) for p in story_general):
        return ("stories", None)

    # ── Looser action-type detection ──────────────────────────────────────────
    action_type_general = [
        r'\bwhich\s+action\s+types?\b',
        r'\baction\s+types?\s+(?:have|has|with|most|are)\b',
        r'\bmost\s+(?:issues?|problems?|flagged|anomalies)\s+(?:in|on|per)?\s*action\s+types?\b',
        r'\bmost\s+(?:flagged|problematic)\s+actions?\b',
    ]
    if any(re.search(p, q) for p in action_type_general):
        return ("action_types", None)

    return (None, None)


def _compute_flagged_rankings(payload: dict) -> dict:
    """
    Single-pass computation of per-entity flagged action counts from the flat
    deduplicated flagged_actions list.

    Returns rankings pre-sorted by flagged_count descending for three dimensions:
        {
            "users":        [ {rank, user,        flagged_count, flagged_pct,
                               anomaly_types, affected_stories}, ... ],
            "stories":      [ {rank, story_name,  flagged_count, flagged_pct,
                               anomaly_types, affected_users},   ... ],
            "action_types": [ {rank, action_name, flagged_count, flagged_pct,
                               anomaly_types, affected_users},   ... ],
        }

    Deduplication key: (action_name, action_timestamp, session_id) — prevents
    an action flagged for multiple anomaly types being counted more than once
    per entity.
    """
    flagged_actions = payload.get("anomalies", {}).get("flagged_actions", [])

    users        = {}  # user        → {seen, types, related}
    stories      = {}  # story_name  → {seen, types, related}
    action_types = {}  # action_name → {seen, types, related}

    for action in flagged_actions:
        user        = action.get("user")        or "unknown"
        story       = action.get("story_name") or "unknown"
        action_name = action.get("action_name") or "unknown"
        anomaly_types = action.get("anomaly_types") or []

        action_key = (
            action.get("action_name",      ""),
            action.get("action_timestamp", ""),
            action.get("session_id",       ""),
        )

        for bucket, key in [
            (users,        user),
            (stories,      story),
            (action_types, action_name),
        ]:
            if key not in bucket:
                bucket[key] = {"seen": set(), "types": set(), "related": set()}
            bucket[key]["seen"].add(action_key)
            bucket[key]["types"].update(anomaly_types)

        # Cross-references (capped at 10 to limit token count)
        users[user]["related"].add(story)
        stories[story]["related"].add(user)
        action_types[action_name]["related"].add(user)

    total_flagged = sum(len(d["seen"]) for d in users.values()) or 1

    def _rank(bucket, entity_key, related_label):
        ranked = sorted(
            bucket.items(), key=lambda x: len(x[1]["seen"]), reverse=True
        )
        return [
            {
                "rank":          i + 1,
                entity_key:      name,
                "flagged_count": len(data["seen"]),
                "flagged_pct":   round(len(data["seen"]) / total_flagged * 100, 1),
                "anomaly_types": sorted(data["types"]),
                related_label:   sorted(data["related"])[:10],
            }
            for i, (name, data) in enumerate(ranked)
        ]

    return {
        "users":        _rank(users,        "user",        "affected_stories"),
        "stories":      _rank(stories,      "story_name",  "affected_users"),
        "action_types": _rank(action_types, "action_name", "affected_users"),
    }


def _compute_widget_metric_rankings(dataset_id, payload: dict) -> dict:
    """
    Aggregate widget-level timing metrics (offset, render, network, backend) by
    action_name, story_name, and user — reading from the widget_rows stored in
    mesh_store alongside the action rows.

    widget_rows carry the `offset` (pre-render wait ms), `render`, `network`,
    and `backend` phase durations per widget per action instance.

    Returns {
        "by_action": [{rank, action_name, total_offset_ms, avg_offset_ms,
                       total_render_ms, total_network_ms, total_backend_ms,
                       widget_count}],
        "by_story":  [same, keyed story_name],
        "by_user":   [same, keyed user],
        "available": bool   # False when no widget rows exist
    }
    All lists are pre-sorted by total_offset_ms descending.
    """
    import mesh_store as _ms

    if not dataset_id:
        return {"by_action": [], "by_story": [], "by_user": [], "available": False}

    entry = _ms.get_dataset(dataset_id)
    if not entry:
        return {"by_action": [], "by_story": [], "by_user": [], "available": False}

    widget_rows = entry.get("widget_rows", [])
    action_rows = entry.get("rows", [])

    if not widget_rows:
        return {"by_action": [], "by_story": [], "by_user": [], "available": False}

    # Build lookup: action_key ("action_name::timestamp") → {story_name, user}
    action_key_meta: dict = {}
    for row in action_rows:
        aname = row.get("action_name", "")
        ats   = row.get("action_timestamp", "")
        if aname:
            action_key_meta[f"{aname}::{ats}"] = {
                "story_name": row.get("story_name", "unknown"),
                "user":       row.get("user",       "unknown"),
            }

    action_data: dict = {}
    story_data:  dict = {}
    user_data:   dict = {}

    for w in widget_rows:
        action_key  = w.get("action_key", "")
        action_name = action_key.split("::")[0] if "::" in action_key else action_key

        meta       = action_key_meta.get(action_key, {})
        story_name = meta.get("story_name", "unknown")
        user       = meta.get("user",       "unknown")

        offset_ms  = float(w.get("offset",  0) or 0)
        render_ms  = float(w.get("render",  0) or 0)
        network_ms = float(w.get("network", 0) or 0)
        backend_ms = float(w.get("backend", 0) or 0)

        for bucket, key in [
            (action_data, action_name),
            (story_data,  story_name),
            (user_data,   user),
        ]:
            if key not in bucket:
                bucket[key] = {"offset": 0.0, "render": 0.0,
                               "network": 0.0, "backend": 0.0, "count": 0}
            bucket[key]["offset"]  += offset_ms
            bucket[key]["render"]  += render_ms
            bucket[key]["network"] += network_ms
            bucket[key]["backend"] += backend_ms
            bucket[key]["count"]   += 1

    def _rank(bucket, entity_key):
        ranked = sorted(
            bucket.items(), key=lambda x: x[1]["offset"], reverse=True
        )
        return [
            {
                "rank":             i + 1,
                entity_key:         name,
                "total_offset_ms":  round(data["offset"]),
                "avg_offset_ms":    round(data["offset"] / data["count"])
                                    if data["count"] else 0,
                "total_render_ms":  round(data["render"]),
                "total_network_ms": round(data["network"]),
                "total_backend_ms": round(data["backend"]),
                "widget_count":     data["count"],
            }
            for i, (name, data) in enumerate(ranked)
        ]

    # ── Layer 2: action-level duration aggregations from raw rows ─────────────
    # Separate from widget rows so duration questions work even without widgets.
    action_dur: dict = {}   # action_name → {total_ms, count}
    story_dur:  dict = {}
    user_dur:   dict = {}
    session_dur: dict = {}  # session_id → {total_ms, count}

    flagged_sessions: dict = {}  # session_id → flagged_count (from payload)
    for fa in payload.get("anomalies", {}).get("flagged_actions", []):
        sid = fa.get("session_id", "")
        if sid:
            flagged_sessions[sid] = flagged_sessions.get(sid, 0) + 1

    for row in action_rows:
        aname  = row.get("action_name",  "unknown") or "unknown"
        sname  = row.get("story_name",   "unknown") or "unknown"
        user   = row.get("user",         "unknown") or "unknown"
        sid    = row.get("session_id",   "unknown") or "unknown"
        dur_ms = float(row.get("action_duration_ms", 0) or 0)

        for bucket, key in [
            (action_dur, aname),
            (story_dur,  sname),
            (user_dur,   user),
        ]:
            if key not in bucket:
                bucket[key] = {"total_ms": 0.0, "count": 0}
            bucket[key]["total_ms"] += dur_ms
            bucket[key]["count"]    += 1

        if sid not in session_dur:
            session_dur[sid] = {"total_ms": 0.0, "count": 0, "user": user, "story": sname}
        session_dur[sid]["total_ms"] += dur_ms
        session_dur[sid]["count"]    += 1

    def _merge_dur(bucket, entity_key, widget_list):
        """Merge duration totals into the pre-built widget ranking list."""
        dur_map = {k: v for k, v in bucket.items()}
        merged = []
        seen = set()
        for row in widget_list:
            name = row.get(entity_key, "")
            seen.add(name)
            d = dur_map.get(name, {})
            merged.append({
                **row,
                "total_duration_ms": round(d.get("total_ms", 0)),
                "avg_duration_ms":   round(d["total_ms"] / d["count"])
                                     if d.get("count") else 0,
                "action_count":      d.get("count", 0),
            })
        # add entities that appear in action rows but have no widget rows
        for name, d in dur_map.items():
            if name not in seen:
                merged.append({
                    "rank":             0,  # will be re-ranked below
                    entity_key:         name,
                    "total_offset_ms":  0,
                    "avg_offset_ms":    0,
                    "total_render_ms":  0,
                    "total_network_ms": 0,
                    "total_backend_ms": 0,
                    "widget_count":     0,
                    "total_duration_ms": round(d["total_ms"]),
                    "avg_duration_ms":   round(d["total_ms"] / d["count"])
                                         if d["count"] else 0,
                    "action_count":      d["count"],
                })
        # re-rank by total_offset_ms (primary), total_duration_ms (secondary)
        merged.sort(key=lambda x: (x["total_offset_ms"], x["total_duration_ms"]), reverse=True)
        for i, row in enumerate(merged):
            row["rank"] = i + 1
        return merged

    by_action_merged = _merge_dur(action_dur, "action_name", _rank(action_data, "action_name"))
    by_story_merged  = _merge_dur(story_dur,  "story_name",  _rank(story_data,  "story_name"))
    by_user_merged   = _merge_dur(user_dur,   "user",        _rank(user_data,   "user"))

    # ── Session rankings ─────────────────────────────────────────────────────
    session_ranked = sorted(
        session_dur.items(),
        key=lambda x: x[1]["total_ms"],
        reverse=True,
    )
    by_session = [
        {
            "rank":              i + 1,
            "session_id":        sid,
            "user":              d["user"],
            "story":             d["story"],
            "action_count":      d["count"],
            "total_duration_ms": round(d["total_ms"]),
            "avg_duration_ms":   round(d["total_ms"] / d["count"]) if d["count"] else 0,
            "flagged_count":     flagged_sessions.get(sid, 0),
        }
        for i, (sid, d) in enumerate(session_ranked)
    ]

    return {
        "by_action":  by_action_merged,
        "by_story":   by_story_merged,
        "by_user":    by_user_merged,
        "by_session": by_session,
        "available":  True,
    }


def _slim_data_summary(ds: dict, cap: int = 20) -> dict:
    """
    DEPRECATED — no longer called.

    Previously capped by_user / by_story / by_action to `cap` rows to save
    ~1,500 input tokens per call.  Removed because the Explorer Agent requires
    COMPLETE lists to answer "most active" questions correctly: a 48-user dataset
    truncated to 20 would report rank-21+ users as non-existent, producing silent
    wrong answers.  The token cost is accepted; correctness is not negotiable.

    Do not reinstate without also fixing the Explorer SKILL to handle partial arrays.
    """
    if not ds:
        return ds
    return {
        **ds,
        "by_user":   ds.get("by_user",   [])[:cap],
        "by_story":  ds.get("by_story",  [])[:cap],
        "by_action": ds.get("by_action", [])[:cap],
    }


def _rank_users_by_flagged_count(payload: dict) -> list:
    """Thin wrapper for backward compatibility — new code calls _compute_flagged_rankings."""
    return _compute_flagged_rankings(payload)["users"]


# ── Cross-dimensional query helpers ───────────────────────────────────────────

def _detect_cross_dimensional_query(question: str, payload: dict) -> tuple:
    """
    Detect entity-pair cross-dimensional queries such as:
      "which users have issues on story X?"
      "which stories is user alice having problems with?"
      "which action types are flagged in story X?"

    Strategy:
      1. Detect the result dimension from "which users / which stories / which
         action types" patterns.
      2. Find the longest known entity name from any OTHER dimension that appears
         verbatim (case-insensitive) in the question.
      3. That entity becomes the filter.

    Returns (filter_dim, filter_value, result_dim) or (None, None, None).
    Entity names are matched longest-first to avoid partial matches.
    """
    import re
    question = _strip_context_tag(question)
    q_lower = question.lower()

    # ── Step 1: Detect result dimension ──────────────────────────────────────
    # Patterns cover: "which X", "what X", "who", "how many X", and "top N X"
    # so that "top 3 users on story X" correctly triggers cross mode.
    result_dim = None
    if re.search(
        r'\bwhich\s+users?\b|\bwhat\s+users?\b|\bwho\b'
        r'|\bhow\s+many\s+users?\b'
        r'|\btop\s+\d+\s+(?:worst\s+)?(?:users?|people|performers?|offenders?)\b',
        q_lower,
    ):
        result_dim = "users"
    elif re.search(
        r'\bwhich\s+(?:stories|story|reports?|dashboards?)\b'
        r'|\bwhat\s+(?:stories|story|reports?|dashboards?)\b'
        r'|\bhow\s+many\s+(?:stories|story|reports?|dashboards?)\b'
        r'|\btop\s+\d+\s+(?:worst\s+)?(?:stories|story|reports?|dashboards?)\b',
        q_lower,
    ):
        result_dim = "stories"
    elif re.search(
        r'\bwhich\s+action(?:\s+types?)?\b|\bwhat\s+action(?:\s+types?)?\b'
        r'|\bhow\s+many\s+action\s+types?\b'
        r'|\btop\s+\d+\s+(?:worst\s+)?action\s+types?\b',
        q_lower,
    ):
        result_dim = "action_types"

    if result_dim is None:
        return (None, None, None)

    # ── Step 2: Build entity name sets from payload ───────────────────────────
    flagged_actions = payload.get("anomalies", {}).get("flagged_actions", [])
    entity_sets = {
        "stories":      {a.get("story_name") for a in flagged_actions if a.get("story_name")},
        "action_types": {a.get("action_name") for a in flagged_actions if a.get("action_name")},
        "users":        {a.get("user")        for a in flagged_actions if a.get("user")},
    }

    # ── Step 3: Longest-match entity search in OTHER dimensions ──────────────
    for filter_dim, entity_set in entity_sets.items():
        if filter_dim == result_dim:
            continue
        # Longest first — prevents "Sales" matching before "Sales Overview Q4"
        # Min length 4: prevents stop-word-length names ("is", "on", "to") from
        # spuriously matching prepositions or articles in the question text.
        candidates = sorted((e for e in entity_set if e and len(e) >= 4), key=len, reverse=True)
        for entity in candidates:
            if entity.lower() in q_lower:
                return (filter_dim, entity, result_dim)

    return (None, None, None)


def _compute_cross_dimensional_results(
    payload: dict,
    filter_dim: str,
    filter_val: str,
    result_dim: str,
) -> list:
    """
    Filter flagged_actions to rows where filter_dim == filter_val, then rank
    by result_dim (deduplicated by action identity key).

    Returns [
        {rank, <result_field>: entity, flagged_count, flagged_pct,
         anomaly_types, total_in_filter}
    ] sorted by flagged_count descending.
    """
    _field = {
        "users":        "user",
        "stories":      "story_name",
        "action_types": "action_name",
    }
    filter_field = _field[filter_dim]
    result_field = _field[result_dim]

    flagged_actions = payload.get("anomalies", {}).get("flagged_actions", [])

    # Filter to matching entity (case-insensitive exact match)
    fval_lower = filter_val.lower()
    matching = [
        a for a in flagged_actions
        if (a.get(filter_field) or "").lower() == fval_lower
    ]

    # Group by result dimension, deduplicate by action identity key
    result_data: dict = {}
    for action in matching:
        entity = action.get(result_field) or "unknown"
        action_key = (
            action.get("action_name",      ""),
            action.get("action_timestamp", ""),
            action.get("session_id",       ""),
        )
        if entity not in result_data:
            result_data[entity] = {"seen": set(), "types": set()}
        result_data[entity]["seen"].add(action_key)
        result_data[entity]["types"].update(action.get("anomaly_types") or [])

    total_in_filter = sum(len(d["seen"]) for d in result_data.values()) or 1
    ranked = sorted(result_data.items(), key=lambda x: len(x[1]["seen"]), reverse=True)

    return [
        {
            "rank":            i + 1,
            result_field:      entity,
            "flagged_count":   len(data["seen"]),
            "flagged_pct":     round(len(data["seen"]) / total_in_filter * 100, 1),
            "anomaly_types":   sorted(data["types"]),
            "total_in_filter": total_in_filter,
        }
        for i, (entity, data) in enumerate(ranked)
    ]


def _sorted_flagged(flagged: list) -> list:
    """Flagged action rows sorted worst-first by duration, each carrying a
    `flags` alias for `anomaly_types`.

    Two fixes fold together here:
    - The payload's `flagged_actions` arrive in the frontend's serialization
      order, NOT by duration — so `flagged[0]` was not necessarily the worst
      offender. Sort by `action_duration_ms` descending so index 0 is the true
      worst action (matches the ROOT_CAUSE / trace `_top_flagged` selection).
    - Row-level SKILL tables (root-cause Step 8, narrator worst-offender) read a
      `flags` field, but each row carries its anomaly type keys under
      `anomaly_types`. Mirror it to `flags` so the documented read populates
      instead of rendering blank.
    """
    out = []
    for a in sorted(flagged or [],
                    key=lambda r: r.get("action_duration_ms") or 0,
                    reverse=True):
        if isinstance(a, dict) and "flags" not in a and "anomaly_types" in a:
            a = {**a, "flags": a.get("anomaly_types") or []}
        out.append(a)
    return out


def _build_trace_input(question: str, payload: dict, dataset_id) -> dict:
    """
    Build trace-agent input — mesh-native, token-controlled.

    In pipeline mode the LLM can't make HTTP calls, so we fetch widget data
    from the dataset store and include it. We aggressively trim to stay under
    token limits:
      - Only the TOP 3 flagged actions (by duration, descending)
      - Widget rows for those 3 actions only
      - Slim type summary instead of full flagged_by_type arrays
      - Compact mesh outputs (just the fields the trace agent uses)
    """
    import mesh_store

    anomalies = payload.get("anomalies", {})
    flagged_actions = anomalies.get("flagged_actions", [])

    # Sort by duration descending, take top 3 — the trace agent investigates
    # the worst actions, not all of them.
    top_actions = sorted(
        flagged_actions,
        key=lambda a: a.get("action_duration_ms") or 0,
        reverse=True,
    )[:3]

    # Slim each action to just what the trace agent needs (drop session_id etc.)
    slim_actions = []
    for a in top_actions:
        slim_actions.append({
            "action_name":        a.get("action_name", ""),
            "action_timestamp":   a.get("action_timestamp", ""),
            "user":               a.get("user", ""),
            "action_duration_ms": a.get("action_duration_ms", 0),
            "anomaly_types":      a.get("anomaly_types", []),
        })

    # Build a compact type summary: { type_key: action_count } instead of full arrays
    flagged_by_type = anomalies.get("flagged_by_type", {})
    type_summary = {}
    for type_key, actions in flagged_by_type.items():
        if isinstance(actions, list) and len(actions) > 0:
            type_summary[type_key] = len(actions)

    # Fetch widget rows ONLY for the top actions
    widget_data = {}
    if dataset_id:
        entry = mesh_store.get_dataset(dataset_id)
        if entry:
            all_widget_rows = entry.get("widget_rows", [])
            for a in slim_actions:
                action_key = f"{a['action_name']}::{a['action_timestamp']}"
                matching = [
                    {  # Slim widget rows — drop timestamps to save tokens
                        "widget_id":   w.get("widget_id", ""),
                        "widget_name": w.get("widget_name", ""),
                        "render":      w.get("render"),
                        "network":     w.get("network"),
                        "backend":     w.get("backend"),
                        "offset":      w.get("offset"),
                        "total":       w.get("total"),
                    }
                    for w in all_widget_rows
                    if w.get("action_key") == action_key
                ]
                if matching:
                    widget_data[action_key] = matching

    # Compact mesh reads — only the summary fields, not the full agent output
    anomaly_out = read_agent_output(dataset_id, "anomaly-agent")
    rc_out = read_agent_output(dataset_id, "root-cause-agent")

    compact_anomaly = None
    if anomaly_out:
        compact_anomaly = {
            "types_active":          anomaly_out.get("types_active"),
            "active_headline_types": [
                {"key": t.get("key"), "label": t.get("label"), "actions": t.get("actions")}
                for t in anomaly_out.get("active_headline_types", [])
            ],
        }

    compact_rc = None
    if rc_out:
        compact_rc = [
            {"type_key": r.get("type_key"), "nature": r.get("nature"), "root_cause": r.get("root_cause")}
            for r in rc_out.get("root_causes", [])
        ]

    return {
        "dataset_id":        dataset_id,
        "question":          question,
        "type_summary":      type_summary,
        "top_actions":       slim_actions,
        "widget_data":       widget_data,
        "anomaly_context":   compact_anomaly,
        "root_cause_context": compact_rc,
    }


def _fetch_detail_rows(question: str, dataset_id: str) -> list:
    """
    Fetch filtered action rows for detail-mode queries by reading directly
    from mesh_store — same data that GET /api/actions serves.

    Parses the question for a user filter (possessive "X's", or "for X" /
    "by X" / "show me X" prefixes), then VALIDATES the candidate against
    actual user names in the dataset before filtering. This prevents
    analytical questions like "show me actions for each user" from being
    misrouted to detail mode with user_filter="each".

    Returns up to 500 rows sorted by duration descending, or [] if no
    valid user filter is found.
    """
    import mesh_store as _ms

    q_lower     = question.lower()
    user_filter = None

    # "John's actions" → user_filter = "John"
    apostrophe = question.find("'s")
    if apostrophe != -1:
        word_start  = question.rfind(" ", 0, apostrophe) + 1
        user_filter = question[word_start:apostrophe]

    # "for John", "by John", "show me John"
    # Guard: skip stopwords so "for the top 1 user" → user_filter = "the" doesn't happen
    if not user_filter:
        for prefix in ["for ", "by ", "show me "]:
            idx = q_lower.find(prefix)
            if idx != -1:
                candidate = question[idx + len(prefix):].split()[0].rstrip("'s,")
                if len(candidate) > 2 and candidate.lower() not in _FETCH_STOPWORDS:
                    user_filter = candidate
                    break

    if not user_filter:
        return []

    entry = _ms.get_dataset(dataset_id)
    if entry is None:
        log.warning("Detail fetch: dataset '%s' not found (checked memory and disk)", dataset_id)
        return []

    rows = entry.get("rows", [])

    # ── Validate against known users ──────────────────────────────────────────
    # Even if the candidate passed stopword filtering, it must match an actual
    # user name in the dataset. This catches edge cases the stopword list can't
    # cover (e.g. a new analytical term we didn't anticipate, or a sentence
    # structure that tricks the prefix matcher).
    #
    # Try exact match first, then case-insensitive match.
    known_users = {r.get("user", "") for r in rows if r.get("user")}
    known_users_lower = {u.lower(): u for u in known_users}

    if user_filter in known_users:
        # Exact match — use as-is
        pass
    elif user_filter.lower() in known_users_lower:
        # Case-insensitive match — use the canonical casing from the dataset
        user_filter = known_users_lower[user_filter.lower()]
    else:
        log.info("Detail fetch: candidate '%s' is not a known user in dataset — "
                 "skipping detail mode (likely an analytical question)", user_filter)
        return []

    # Apply any additional time / session / story / action / duration scoping the
    # question carries, using the SAME filter engine the on-demand aggregation
    # uses. Without this, a scoped count ("16 actions in hour 11") and this row
    # list ("81 rows across all hours") come from two different filters and can
    # contradict each other. query_engine.filter_rows is the single source of truth.
    import query_engine as _qe
    filter_spec = {"user": user_filter}
    try:
        spec = _qe.parse_query(question, dataset_id)
        if spec:
            for k in ("date", "hour_of_day", "session", "story", "action",
                      "duration_min_ms", "duration_max_ms"):
                val = spec.get("filters", {}).get(k)
                if val is not None:
                    filter_spec[k] = val
    except Exception:
        log.exception("Detail fetch: extra-filter parse failed — falling back to user-only")

    filtered = _qe.filter_rows(rows, filter_spec)
    filtered.sort(key=lambda r: _qe._row_duration(r) or 0, reverse=True)

    log.info("Detail fetch: filters=%s  matched=%d rows (validated against dataset)",
             filter_spec, len(filtered))
    return filtered[:500]


# ─── conversational fallback ──────────────────────────────────────────────────

def _conversational_answer(question: str, payload: dict,
                           llm_history: list = None,
                           dataset_id: str = None) -> str:
    """
    Answer a conversational question.

    When llm_history is present (i.e. the user is continuing a session),
    make a real LLM call with the full conversation history so the model
    can synthesise prior findings, answer "why?" follow-ups, or summarise.

    The LLM prompt is enriched with relevant payload sections (insights,
    summary_view, session_summary) so the model can answer questions
    about quick headlines, busiest periods, rankings, and session context
    without dispatching agents.

    When the question names a concrete drilldown (a user / story / action /
    session / date / hour, or asks for an hour-by-hour / per-day / by-user
    breakdown) an on-demand aggregation is computed from the full stored
    dataset via query_engine and injected into the data context. This is the
    path that answers "hour-by-hour breakdown for MHURTADO's story on Jul 30"
    with a real table instead of an apology.

    Without history (first question, no session), fall back to a static
    summary of the dataset meta so the response is always fast and cheap.
    """

    # ── Build data context snippet from new v1.1 payload sections ──
    data_context_parts: list[str] = []

    # -- insights: headline, kpi_line, recommendation, top_issues, worst_offender
    insights = payload.get("insights")
    if insights:
        ins_lines = [
            "## Quick Insights (pre-computed by the tool)",
            f"Headline: {insights.get('headline', '—')}",
        ]
        kpi_line = insights.get("kpi_line")
        if kpi_line:
            ins_lines.append(f"KPI summary: {kpi_line}")
        ins_lines.append(f"Recommendation: {insights.get('recommendation', '—')}")
        top_issues = insights.get("top_issues") or []
        if top_issues:
            ins_lines.append("Top issues:")
            for iss in top_issues[:5]:
                ins_lines.append(
                    f"  - {iss.get('label', '?')} — "
                    f"{iss.get('count', '?')} actions ({iss.get('pct', '?')}%)"
                )
        worst = insights.get("worst_offender")
        if worst:
            flags = ", ".join(worst.get("flag_labels", []))
            ins_lines.append(
                f"Worst offender: {worst.get('action_name', '?')} "
                f"in story \"{worst.get('story', '?')}\" — "
                f"{worst.get('duration_ms', '?')} ms"
                + (f" [{flags}]" if flags else "")
            )
        data_context_parts.append("\n".join(ins_lines))

    # -- summary_view.busiest: { day, week, month } each with { label, count }
    summary_view = payload.get("summary_view", {})
    busiest = summary_view.get("busiest")
    if busiest:
        bus_lines = ["## Busiest Periods"]
        for period_key in ("day", "week", "month"):
            entry = busiest.get(period_key)
            if entry:
                bus_lines.append(
                    f"Busiest {period_key}: {entry.get('label', '—')} "
                    f"({entry.get('count', '—')} actions)"
                )
        if len(bus_lines) > 1:
            data_context_parts.append("\n".join(bus_lines))

    # -- summary_view.rankings: { slowest: [{id,title,view,items:[{label,sublabel,value_ms}]}],
    #                              fastest: [...] }
    rankings = summary_view.get("rankings", {})
    for rank_key in ("slowest", "fastest"):
        rank_categories = rankings.get(rank_key) or []
        if not rank_categories:
            continue
        lines = [f"## {rank_key.capitalize()} Rankings"]
        for cat in rank_categories:
            title = cat.get("title", cat.get("id", "?"))
            view = cat.get("view", "")
            lines.append(f"### {title}" + (f" ({view})" if view else ""))
            for idx, item in enumerate((cat.get("items") or [])[:10], 1):
                lines.append(
                    f"  {idx}. {item.get('label', '?')}"
                    + (f" — {item.get('sublabel', '')}" if item.get("sublabel") else "")
                    + f" — {item.get('value_ms', '?')} ms"
                )
        data_context_parts.append("\n".join(lines))

    # -- session_summary: { total_sessions, total_unique_users, total_unique_stories,
    #                        kpis[], by_user[], by_story[], slowest_sessions[] }
    session_summary = payload.get("session_summary")
    if session_summary and session_summary.get("total_sessions", 0) > 0:
        sess_lines = [
            "## Session Summary",
            f"Total sessions: {session_summary.get('total_sessions', '—')}",
            f"Unique users: {session_summary.get('total_unique_users', '—')}",
            f"Unique stories: {session_summary.get('total_unique_stories', '—')}",
        ]
        sess_kpis = session_summary.get("kpis") or []
        for k in sess_kpis:
            sess_lines.append(f"{k.get('label', '?')}: {k.get('value', '?')}")
        slowest = (session_summary.get("slowest_sessions") or [])[:5]
        if slowest:
            sess_lines.append("Slowest sessions (top 5):")
            for s in slowest:
                sess_lines.append(
                    f"  - {s.get('session_id', '?')} (user: {s.get('user', '?')}, "
                    f"story: {s.get('story', '?')}) — "
                    f"{s.get('total_duration_ms', '?')} ms total, "
                    f"{s.get('action_count', '?')} actions"
                )
        data_context_parts.append("\n".join(sess_lines))

    # -- on-demand aggregation from the full stored dataset --
    # Deterministically parse the question for a filter/group-by drilldown and
    # compute it from the raw rows (query_engine). This is what lets the
    # conversational path answer time/user/story slices the summarized payload
    # doesn't carry (e.g. hour-by-hour for one user on one day).
    _scoped_suppress = False   # set True for a scoped question → single source
    _agg_block = ""            # the deterministic answer + table, if computed
    if dataset_id:
        try:
            import query_engine as _qe
            import mesh_store as _ms
            # Resolve deictic time references ("that time / that hour / then")
            # against the prior turn so a follow-up drilldown inherits the hour
            # /date the user just saw, instead of silently widening to all rows.
            scoped_question = _inherit_time_context(
        _strip_context_tag(question), llm_history, dataset_id)
            spec = _qe.parse_query(scoped_question, dataset_id)
            if spec:
                entry = _ms.get_dataset(dataset_id)
                rows = (entry or {}).get("rows", []) or []
                if rows:
                    agg = _qe.aggregate_rows(rows, filters=spec.get("filters"),
                                             group_by=spec.get("group_by"))
                    table = _qe.format_aggregation(spec, agg)
                    answer = _qe.format_answer(spec, agg)
                    if table:
                        _agg_block = ((answer + "\n\n") if answer else "") + table
                        data_context_parts.append(_agg_block)
                        # SINGLE NUMERIC SOURCE: when the question is SCOPED to a
                        # concrete filter (user / story / action / session / date
                        # / hour), the aggregation IS the authoritative per-entity
                        # number. The full-dataset insights, rankings, and session
                        # rollups gathered above describe a DIFFERENT (unscoped)
                        # set and would let the model fabricate a contradiction —
                        # so for a scoped question we drop them and keep only the
                        # aggregation (mirrors _build_explorer_input's suppression).
                        # A pure breakdown ("by hour", empty filters) keeps the
                        # context — no per-entity contradiction is possible there.
                        _scoped_suppress = bool(spec.get("filters"))
                        log.info("CONVERSATIONAL: injected on-demand aggregation "
                                 "(filters=%s group_by=%s groups=%d scoped_suppress=%s)",
                                 spec.get("filters"), spec.get("group_by"),
                                 len(agg.get("groups", [])), _scoped_suppress)
        except Exception:
            log.exception("On-demand aggregation failed — continuing without it")

    if _scoped_suppress and _agg_block:
        data_context = _agg_block
    else:
        data_context = "\n\n".join(data_context_parts)

    if llm_history:
        # Build an enriched system prompt when we have payload data
        system = _CONVERSATIONAL_SYSTEM
        if data_context:
            system += (
                "\n\n--- DATA CONTEXT (from the current dataset) ---\n"
                + data_context
                + "\n--- END DATA CONTEXT ---\n"
                "Use the data above to answer the user's question when relevant. "
                "Cite specific numbers from the data."
            )
        try:
            return call_llm(system, question, history=llm_history)
        except Exception as exc:
            log.warning("Conversational LLM call failed (%s) — using static fallback", exc)

    # Static fallback — no history or LLM call failed
    meta = payload.get("meta", {})
    anom = payload.get("anomalies", {})
    parts = [
        f"Dataset: {meta.get('file_name', 'unknown')}",
        f"Total actions: {anom.get('total_actions', '—')}",
        f"Flagged: {anom.get('total_flagged', {}).get('actions', '—')}",
    ]
    if data_context:
        parts.append("")
        parts.append(data_context)
    parts.append("")
    parts.append("For detailed analysis, ask about anomalies, KPIs, or specific users.")
    return "\n".join(parts)


# ─── session turn persistence ─────────────────────────────────────────────────

def _save_turn(session_id: str, question: str, response_text: str,
               agent: str = None, intent: str = None) -> None:
    """
    Write one user→assistant exchange to the session's conversation history.
    No-ops gracefully when session_id is None (stateless /api/chat calls).
    """
    if not session_id:
        return
    _mesh.append_to_history(session_id, "user",      question,      agent=None,  intent=intent)
    _mesh.append_to_history(session_id, "assistant", response_text, agent=agent, intent=intent)


# ─── helpers ──────────────────────────────────────────────────────────────────

def _safe_json(response: str, agent_name: str) -> dict:
    try:
        return extract_json_from_response(response)
    except ValueError as exc:
        log.error("JSON parse failed for %s: %s", agent_name, exc)
        return {"agent": agent_name, "status": "PARSE_ERROR", "error": str(exc),
                "_response_text": f"⚠ {agent_name} returned unparseable output. "
                                  "The analysis for this agent could not be completed.",
                "session_notes": []}


def _is_parse_error(output: dict) -> bool:
    """Check if an agent output is a PARSE_ERROR sentinel."""
    return isinstance(output, dict) and output.get("status") == "PARSE_ERROR"


def _guard_store(dataset_id: str, agent_name: str, output: dict) -> None:
    """Store agent output to mesh ONLY if it is valid (not a PARSE_ERROR).

    PARSE_ERROR dicts must never enter the mesh — downstream agents read from
    the mesh and would silently operate on empty/broken data, producing
    hallucinated analysis.
    """
    if _is_parse_error(output):
        log.warning("Refusing to store PARSE_ERROR output for %s — downstream agents would receive broken data", agent_name)
        return
    store_agent_output(dataset_id, agent_name, output)


def _prose(response: str) -> str:
    """Return the human-readable prose with the ```json ... ``` block removed.

    Agents are asked to put the table first and the JSON last, but some (the
    Explorer historically) emit JSON first. Stripping the fenced block wherever
    it sits — rather than keeping only the text before it — means the visible
    answer survives regardless of ordering.
    """
    start = response.find("```json")
    if start == -1:
        return response.strip()
    end = response.find("```", start + len("```json"))
    if end == -1:
        # Unterminated block — drop everything from the opening fence onward.
        return response[:start].strip()
    end += len("```")
    return (response[:start] + response[end:]).strip()


# ─── deterministic chart-directive injection ───────────────────────────────────
#
# The chat can render real charts when an agent embeds a ```chart directive in
# its prose (parsed by the frontend, which supplies the data — the directive names
# only a chart type + selector, never numbers). The LLM (Haiku) does not reliably
# emit the directive on its own — it falls back to "I can't draw charts" or drops
# the instruction — so the backend injects a deterministic directive when the model
# didn't emit one. Because the directive contains no data, the backend is as
# authoritative as the model here; this just makes the behaviour reliable.

_CHART_FENCE = "```chart"
# Matches a whole ```chart … ``` fenced block (non-greedy to the first close).
_CHART_FENCE_RE = re.compile(r"```chart\b.*?```", re.DOTALL)
# Visualisation verbs that mark an explicit "show me a chart" request.
_VIZ_VERB_RE = re.compile(
    r"\b(chart|graph|plot|visuali[sz]e|visuali[sz]ation|pareto|histogram|"
    r"scatter|box\s?plot|pie|donut|bar\s?chart|waterfall|timeline)\b",
    re.IGNORECASE,
)
# Generic "worst/slowest" phrasing → default to the top (worst) action.
_WORST_RE = re.compile(r"\b(slow|slowest|worst|top|biggest|largest|bottleneck|heaviest)\b",
                       re.IGNORECASE)


def _ensure_chart(response_text: str, directive: dict | None, replace: bool = False) -> str:
    """Append a ```chart fence built from `directive`.

    Default (replace=False): leave a model-emitted fence untouched, and append
    only when there is none — the model's own chart wins.

    replace=True: when we hold an authoritative deterministic directive, strip
    any model-emitted fence FIRST, then append ours. The trace path uses this:
    its small model routinely emits a malformed directive (e.g. a
    widget_waterfall with no widget_name) that the frontend silently drops as
    no_widget_match — so deferring to the model's fence meant no chart rendered
    at all even though we had a correct directive in hand."""
    if not directive:
        return response_text
    text = response_text or ""
    if replace:
        text = _CHART_FENCE_RE.sub("", text).rstrip()
    elif _CHART_FENCE in text:
        return response_text
    block = "\n\n" + _CHART_FENCE + "\n" + json.dumps(directive) + "\n```\n"
    return text + block


def _resolve_trace_action(trace_input: dict, question: str) -> dict | None:
    """Pick the action the trace answer is about: an action named in the question,
    else the worst action for a generic 'slowest/worst' ask. Returns None when the
    question names a specific action we don't have (so no misleading chart is added)."""
    tops = trace_input.get("top_actions") or []
    if not tops:
        return None
    ql = (_strip_context_tag(question) or "").lower()
    for a in tops:
        name = (a.get("action_name") or "").strip()
        if name and name.lower() in ql:
            return a
    # No named action → default to the worst action (top_actions is sorted
    # worst-first) for a generic "worst/slowest" ask, an explicit visualisation
    # request ("show the waterfall / chart"), or an empty question. In all three
    # the user wants the trace agent's default subject: the slowest flagged action.
    if _WORST_RE.search(ql) or _VIZ_VERB_RE.search(ql) or not question:
        return tops[0]
    return None


def _trace_chart_directive(trace_input: dict, result: dict, question: str) -> dict | None:
    """Build a waterfall directive for a single-action trace answer.
    widget_waterfall (with the bottleneck widget) when the ask is widget/timing
    focused; otherwise the action-sequence waterfall.

    Gated on DETERMINISTIC trace_input data (can we resolve a target action?),
    NOT on the model's self-reported `widgets_found` — a small model routinely
    omits that field or emits 0, which silently suppressed every chart. The
    frontend rebuilds the waterfall from its own aggRows/rows via the selector,
    so an action_waterfall needs only a resolvable action name here."""
    action = _resolve_trace_action(trace_input, question)
    if not action:
        return None
    name = (action.get("action_name") or "").strip()
    ts   = (action.get("action_timestamp") or "").strip()
    if not name:
        return None
    ql = (_strip_context_tag(question) or "").lower()
    widget_data = trace_input.get("widget_data") or {}
    rows = widget_data.get(f"{name}::{ts}") or widget_data.get(name) or []
    if ("widget" in ql or "timing" in ql) and rows:
        bottleneck = max(rows, key=lambda w: w.get("total") or 0)
        wname = (bottleneck.get("widget_name") or "").strip()
        if wname:
            sel = {"action_name": name, "widget_name": wname}
            if ts:
                sel["action_timestamp"] = ts
            return {"family": "bespoke", "chart": "widget_waterfall",
                    "selector": sel, "title": f"Widget timing — {name}"}
    sel = {"action_name": name}
    if ts:
        sel["action_timestamp"] = ts
    return {"family": "bespoke", "chart": "action_waterfall",
            "selector": sel, "title": f"Action waterfall — {name}"}


def _root_cause_chart_directive(rc_input: dict, result: dict, question: str) -> dict | None:
    """Auto-attach an action_waterfall for the worst offending action when
    row-level flagged actions exist."""
    flagged = list(rc_input.get("flagged_actions") or [])
    if not flagged:
        # flagged_by_type may hold the rows instead
        for _k, v in (rc_input.get("flagged_by_type") or {}).items():
            if isinstance(v, list):
                flagged.extend(v)
    if not flagged:
        return None
    worst = max(flagged, key=lambda a: a.get("action_duration_ms") or 0)
    name = (worst.get("action_name") or "").strip()
    if not name:
        return {"family": "bespoke", "chart": "action_waterfall",
                "selector": "worst_offender", "title": "Worst offender waterfall"}
    ts = (worst.get("action_timestamp") or "").strip()
    sel = {"action_name": name}
    if ts:
        sel["action_timestamp"] = ts
    return {"family": "bespoke", "chart": "action_waterfall",
            "selector": sel, "title": f"Action waterfall — {name}"}


def _explorer_chart_directive(explorer_input: dict, result: dict, question: str) -> dict | None:
    """Inject a chart only when the user explicitly asked to see one. Covers the
    common, unambiguous ask (a Pareto/bar of action durations); other chart types
    are left to the agent's own directive when it emits one."""
    ql = (question or "").lower()
    if not _VIZ_VERB_RE.search(ql):
        return None
    if "pie" in ql or "donut" in ql:
        return {"family": "registry", "chartType": "pie", "data": "actions",
                "config": {"nameKey": "action_name", "valueKey": "action_duration"},
                "title": "Action durations"}
    # Default explicit-request chart: Pareto of action durations.
    return {"family": "registry", "chartType": "pareto", "data": "actions",
            "config": {"nameKey": "action_name", "valueKey": "action_duration"},
            "title": "Action duration Pareto"}
