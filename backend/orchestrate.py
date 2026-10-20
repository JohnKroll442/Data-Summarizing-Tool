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
from skills import get_skill, get_skill_for_mode

log = logging.getLogger(__name__)

BACKEND_HOST = os.getenv("BACKEND_HOST", "localhost")
BACKEND_PORT = int(os.getenv("BACKEND_PORT", "5000"))


# ─── mesh store helpers ──────────────────────────────────────────────────────
#
# Imported from mesh_store.py — the shared module both app.py and orchestrate.py
# use, avoiding a circular import. In production these would be HTTP calls.

from mesh_store import store_agent_output, read_agent_output
import mesh_store as _mesh


# ─── Post-response next-step suggestions ──────────────────────────────────────
#
# Shown after every completed turn. Each entry is a list of
# { "label": str, "question": str } objects the frontend renders as
# clickable chips. Clicking one auto-submits the question.

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
    # Only inject prior-turn context on an EXPLICIT follow-up signal (pronoun or
    # implicit-reference verb). A bare word-count heuristic ("<= 8 words")
    # misfired on independent short questions — "how many users are there?"
    # after a session drilldown got tagged with the prior session_id, which both
    # misrouted intent to CONVERSATIONAL and anchored the LLM to that one
    # session, so it answered "1 user" instead of the dataset's 48. The signal
    # set below is deliberately NARROW: hyper-common words ("it", "this", "also",
    # "too") were removed because they fire on fresh independent questions, and a
    # question that already carries its OWN concrete filter is never treated as
    # context-dependent (the self-scoped guard below) — both fixes stop the
    # injector from anchoring a new question to a stale subset.
    _followup_signals = re.search(
        r'\b(?:that|those|them|these|same|previous|prior|above|earlier'
        r'|further|deeper|continue|follow.?up'
        r'|explore|drill|expand|elaborate)\b',
        q_lower,
    )

    # Self-scoped guard: if the question names its OWN concrete filter (a known
    # user/story/action/session/date/hour/duration), it is a standalone question,
    # not a reference to the prior subset — do not inject stale prior context.
    _self_scoped = False
    try:
        import query_engine as _qe_guard
        _self_scoped = bool((_qe_guard.parse_query(question, dataset_id) or {}).get("filters"))
    except Exception:
        _self_scoped = False

    if _followup_signals and not _self_scoped:
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


# ─── Run the multi-agent pipeline ─────────────────────────────────────────────

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
    # ── Resolve follow-up references before any routing ──────────────────────
    question = _resolve_followup_references(question, dataset_id)

    log.info("Orchestrating: %s (direct_agent=%s, session=%s)",
             question[:100], direct_agent, session_id)

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

    # ── Intent classification ──────────────────────────────────────────────────
    intent_result = classify_intent(question, payload, llm_history=llm_history)
    intent        = intent_result.get("intent", "FULL_ANALYSIS")
    ack           = intent_result.get("acknowledgement", "Analysing your dataset...")

    log.info("Intent: %s", intent)

    # ── Deterministic guard: a scoped-subset follow-up that asks for a NEW
    # breakdown / ranking / count ("which users were among those flagged
    # actions?", "break those down by story", "who were they?") must be answered
    # by DATA_EXPLORATION, never CONVERSATIONAL. The conversational path recomputes
    # from stored rows — which carry flags=null and are matched on an EXACT hour,
    # not the inherited range — so it contradicts the breakdown the user just saw
    # (e.g. reporting "0 flagged" per user right after showing 94 flagged). Only
    # DATA_EXPLORATION runs the flag-aware, scope-inheriting machinery.
    if intent == "CONVERSATIONAL" and _is_followup_reference(question):
        import re as _re
        if _re.search(r"\b(?:which|what|who|how\s+many|list|show|rank|break\s+"
                      r"(?:it|them|these|those)?\s*down|by\s+(?:user|story|action|"
                      r"session|hour|day|type))\b", question.lower()):
            log.info("Routing override: scoped follow-up reference → DATA_EXPLORATION "
                     "(was CONVERSATIONAL)")
            intent = "DATA_EXPLORATION"

    agent_outputs  = {}
    response_parts = [ack, ""]
    session_notes  = []

    if intent == "CONVERSATIONAL":
        response_parts.append(
            _conversational_answer(question, payload, llm_history=llm_history,
                                   dataset_id=dataset_id)
        )
    else:
        # Every analysis intent is now answered by the single unified agent.
        # _build_unified_input maps the intent → agent_mode and assembles the
        # right data slice (reusing the former per-intent builders); unknown
        # intents fall back to anomaly_summary.
        if intent not in _ANALYSIS_INTENTS:
            log.warning("Unknown intent '%s' — falling back to ANOMALY_SUMMARY", intent)
            intent = "ANOMALY_SUMMARY"
        unified_input = _build_unified_input(question, payload, dataset_id, intent,
                                             llm_history=llm_history)
        agent_mode = unified_input["agent_mode"]
        out = run_unified_agent(unified_input, question)
        store_name, out_key = _MODE_MESH[agent_mode]
        agent_outputs[out_key] = out
        response_parts.append(out.get("_response_text", ""))
        session_notes.extend(out.get("session_notes", []))
        _guard_store(dataset_id, store_name, out)

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
    """Call the analyst directly, bypassing intent classification.

    `agent_key` may be the new "unified_agent" or any of the former specialist
    keys (kept in _DIRECT_AGENT_INTENT_MAP for backward compatibility). Each maps
    to an intent → agent_mode, then runs the single unified agent."""
    intent = _DIRECT_AGENT_INTENT_MAP.get(agent_key, "FULL_ANALYSIS")
    log.info("Direct dispatch to %s (intent: %s)", agent_key, intent)

    agent_outputs = {}
    session_notes = []
    response_text = ""

    if intent == "CONVERSATIONAL":
        response_text = _conversational_answer(question, payload,
                                               llm_history=llm_history,
                                               dataset_id=dataset_id)
    else:
        if intent not in _ANALYSIS_INTENTS:
            intent = "FULL_ANALYSIS"
        unified_input = _build_unified_input(question, payload, dataset_id, intent,
                                             llm_history=llm_history)
        agent_mode = unified_input["agent_mode"]
        out = run_unified_agent(unified_input, question)
        store_name, out_key = _MODE_MESH[agent_mode]
        agent_outputs[out_key] = out
        response_text = out.get("_response_text", "")
        session_notes.extend(out.get("session_notes", []))
        _guard_store(dataset_id, store_name, out)

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
            content = msg.get("content", "")[:1000]   # wide enough for ranking tables
            prior_turns.append(f"[{role}]: {content}")
        payload_context["prior_conversation"] = prior_turns

    # Include the last agent output summary for reference resolution. This lets
    # the Orchestrator understand "rank 2" → "user KIZUMI (33 flagged)" when the
    # previous turn showed a ranked table. All agent kinds are consulted (not just
    # explorer/root-cause/anomaly) so a follow-up after a KPI / full / trace turn
    # ("drill into that") still carries reference context.
    _ds_id = payload.get("meta", {}).get("dataset_id")
    if _ds_id:
        import mesh_store as _ms
        for _agent_name, _prev in _ms.agent_outputs_by_recency(
            _ds_id, ("explorer-agent", "root-cause-agent", "anomaly-agent",
                     "trace-agent", "stats-agent", "narrator")
        ):
            if _prev and (_prev.get("top_results") or _prev.get("question_answered")):
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
        # Classification failed — fall back to CONVERSATIONAL, NOT ANOMALY_SUMMARY.
        # ANOMALY_SUMMARY emits dataset-wide anomaly totals, which is a
        # confidently-WRONG answer for any scoped question (the "558 of 2070"
        # failure mode): a user asking "how many of alice's actions after 4 PM
        # were flagged?" would get the whole-dataset total if a transient LLM or
        # JSON-parse error forced the fallback. CONVERSATIONAL answers from
        # session history + on-demand aggregation (scoped) and can honestly say it
        # is unsure, so it never fabricates a dataset-wide number. Traceback is
        # logged so a persistently misrouting classifier stays debuggable.
        log.exception("Intent classification failed — defaulting to CONVERSATIONAL")
        return {"intent": "CONVERSATIONAL",
                "acknowledgement": "Let me take a look at that..."}


# ─── individual agents ────────────────────────────────────────────────────────

# ─── unified agent: deterministic prep (replaces stats/anomaly pre-passes) ────
# The former Stats and Anomaly agents were pass-through formatters — they ran no
# analysis, only reshaped kpis[]/counts for the next agent. We reproduce that
# reshaping in code so ROOT_CAUSE and FULL_ANALYSIS no longer need those extra
# LLM calls.

# Canonical anomaly type labels — mirrors
# skills/unified-agent/references/anomaly-type-reference.md (single source of
# truth). Keep in sync if the catalogue changes.
_ANOMALY_LABELS = {
    "slow_action":       "Slow action",
    "large_offset":      "Large offset",
    "straggler":         "Straggler widget",
    "fragmented":        "Fragmented",
    "offset_overrun":    "Offset > Duration",
    "negative_phase":    "Negative phase",
    "component_overrun": "Component overrun",
    "frontend_bound":    "Frontend",
    "network_bound":     "Network",
    "backend_bound":     "Backend",
}
_PHASE_KEYS = {"frontend_bound", "network_bound", "backend_bound"}

# Natural-language phrasings → canonical anomaly type key. Lets DATA_EXPLORATION
# scope a count / ranking / listing to one anomaly type ("how many straggler
# actions did X have", "which hour had the most backend-bound actions"). Flags
# are not stored on rows, so this scope is computed from the payload's
# flagged_by_type buckets, not from query_engine row filters.
_ANOMALY_SYNONYMS = {
    "slow_action":       ["slow action", "slow_action", "slow-action", "slow actions"],
    "large_offset":      ["large offset", "large_offset", "large-offset"],
    "straggler":         ["straggler", "stragglers"],
    "fragmented":        ["fragmented", "fragmentation"],
    "offset_overrun":    ["offset overrun", "offset_overrun", "offset > duration",
                          "offset exceed", "offset-overrun"],
    "negative_phase":    ["negative phase", "negative_phase", "negative-phase"],
    "component_overrun": ["component overrun", "component_overrun", "component-overrun"],
    "frontend_bound":    ["frontend bound", "frontend-bound", "frontend_bound",
                          "frontend bottleneck", "render bound", "render-bound",
                          "frontend dominant", "frontend-dominant", "dominant frontend",
                          "frontend heavy", "frontend-heavy", "frontend phase dominant"],
    "network_bound":     ["network bound", "network-bound", "network_bound",
                          "network bottleneck",
                          "network dominant", "network-dominant", "dominant network",
                          "network heavy", "network-heavy", "network phase dominant"],
    "backend_bound":     ["backend bound", "backend-bound", "backend_bound",
                          "backend bottleneck",
                          "backend dominant", "backend-dominant", "dominant backend",
                          "backend heavy", "backend-heavy", "backend phase dominant"],
}
# Longest synonym first so "backend bound" wins over a bare "backend".
_ANOMALY_SYN_ORDERED = sorted(
    ((syn, key) for key, syns in _ANOMALY_SYNONYMS.items() for syn in syns),
    key=lambda sk: -len(sk[0]),
)


def _detect_anomaly_type(question: str) -> str | None:
    """Return the canonical anomaly type key named in the question, or None."""
    q = (question or "").lower()
    for syn, key in _ANOMALY_SYN_ORDERED:
        if syn in q:
            return key
    return None


# Widget-timing phrasings that _compute_widget_metric_rankings is the right
# source for ("which user has the most backend time", "highest offset",
# "slowest-loading widgets"). Used to strip the competing flagged / activity
# rankings so metric_rankings stands alone (double-output fix, Case 3).
_TIMING_METRIC_RE = re.compile(
    r'\b(?:offset|render(?:ing)?|network|backend|frontend)\b[^.?!]*\b'
    r'(?:time|ms|duration|latency|wait)\b'
    r'|\b(?:most|highest|longest|biggest|top)\b[^.?!]*\b'
    r'(?:offset|render(?:ing)?|network|backend|frontend)\b'
    r'|\bslowest[- ]loading\b'
    r'|\bwidget[- ]timing\b',
    re.IGNORECASE,
)


def _detect_timing_metric(question: str) -> bool:
    """True when the question is a widget-timing/metric ranking question that
    metric_rankings answers — so the flagged and activity rankings are competing
    noise and should be stripped."""
    return bool(_TIMING_METRIC_RE.search(question or ""))


def _detect_timing_metric_name(question: str) -> str:
    """Which phase the timing question is about → 'offset'|'render'|'network'|
    'backend'. Defaults to 'offset' when a widget-timing question names no
    specific phase. Used to SORT metric_rankings by the requested metric so
    'most backend time' ranks by backend, not by the offset default."""
    q = (question or "").lower()
    # frontend/render are the same phase in widget timing (render time).
    if re.search(r"\bback\s*end\b", q):
        return "backend"
    if re.search(r"\bnetwork\b", q):
        return "network"
    if re.search(r"\b(?:render(?:ing)?|front\s*end)\b", q):
        return "render"
    return "offset"


def _compute_anomaly_type_scope(raw_fbt: dict, anomaly_type: str,
                                scoped_user=None, scoped_story=None,
                                scoped_action=None, scoped_session=None,
                                time_filters=None) -> dict | None:
    """Authoritative anomaly-type-scoped view built from flagged_by_type.

    flagged_by_type[type] holds every flagged action of that type (each listed
    once per type), so it is the only source that can answer "how many <type>
    actions" / "which <dimension> has the most <type> actions" / "list the
    <type> actions" — stored rows carry flags=null. Optionally narrows to a
    user / story / action / session the question also names, AND to a time /
    duration window (time_filters, applied via query_engine.filter_rows — the
    single filter source — so "how many straggler actions after 4 PM" counts
    only that window, not the dataset-wide total). Dedups defensively by
    (action_name, action_timestamp, session_id) and returns per-dimension and
    per-hour breakdowns plus a capped sample list.
    """
    acts = raw_fbt.get(anomaly_type)
    if not isinstance(acts, list):
        return None

    def _keep(a):
        if scoped_user    and a.get("user")        != scoped_user:    return False
        if scoped_story   and a.get("story_name")  != scoped_story:   return False
        if scoped_action  and a.get("action_name") != scoped_action:  return False
        if scoped_session and a.get("session_id")  != scoped_session: return False
        return True

    import query_engine as _qe
    # Apply any time/duration window first via the single filter source, then the
    # entity narrowing above.
    pool = _qe.filter_rows(acts, time_filters) if time_filters else acts

    seen, uniq = set(), []
    for a in pool:
        if not _keep(a):
            continue
        k = (a.get("action_name", ""), a.get("action_timestamp", ""),
             a.get("session_id", ""))
        if k in seen:
            continue
        seen.add(k)
        uniq.append(a)

    def _rank(field):
        counts = {}
        for a in uniq:
            counts[a.get(field) or "unknown"] = counts.get(a.get(field) or "unknown", 0) + 1
        return [{field: name, "count": n}
                for name, n in sorted(counts.items(), key=lambda kv: -kv[1])][:20]

    by_hour = {}
    for a in uniq:
        dt = _qe.parse_ts(a.get("action_timestamp"))
        if dt is not None:
            by_hour[dt.hour] = by_hour.get(dt.hour, 0) + 1

    scope = {k: v for k, v in (("user", scoped_user), ("story", scoped_story),
                               ("action", scoped_action), ("session", scoped_session)) if v}
    return {
        "anomaly_type": anomaly_type,
        "label":        _ANOMALY_LABELS.get(anomaly_type, anomaly_type),
        "total":        len(uniq),
        "scoped_to":    scope or None,
        "by_user":      _rank("user"),
        "by_story":     _rank("story_name"),
        "by_action":    _rank("action_name"),
        "by_session":   _rank("session_id"),
        "by_hour":      [{"hour": f"{h:02d}:00", "count": n}
                         for h, n in sorted(by_hour.items())],
        "actions":      uniq[:20],
    }
_KPI_KEYMAP = {
    "total_actions":   "total_actions",
    "over_2m":         "over_threshold",
    "median_duration": "median_duration",
    "p90_duration":    "p90_duration",
    "p95_duration":    "p95_duration",
}


def _threshold_label(meta: dict | None) -> str:
    ms = (meta or {}).get("slow_action_threshold_ms")
    if not ms:
        return "not available"
    try:
        ms = int(ms)
    except (TypeError, ValueError):
        return "not available"
    return f"{ms // 60000}m" if ms % 60000 == 0 else f"{ms // 1000}s"


def _map_kpis_to_stats_output(kpis: list, meta: dict | None) -> dict:
    """Deterministic equivalent of the former Stats Agent (no analysis — maps
    kpis[] into the stats-agent output shape the narrator/full_summary expects)."""
    out = {"total_actions": None, "over_threshold": None, "median_duration": None,
           "p90_duration": None, "p95_duration": None}
    for item in kpis or []:
        okey = _KPI_KEYMAP.get(item.get("key"))
        if not okey:
            continue
        val = item.get("value")
        out[okey] = None if val in (None, "", "—") else val
    present = [k for k, v in out.items() if v is not None]
    missing = [k for k, v in out.items() if v is None]
    return {"agent": "stats-agent", "status": "CONFIRMED", "kpis": out,
            "keys_present": present, "keys_missing": missing,
            "threshold_label": _threshold_label(meta), "session_notes": []}


def _derive_active_types(counts: dict) -> tuple[list, list]:
    """Deterministic equivalent of the former Anomaly Agent typing step. Returns
    (active_headline_types, active_phase_types) — objects sorted by actions desc,
    labels from _ANOMALY_LABELS, pct as integer percent."""
    headline, phase = [], []
    for key, v in (counts or {}).items():
        if not isinstance(v, dict):
            continue
        actions = v.get("actions", 0) or 0
        if actions <= 0:
            continue
        pct = v.get("pct", 0) or 0
        pct_int = round(pct * 100) if pct <= 1 else round(pct)
        entry = {"key": key, "label": _ANOMALY_LABELS.get(key, key),
                 "actions": actions, "pct": pct_int}
        (phase if key in _PHASE_KEYS else headline).append(entry)
    headline.sort(key=lambda e: -e["actions"])
    phase.sort(key=lambda e: -e["actions"])
    return headline, phase


def _build_anomaly_output(anom: dict) -> dict:
    """Deterministic anomaly-agent output shape (for the full_summary input)."""
    headline, phase = _derive_active_types(anom.get("counts", {}))
    return {"agent": "anomaly-agent", "status": "CONFIRMED",
            "total_actions": anom.get("total_actions", 0),
            "total_flagged": anom.get("total_flagged", {}),
            "active_headline_types": headline, "active_phase_types": phase,
            "excluded_by_user": [], "types_checked": 10,
            "types_active": len(headline), "session_notes": []}


# agent_mode → (mesh store name, agent_outputs key). Keeping the former per-agent
# names means all cross-agent mesh enrichment and follow-up resolution keep
# working unchanged after the merge.
_MODE_MESH = {
    "kpi_summary":      ("stats-agent",      "stats"),
    "anomaly_summary":  ("anomaly-agent",    "anomaly"),
    "root_cause":       ("root-cause-agent", "root_cause"),
    "data_exploration": ("explorer-agent",   "explorer"),
    "widget_trace":     ("trace-agent",      "trace"),
    "full_summary":     ("narrator",         "narrator"),
}

# Analysis intents the unified agent handles (CONVERSATIONAL is handled separately).
_ANALYSIS_INTENTS = {
    "KPI_SUMMARY", "ANOMALY_SUMMARY", "ROOT_CAUSE_ANALYSIS",
    "DATA_EXPLORATION", "WIDGET_TRACE", "FULL_ANALYSIS",
}


def _build_unified_input(question, payload, dataset_id, intent, llm_history=None) -> dict:
    """Assemble the single analyst input for an intent. Reuses the existing
    per-intent builders and adds `agent_mode`; deterministic prep replaces the
    former stats/anomaly pre-call agents."""
    anom = payload.get("anomalies", {}) if isinstance(payload, dict) else {}

    if intent == "KPI_SUMMARY":
        return {"agent_mode": "kpi_summary",
                "kpis": payload.get("kpis", []),
                "meta": payload.get("meta", {}),
                "user_request": question}

    if intent == "ANOMALY_SUMMARY":
        _counts = anom.get("counts", {})
        # Scope to a single named type so the agent doesn't dump the full
        # breakdown AND then re-explain the one type the question asked about
        # (double output). Only narrow when the named type is actually present.
        _at = _detect_anomaly_type(question)
        if _at and _at in _counts:
            _counts = {_at: _counts[_at]}
        return {"agent_mode": "anomaly_summary",
                "anomalies": {"counts":        _counts,
                              "total_flagged": anom.get("total_flagged", {}),
                              "total_actions": anom.get("total_actions", 0)},
                "user_request": question}

    if intent == "ROOT_CAUSE_ANALYSIS":
        headline, phase = _derive_active_types(anom.get("counts", {}))
        full_fbt      = anom.get("flagged_by_type", {}) or {}
        all_flagged   = anom.get("flagged_actions", []) or []
        total_flagged = anom.get("total_flagged", {})
        total_actions = anom.get("total_actions", 0)

        # ── Entity / time / duration scope (single filter source) ─────────────
        # When the question narrows to a user / story / action / session / time
        # window / duration ("root causes for the flagged actions of NROS"),
        # filter the flagged data to THAT subset through query_engine.filter_rows
        # — the same source of truth the Explorer uses. Without this the agent
        # only ever saw a dataset-wide sample (10 rows/type + top-50 by duration)
        # that routinely omitted the named entity, so it reported the entity as
        # "missing" and fell back to dataset-wide root causes. Flagged rows carry
        # user/story/session/action + timestamp + duration, so filter_rows honours
        # exactly those keys (dominant_phase / end_hour are intentionally excluded
        # — flagged rows lack those fields).
        scope_applied = None
        _rc_scope = {}
        if dataset_id:
            try:
                import query_engine as _qe
                _spec = _qe.parse_query(_strip_context_tag(question), dataset_id)
                if _spec:
                    _ROW_KEYS = ("user", "users", "story", "action", "session",
                                 "date", "hour_of_day", "hour_min", "hour_max",
                                 "duration_min_ms", "duration_max_ms")
                    _rc_scope = {k: v for k, v in _spec.get("filters", {}).items()
                                 if k in _ROW_KEYS}
            except Exception:
                log.exception("Root cause scope parse failed — continuing dataset-wide")

        if _rc_scope:
            import query_engine as _qe
            import mesh_store as _ms
            # Scope every type array AND the flat flagged list through the one
            # filter source; drop types with no scoped rows.
            scoped_fbt = {k: _qe.filter_rows(v, _rc_scope)
                          for k, v in full_fbt.items() if isinstance(v, list)}
            scoped_fbt = {k: v for k, v in scoped_fbt.items() if v}
            scoped_flagged = _qe.filter_rows(all_flagged, _rc_scope)

            # Distinct flagged-action count across all types in scope (an action
            # with several anomaly types appears in several arrays — dedup it).
            _seen = set()
            for a in scoped_flagged:
                _seen.add((a.get("action_name", ""), a.get("action_timestamp", ""),
                           a.get("session_id", "")))
            scoped_flagged_count = len(_seen)

            # Denominator: the entity's TOTAL actions under the identical filter,
            # recounted from the stored rows so numerator/denominator agree.
            _stored = (_ms.get_dataset(dataset_id) or {}).get("rows", []) or []
            scope_total = (len(_qe.filter_rows(_stored, _rc_scope))
                           if _stored else None)

            # Rebuild the headline/phase type lists from the SCOPED per-type
            # counts (full arrays are authoritative, so len after filtering is the
            # scoped action count), pct relative to the scope denominator.
            def _mk(key, cnt):
                pct = round(100 * cnt / scope_total) if scope_total else 0
                return {"key": key, "label": _ANOMALY_LABELS.get(key, key),
                        "actions": cnt, "pct": pct}
            headline = sorted(
                [_mk(k, len(v)) for k, v in scoped_fbt.items() if k not in _PHASE_KEYS],
                key=lambda e: -e["actions"])
            phase = sorted(
                [_mk(k, len(v)) for k, v in scoped_fbt.items() if k in _PHASE_KEYS],
                key=lambda e: -e["actions"])

            total_actions = scope_total if scope_total is not None else total_actions
            total_flagged = {"actions": scoped_flagged_count,
                             "pct": (round(100 * scoped_flagged_count / scope_total)
                                     if scope_total else None)}
            full_fbt   = scoped_fbt
            all_flagged = scoped_flagged
            _scope_desc = ", ".join(f"{k}={v}" for k, v in _rc_scope.items())
            scope_applied = {"filters": _rc_scope, "description": _scope_desc,
                             "flagged_count": scoped_flagged_count,
                             "scope_total_actions": scope_total}
            log.info("Root cause: scoped to %s — flagged=%d/%s types=%d",
                     _scope_desc, scoped_flagged_count, scope_total, len(scoped_fbt))

        # Scope to a single named type for the same reason as ANOMALY_SUMMARY:
        # "tell me more about the fragmented anomaly" must explain ONLY
        # fragmented, not emit the all-types tables and then the fragmented
        # drilldown on top of them. Only narrow when the named type is active
        # (present in one of the derived lists); an inactive type leaves the
        # full view so the agent can still explain what's there. Composes with
        # entity scope above (e.g. "NROS's straggler actions").
        _at = _detect_anomaly_type(question)
        if _at and any(e["key"] == _at for e in headline + phase):
            headline = [e for e in headline if e["key"] == _at]
            phase    = [e for e in phase    if e["key"] == _at]
            full_fbt = {k: v for k, v in full_fbt.items() if k == _at}

        return {
            "agent_mode":            "root_cause",
            "active_headline_types": headline,
            "active_phase_types":    phase,
            "total_flagged":         total_flagged,
            "total_actions":         total_actions,
            "flagged_by_type":       full_fbt,   # FULL (scoped if narrowed) — runner slims for LLM
            "flagged_actions":       _sorted_flagged(all_flagged)[:50],
            "scope_applied":         scope_applied,
            "trace_output":          read_agent_output(dataset_id, "trace-agent"),
            "explorer_context":      _get_explorer_context(dataset_id),
            "user_request":          question,
        }

    if intent == "DATA_EXPLORATION":
        ei = _build_explorer_input(question, payload, dataset_id, llm_history=llm_history)
        ei["agent_mode"] = "data_exploration"
        ei.setdefault("user_request", question)
        return ei

    if intent == "WIDGET_TRACE":
        ti = _build_trace_input(question, payload, dataset_id)
        ti["agent_mode"] = "widget_trace"
        return ti

    if intent == "FULL_ANALYSIS":
        flagged = _sorted_flagged(anom.get("flagged_actions", []))
        return {
            "agent_mode":         "full_summary",
            "stats":              _map_kpis_to_stats_output(payload.get("kpis", []),
                                                            payload.get("meta", {})),
            "anomalies":          _build_anomaly_output(anom),
            "meta":               payload.get("meta", {}),
            "top_flagged_action": flagged[0] if flagged else None,
            "trace_output":       read_agent_output(dataset_id, "trace-agent"),
            "user_request":       question,
        }

    # Fallback → anomaly summary
    return {"agent_mode": "anomaly_summary",
            "anomalies": {"counts":        anom.get("counts", {}),
                          "total_flagged": anom.get("total_flagged", {}),
                          "total_actions": anom.get("total_actions", 0)},
            "user_request": question}


# ── Analyst input token-budget backstop ──────────────────────────────────────
# The model's hard input limit is 200k tokens. The system prompt (~15k) and the
# response share that budget, so we cap the serialized analyst input at ~110k
# tokens (~440k chars at ~4 chars/token). The per-section caps in the builders
# keep a normal input well under this; this is the catch-all that guarantees a
# single call can never overflow — on any mode, and as the dataset grows — by
# trimming the heaviest list sections (least→most essential) until it fits.
# Scoped summaries, aggregation, anomaly_type_scope totals and the *_total count
# fields are never trimmed: they carry the authoritative numbers.
_INPUT_CHAR_BUDGET = 440_000

_BUDGET_TRIMS = (
    # (top-level key, nested key or None → cap each list under it, cap items)
    ("metric_rankings",              "by_widget",  25),
    ("metric_rankings",              "by_session", 25),
    ("metric_rankings",              "by_action",  25),
    ("metric_rankings",              "by_story",   25),
    ("metric_rankings",              "by_user",    25),
    ("flagged_by_type",              None,          3),
    ("flagged_action_types_ranking", None,         25),
    ("flagged_stories_ranking",      None,         25),
    ("flagged_users_ranking",        None,         25),
    ("detail_rows",                  None,         50),
)


def _trim_section(obj, cap):
    """Cap a list, or every list value inside a dict, to `cap` items."""
    if isinstance(obj, list):
        return obj[:cap]
    if isinstance(obj, dict):
        return {k: (v[:cap] if isinstance(v, list) else v) for k, v in obj.items()}
    return obj


def _fit_input_to_budget(d: dict) -> dict:
    """Trim the heaviest sections of an analyst input until it fits the budget."""
    if not isinstance(d, dict):
        return d
    size = len(json.dumps(d, default=str))
    if size <= _INPUT_CHAR_BUDGET:
        return d
    log.warning("Analyst input ~%dk chars exceeds budget (~%dk) — trimming heavy sections.",
                size // 1000, _INPUT_CHAR_BUDGET // 1000)
    out = dict(d)
    for top, nested, cap in _BUDGET_TRIMS:
        if size <= _INPUT_CHAR_BUDGET:
            break
        sect = out.get(top)
        if not isinstance(sect, (list, dict)):
            continue
        before = len(json.dumps(sect, default=str))
        if nested is None:
            out[top] = _trim_section(sect, cap)
        elif isinstance(sect, dict) and isinstance(sect.get(nested), list):
            sect = dict(sect)
            sect[nested] = sect[nested][:cap]
            out[top] = sect
        else:
            continue
        after = len(json.dumps(out[top], default=str))
        if after < before:
            log.warning("  trimmed %s%s to %d items (-%dk chars)",
                        top, f".{nested}" if nested else "", cap, (before - after) // 1000)
        size = len(json.dumps(out, default=str))
    if size > _INPUT_CHAR_BUDGET:
        log.warning("Analyst input still ~%dk chars after trimming — proceeding; the LLM "
                    "call may fail if the total exceeds the 200k hard limit.", size // 1000)
    return out


def run_unified_agent(unified_input: dict, question: str = "") -> dict:
    """Single analyst call. `agent_mode` selects the behaviour. Each branch
    mirrors the former agent's post-processing (phase-drill fast path, chart
    directives) but calls the one merged skill prompt. The output is tagged with
    the former agent name so mesh enrichment is unchanged."""
    mode = unified_input.get("agent_mode")
    skill = get_skill_for_mode(mode)
    unified_input = _fit_input_to_budget(unified_input)

    # ── Root cause: deterministic phase-scoped fast path (no LLM) ─────────────
    if mode == "root_cause":
        full_fbt = unified_input.get("flagged_by_type", {}) or {}
        drill = _build_phase_drill(question, full_fbt)
        if drill is not None:
            return _phase_scoped_result(drill, unified_input)
        # Normal path: slim flagged_by_type to 10/type for the LLM.
        llm_input = {**unified_input,
                     "flagged_by_type": {k: v[:10] for k, v in full_fbt.items()
                                         if isinstance(v, list)}}
        resp   = call_llm(skill, json.dumps(llm_input, indent=2))
        result = _safe_json(resp, "root-cause-agent")
        prose  = _prose(resp)
        ql = _strip_context_tag(question or "").lower()
        wants_chart = bool(_VIZ_VERB_RE.search(ql) or _WORST_RE.search(ql))
        if wants_chart:
            directive = _root_cause_chart_directive(unified_input, result, question)
        else:
            directive = None
            prose = _CHART_FENCE_RE.sub("", prose).rstrip()
        result["_response_text"] = _ensure_chart(prose, directive)
        return result

    resp   = call_llm(skill, json.dumps(unified_input, indent=2))

    if mode == "data_exploration":
        result = _safe_json(resp, "explorer-agent")
        prose  = _prose(resp)
        directive = _explorer_chart_directive(unified_input, result,
                                              unified_input.get("user_request")
                                              or unified_input.get("question", ""))
        result["_response_text"] = _ensure_chart(prose, directive)
        return result

    if mode == "widget_trace":
        result = _safe_json(resp, "trace-agent")
        prose  = _prose(resp)
        directive = _trace_chart_directive(unified_input, result,
                                           unified_input.get("question", ""))
        # replace=True: our deterministic directive overrides the model's fence.
        result["_response_text"] = _ensure_chart(prose, directive, replace=True)
        return result

    # kpi_summary / anomaly_summary / full_summary — no chart post-processing.
    store_name = _MODE_MESH.get(mode, ("unified-agent", ""))[0]
    result = _safe_json(resp, store_name)
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
    """Back-compat shim — delegates to the unified agent in root_cause mode.
    (The former standalone root-cause skill is merged into skills/unified-agent.)"""
    ui = {**rc_input, "agent_mode": "root_cause"}
    if question and "user_request" not in ui:
        ui["user_request"] = question
    return run_unified_agent(ui, question)


def run_explorer_agent(explorer_input: dict) -> dict:
    """Back-compat shim — delegates to the unified agent in data_exploration mode."""
    ui = {**explorer_input, "agent_mode": "data_exploration"}
    ui.setdefault("user_request", explorer_input.get("question", ""))
    return run_unified_agent(ui, explorer_input.get("question", ""))


def run_narrator(narrator_input: dict, question: str = "") -> dict:
    """Back-compat shim — delegates to the unified agent in full_summary mode."""
    ui = {**narrator_input, "agent_mode": "full_summary"}
    if question and "user_request" not in ui:
        ui["user_request"] = question
    return run_unified_agent(ui, question)


def run_trace_agent(trace_input: dict) -> dict:
    """Back-compat shim — delegates to the unified agent in widget_trace mode."""
    ui = {**trace_input, "agent_mode": "widget_trace"}
    return run_unified_agent(ui, trace_input.get("question", ""))


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
    """Resolve a deictic time reference OR a prior-subset reference in a follow-up.

    When the CURRENT question refers to a time established in a PRIOR turn
    ("that time", "that hour", "that period/window", "then") — or references the
    previous flagged subset ("those 33 flagged actions", "of the flagged ones")
    — but names no explicit time of its own, inherit the hour/date from the most
    recent prior USER turn that named one and append it as an explicit "hour N" /
    "on YYYY-MM-DD" clause. The deterministic parser (query_engine.parse_query,
    _fetch_detail_rows) only ever sees the current question string, so without
    this rewrite a follow-up like "show me NROS actions during that time" loses
    the hour-11 scope from the previous turn and the row list stops matching
    the breakdown count the user just saw.

    Returns the question unchanged unless ALL of: (a) it uses a deictic time
    phrase OR references the prior flagged subset, (b) it names no explicit hour
    of its own, and (c) a prior user turn named an explicit hour/date. Idempotent
    — a rewritten question already carries an explicit hour, so re-running it is a
    no-op.
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
    # Also inherit when the follow-up references the PRIOR scoped subset itself
    # ("which users were among those 33 flagged actions", "of the 33 flagged
    # actions", "those flagged ones"). That subset was defined by the previous
    # turn's time/date scope, so re-apply it. Without this the question parses as
    # an UNSCOPED ranking and the explorer returns the dataset-wide list (the
    # "43 users accounted for 33 flagged actions" contradiction).
    subset_ref = re.search(
        r"\bthose\s+flagged\b"
        r"|\bthe\s+\d+\s+flagged\b"
        r"|\b(?:those|these)\s+(?:\d+\s+)?(?:flagged\s+)?(?:actions?|ones?)\b"
        r"|\b(?:among|of|from|within|out\s+of)\s+(?:those|these|the)\s+"
        r"(?:\d+\s+)?(?:flagged\s+)?(?:actions?|ones?)\b",
        q_lower,
    )
    if not deictic and not subset_ref:
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


# Reference phrases that mark a question as a CONTEXT-DEPENDENT follow-up whose
# scope should be inherited from the prior turn ("those 33 flagged actions", "the
# slow ones", "that window", "them", "the same users"). Deliberately NOT firing
# on bare common words — a question with no reference phrase is treated as a new,
# independent question (see the over-injection incident noted in
# _resolve_followup_references).
_REFERENCE_RE = re.compile(
    r"\b(?:those|these|them)\b"
    r"|\b(?:the\s+same|same|previous|prior|earlier|aforementioned)\b"
    r"|\b(?:that|this)\s+(?:hour|time|period|window|time\s*frame|timeframe|moment"
    r"|point|set|group|subset|day|range|window)\b"
    r"|\bthe\s+\d+\s+(?:flagged|actions?|ones?)\b"
    r"|\b(?:the|those|these)\s+(?:flagged|slow|slowest|offending|affected|anomalous)"
    r"\s+(?:actions?|ones?)\b",
    re.IGNORECASE,
)


def _is_followup_reference(question: str) -> bool:
    return bool(_REFERENCE_RE.search(question or ""))


def _inherit_prior_scope(question: str, llm_history: list, dataset_id) -> dict:
    """Structured cross-turn scope inheritance.

    When the current question is a CONTEXT-DEPENDENT follow-up (names a reference
    phrase) but leaves one or more scope dimensions unset, inherit those
    dimensions from the most recent prior USER turn that named a scope. Unlike the
    old hour-only text-append (_inherit_time_context), this carries EVERY
    dimension query_engine understands — hour RANGE (hour_min/hour_max), date,
    duration, entity (user/story/action/session) — plus the anomaly type, by
    re-parsing the prior turn's own text. Returns
    {"filters": {<inherited only>}, "anomaly_type": str|None}; empty when the
    current question is not a follow-up reference.
    """
    out = {"filters": {}, "anomaly_type": None}
    if not question or not llm_history or not dataset_id:
        return out
    if not _is_followup_reference(question):
        return out
    try:
        import query_engine as _qe
    except Exception:
        return out
    self_filters = (_qe.parse_query(question, dataset_id) or {}).get("filters", {}) or {}
    self_anom = _detect_anomaly_type(question)
    for msg in reversed(llm_history):
        if msg.get("role") != "user":
            continue
        prior = _strip_context_tag(msg.get("content") or "")  # tags never re-parsed
        if not prior:
            continue
        pfilters = (_qe.parse_query(prior, dataset_id) or {}).get("filters", {}) or {}
        panom = _detect_anomaly_type(prior)
        if not pfilters and not panom:
            continue
        for k, v in pfilters.items():
            if k not in self_filters:
                out["filters"][k] = v
        if self_anom is None and panom:
            out["anomaly_type"] = panom
        if out["filters"] or out["anomaly_type"]:
            log.info("Follow-up scope inherited: filters=%s anomaly_type=%s",
                     out["filters"], out["anomaly_type"])
        break  # most recent scoped prior turn wins
    return out


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

    # Strip the enrichment tag so the deterministic parsers never match an
    # injected prior-turn entity name as a filter. Cross-turn scope is inherited
    # STRUCTURALLY below (every dimension, incl. hour ranges) rather than via the
    # old hour-only text append.
    scoped_question = _strip_context_tag(question)
    _inherited = _inherit_prior_scope(scoped_question, llm_history, dataset_id)
    _inherited_filters = _inherited.get("filters", {})
    _inherited_anom    = _inherited.get("anomaly_type")

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

    # Parse the question's filters once up front so the cross-dimensional path
    # (which runs before the aggregation parse below) can honor a time/duration
    # window. _TD_KEYS are the keys flagged_actions can satisfy (they carry
    # timestamp + duration but not phase/end fields). Inherited time/duration
    # scope is merged in so a follow-up ("which users on story X in that window")
    # keeps the prior window.
    _TD_KEYS = ("date", "hour_of_day", "hour_min", "hour_max",
                "duration_min_ms", "duration_max_ms")
    _early_time_dur = {}
    if dataset_id:
        try:
            import query_engine as _qe0
            _early_spec = _qe0.parse_query(scoped_question, dataset_id)
            if _early_spec:
                _early_time_dur = {k: v for k, v in _early_spec.get("filters", {}).items()
                                   if k in _TD_KEYS}
        except Exception:
            _early_time_dur = {}
    # Merge inherited time/duration scope (fills only dims the current question
    # did not set itself).
    for _k, _v in _inherited_filters.items():
        if _k in _TD_KEYS and _k not in _early_time_dur:
            _early_time_dur[_k] = _v

    # ── Cross-dimensional check (highest specificity — runs first) ────────────
    filter_dim, filter_val, result_dim = _detect_cross_dimensional_query(question, payload)

    if filter_dim is not None:
        cross_results = _compute_cross_dimensional_results(
            payload, filter_dim, filter_val, result_dim,
            extra_filters=_early_time_dur or None,
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

    # raw flagged_by_type from the fresh payload (full arrays, pre-cap). Scoping
    # to the queried entity and capping to a few samples happen AFTER the scoped
    # entity is resolved below — so a bare-username question ("how many flags does
    # SUBHADRA have?") scopes correctly even when _fetch_detail_rows missed it.
    raw_fbt = payload.get("anomalies", {}).get("flagged_by_type", {})

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
            # Merge inherited scope: a follow-up reference inherits the prior
            # turn's filter dims it did not set itself (hour range, date,
            # duration, entity). When the current question had no spec at all but
            # inherits one, synthesise a spec so the follow-up is still scoped.
            if _inherited_filters:
                if spec is None:
                    spec = {"filters": {}, "group_by": None}
                _mf = dict(spec.get("filters") or {})
                for _k, _v in _inherited_filters.items():
                    _mf.setdefault(_k, _v)
                spec["filters"] = _mf
            if spec:
                entry = _ms.get_dataset(dataset_id)
                rows = (entry or {}).get("rows", []) or []
                if rows:
                    agg = _qe.aggregate_rows(rows, filters=spec.get("filters"),
                                             group_by=spec.get("group_by"))
                    # Build the aggregation whenever the question carried a
                    # concrete FILTER — even when it matched ZERO rows. Previously
                    # a valid-but-empty filter (e.g. "actions longer than 10
                    # hours", none exist) left aggregation=None → scoped_agg=False
                    # → the dataset-wide rankings were NOT stripped and the model
                    # fabricated a nonzero answer. A zero-match scoped result must
                    # still read as scoped (total_matching=0), not dataset-wide.
                    if agg.get("groups") or spec.get("filters"):
                        aggregation = {
                            "filters":  spec.get("filters"),
                            "group_by": spec.get("group_by"),
                            "total_matching": agg.get("total_matching"),
                            "groups":   agg.get("groups"),
                            "table":    _qe.format_aggregation(spec, agg),
                            "answer":   _qe.format_answer(spec, agg),
                        }
                        log.info("Explorer: on-demand aggregation "
                                 "(filters=%s group_by=%s groups=%d matching=%d)",
                                 spec.get("filters"), spec.get("group_by"),
                                 len(agg.get("groups", [])), agg.get("total_matching", 0))
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

    # ── Resolve the scoped entity (unify the two user detectors) ──────────────
    # Gap fix: _fetch_detail_rows (which sets user_filter) only matches
    # possessive / "for X" / "by X" / "show me X" phrasings, but
    # query_engine._detect_users (which drives scoped_agg) matches a bare
    # username anywhere ("how many flagged does SUBHADRA have?"). When they
    # disagree the ranking gets stripped yet NO authoritative count is built, so
    # the true flagged count vanishes from the input and the model fabricates
    # one (reported 0 for SUBHADRA whose real count is 9). Treat the
    # aggregation's filter as the canonical scope and reconcile both detectors.
    _agg_filters   = (aggregation or {}).get("filters", {}) if scoped_agg else {}
    scoped_user    = user_filter or _agg_filters.get("user")
    scoped_story   = _agg_filters.get("story")
    scoped_action  = _agg_filters.get("action")
    scoped_session = _agg_filters.get("session")
    _agg_total     = (aggregation or {}).get("total_matching") if scoped_agg else None

    # ── Anomaly-type scope (GAP: anomaly type as a filter dimension) ──────────
    # When the question names an anomaly type ("how many straggler actions",
    # "which hour had the most backend-bound actions", "list negative_phase
    # actions for story X"), build its authoritative view from flagged_by_type —
    # the only flag-aware source — optionally narrowed to the entity the
    # question also scopes to.
    _anom_type = _detect_anomaly_type(scoped_question) or _inherited_anom
    _type_time_dur = {k: v for k, v in _agg_filters.items() if k in _TD_KEYS}
    anomaly_type_scope = (
        _compute_anomaly_type_scope(raw_fbt, _anom_type, scoped_user,
                                    scoped_story, scoped_action, scoped_session,
                                    time_filters=_type_time_dur or None)
        if _anom_type else None
    )

    # ── Single-source enforcement for anomaly-typed dimension questions ───────
    # "Which users have the most straggler actions?" has TWO ranking sources:
    # anomaly_type_scope.by_user (scoped to that type — correct) and the
    # full-dataset flagged_users_ranking (every anomaly type — wrong for this
    # question). Mirror the scoped_agg strip: when an anomaly type is named AND a
    # dimension is asked, remove the competing full-dataset ranking so
    # anomaly_type_scope.by_<dim> is the only ranked flagged-count source. The
    # target dimension comes from either detector OR the parsed group_by
    # (parse_query reliably maps "which users/stories/actions" → group_by), since
    # _detect_dimension_and_rank misses some anomaly-typed phrasings.
    if anomaly_type_scope:
        _gb_dim = {"user": "users", "story": "stories",
                   "action": "action_types"}.get((aggregation or {}).get("group_by"))
        _typed_dim = dimension or _gb_dim
        if _typed_dim == "users":
            displayed_user_ranking = []
        elif _typed_dim == "stories":
            displayed_story_ranking = []
        elif _typed_dim == "action_types":
            displayed_action_ranking = []
        # Stripping the flagged ranking alone is not enough: data_summary.by_<dim>
        # ranks the SAME entities by raw activity volume (not by this anomaly
        # type's flagged count), so the model sees two competing ranked lists and
        # renders both — the correct anomaly_type_scope.by_<dim> AND the wrong
        # activity table. Mirror the scoped_agg strip and remove the matching
        # data_summary array so anomaly_type_scope.by_<dim> is the only ranked
        # per-entity source for this dimension.
        _ds_strip = {"users": "by_user", "stories": "by_story",
                     "action_types": "by_action"}.get(_typed_dim)
        if _ds_strip and ds_out:
            ds_out = {k: v for k, v in ds_out.items() if k != _ds_strip}

    # ── Single-source enforcement for widget-timing questions (Case 3) ────────
    # "Which user has the most backend time?" is answered by metric_rankings
    # (widget phase timings). But flagged_*_ranking (flagged counts) and
    # data_summary.by_* (activity volume) rank the SAME entities by DIFFERENT
    # metrics and would be rendered as extra, contradicting tables. When the
    # question is a widget-timing one — and it is NOT an anomaly-type question
    # (those have their own single-source handling above) — and metric data
    # exists, strip the competing rankings so metric_rankings is the only ranked
    # per-entity source. metric_rankings is computed SCOPED when a filter is
    # present (so "most backend time after 4 PM" / "render time for story X" rank
    # within the window) instead of being nulled out.
    _mr_filters = _agg_filters if scoped_agg else None
    metric_rankings = _compute_widget_metric_rankings(
        dataset_id, payload, filters=_mr_filters,
        sort_metric=_detect_timing_metric_name(scoped_question))
    if (not anomaly_type_scope
            and _detect_timing_metric(scoped_question)
            and metric_rankings and metric_rankings.get("available")):
        displayed_user_ranking = displayed_story_ranking = displayed_action_ranking = []
        if ds_out:
            ds_out = {k: v for k, v in ds_out.items()
                      if k not in ("by_user", "by_story", "by_action")}

    # ── Scope flagged_by_type + authoritative per-type totals ─────────────────
    # flagged_by_type indexes each flagged action under EACH of its anomaly
    # types, so a type bucket's length IS that type's true count (no cross-type
    # double counting within a single type). The buckets are capped to a few
    # samples below for tokens, so we ALSO pass flagged_type_totals as the
    # authoritative numbers — without them the model counts the truncated
    # arrays and reports "5 per type → 47 total" (true dataset total is 558).
    if scoped_user or scoped_session:
        def _in_scope(a):
            if scoped_user    and a.get("user")       != scoped_user:    return False
            if scoped_session and a.get("session_id") != scoped_session: return False
            return True
        _scoped_fbt = {
            tk: [a for a in (acts if isinstance(acts, list) else []) if _in_scope(a)]
            for tk, acts in raw_fbt.items()
        }
        _scoped_fbt = {tk: v for tk, v in _scoped_fbt.items() if v}
        flagged_type_totals = {tk: len(v) for tk, v in _scoped_fbt.items()}
        flagged_by_type     = {tk: v[:5] for tk, v in _scoped_fbt.items()}
    else:
        flagged_type_totals = {tk: len(v) for tk, v in raw_fbt.items()
                               if isinstance(v, list)}
        flagged_by_type     = {tk: v[:5] for tk, v in raw_fbt.items()
                               if isinstance(v, list)}

    # ── Authoritative scoped flagged summaries (survive the ranking strip) ────
    # Sourced from _compute_flagged_rankings — derived from the fresh payload's
    # flagged_actions, deduplicated by (action_name, timestamp, session_id) —
    # NOT from stored rows, which carry flags=null. For a scoped entity we
    # surface its one true flagged count so the model quotes it instead of
    # recomputing from buckets (double counts) or stored rows (always 0). An
    # entity absent from the ranking genuinely has 0 flagged actions — that 0 is
    # authoritative, not a guess.
    def _flag_summary(ranked, key, name, total):
        hit = next((e for e in ranked if e.get(key) == name), None)
        return {
            key:             name,
            "flagged_count": hit["flagged_count"]       if hit else 0,
            "flagged_pct":   hit.get("flagged_pct")     if hit else 0.0,
            "anomaly_types": hit.get("anomaly_types", []) if hit else [],
            "total_actions": total,
        }

    user_flagged_summary = None
    if scoped_user:
        _utotal = _agg_total if _agg_total is not None else (
            len(detail_rows) if detail_rows else None)
        user_flagged_summary = _flag_summary(all_ranked_users, "user",
                                             scoped_user, _utotal)
        # keep the legacy key name the SKILL prompt references
        user_flagged_summary["total_user_actions"] = user_flagged_summary["total_actions"]

    story_flagged_summary = (
        _flag_summary(all_ranked_stories, "story_name", scoped_story, _agg_total)
        if scoped_story else None
    )
    action_flagged_summary = (
        _flag_summary(all_ranked_action_types, "action_name", scoped_action, _agg_total)
        if scoped_action else None
    )

    # Session has no entry in _compute_flagged_rankings (that helper ranks users /
    # stories / action types only), so build the session's authoritative flagged
    # count directly from the fresh payload's flagged_actions, deduped by
    # (action_name, timestamp, session_id) — the same key used everywhere else.
    session_flagged_summary = None
    if scoped_session:
        _seen, _cnt, _types = set(), 0, set()
        for a in payload.get("anomalies", {}).get("flagged_actions", []):
            if a.get("session_id") != scoped_session:
                continue
            k = (a.get("action_name", ""), a.get("action_timestamp", ""),
                 a.get("session_id", ""))
            if k in _seen:
                continue
            _seen.add(k)
            _cnt += 1
            for t in (a.get("anomaly_types") or []):
                _types.add(t)
        session_flagged_summary = {
            "session_id":    scoped_session,
            "flagged_count": _cnt,
            "anomaly_types": sorted(_types),
            "total_actions": _agg_total,
        }

    # ── Authoritative flagged count for TIME / DURATION scopes (gap fix) ──────
    # The *_flagged_summary fields above cover user / story / action / session.
    # A scope on TIME (date, hour) or DURATION has NO flagged summary, so
    # "of the actions after 4 PM, how many had anomalies?" had no authoritative
    # number — the model fell back to the dataset-wide total (answered 558 for a
    # 105-action window). Build the real count by running the SAME parsed filter
    # over the payload's flagged_actions through query_engine.filter_rows (the
    # single filter source of truth — flagged_actions are action-row shaped and
    # carry action_timestamp + action_duration_ms), deduped by the standard
    # (action_name, timestamp, session_id) key. Restricted to filter keys the
    # flagged_actions can satisfy (date / hour / duration) — end-time and
    # dominant-phase read fields flagged_actions lack, which would wrongly
    # exclude every row.
    scoped_flagged_summary = None
    _TIME_DUR_KEYS = ("date", "hour_of_day", "hour_min", "hour_max",
                      "duration_min_ms", "duration_max_ms")
    # A multi-user comparison ("compare KIZUMI's flagged actions to NROS's")
    # parses to a `users` list, not a single `user`. flagged_actions carry `user`,
    # so filter_rows honours `users` directly — build the scoped summary for it too
    # (its by_user ranking gives the per-user flagged counts the comparison needs).
    # Without this the `users` scope fell through to the "flag count unavailable"
    # branch below and wrongly reported NO flagged count for a perfectly
    # computable comparison.
    if scoped_agg and any(k in _agg_filters for k in _TIME_DUR_KEYS + ("users",)):
        try:
            import query_engine as _qe
            _flag_filters = {k: v for k, v in _agg_filters.items()
                             if k in _TIME_DUR_KEYS
                             or k in ("user", "users", "story", "action", "session")}
            _flagged = payload.get("anomalies", {}).get("flagged_actions", []) or []
            # Denominator must use the SAME predicate as the numerator. When
            # _agg_filters contained a key flagged_actions can't satisfy
            # (dominant_phase, end_hour) it was dropped from _flag_filters; using
            # _agg_total (which DID apply it) as the denominator let flagged_count
            # exceed the total → flagged_pct > 100%. Recount the stored rows under
            # the identical _flag_filters so numerator and denominator always agree.
            _stored_rows = (_ms.get_dataset(dataset_id) or {}).get("rows", []) or []
            _scope_total = (len(_qe.filter_rows(_stored_rows, _flag_filters))
                            if _stored_rows else _agg_total)
            _seen = set()
            _types, _by_user, _by_story, _by_action = {}, {}, {}, {}
            for a in _qe.filter_rows(_flagged, _flag_filters):
                k = (a.get("action_name", ""), a.get("action_timestamp", ""),
                     a.get("session_id", ""))
                if k in _seen:
                    continue
                _seen.add(k)
                for t in (a.get("anomaly_types") or []):
                    _types[t] = _types.get(t, 0) + 1
                _by_user[a.get("user") or "unknown"] = _by_user.get(a.get("user") or "unknown", 0) + 1
                _by_story[a.get("story_name") or "unknown"] = _by_story.get(a.get("story_name") or "unknown", 0) + 1
                _by_action[a.get("action_name") or "unknown"] = _by_action.get(a.get("action_name") or "unknown", 0) + 1
            _flagged_count = len(_seen)

            def _ranked(counts):
                return [{"name": n, "flagged_count": c}
                        for n, c in sorted(counts.items(), key=lambda kv: -kv[1])]

            scoped_flagged_summary = {
                "filters":             _flag_filters,
                "scope_total_actions": _scope_total,
                "flagged_count":       _flagged_count,
                "flagged_pct":         (round(100.0 * _flagged_count / _scope_total, 1)
                                        if _scope_total else None),
                "by_type":             dict(sorted(_types.items(), key=lambda kv: -kv[1])),
                "by_user":             _ranked(_by_user),
                "by_story":            _ranked(_by_story),
                "by_action":           _ranked(_by_action),
            }
            log.info("Explorer: scoped flagged summary filters=%s flagged=%d/%s users=%d",
                     _flag_filters, _flagged_count, _scope_total, len(_by_user))
        except Exception:
            log.exception("Explorer scoped flagged summary failed — continuing without it")

    # ── Suppress dataset-wide flag sources once the question is SCOPED ─────────
    # anomaly_context (dataset-wide Anomaly Agent output), flagged_type_totals and
    # flagged_by_type samples otherwise sit beside the scoped number and are
    # exactly what the model grabs for "how many". Three cases:
    #   (a) scoped_flagged_summary present → it is the authoritative scoped flag
    #       source; replace flagged_type_totals with its scoped by_type, narrow
    #       flagged_by_type samples to the scope, null the all-time entity
    #       *_flagged_summary (its by_user/by_story/by_action already cover the
    #       entity∧time scope), and drop the dataset-wide anomaly_context.
    #   (b) scoped_agg but NO scoped_flagged_summary (end-time / dominant-phase
    #       scope — flagged_actions lack those fields, so a scoped flag count is
    #       not computable) → remove the dataset-wide flag numbers entirely so the
    #       model cannot present them as the scoped answer; flag it in the note.
    #   (c) not scoped → leave everything dataset-wide (correct for a global ask).
    anomaly_context = _get_anomaly_context(dataset_id)
    _scope_flag_unavailable = False
    if scoped_flagged_summary is not None:
        flagged_type_totals = dict(scoped_flagged_summary.get("by_type", {}))
        try:
            import query_engine as _qe2
            flagged_by_type = {
                tk: _qe2.filter_rows(v if isinstance(v, list) else [], _flag_filters)[:5]
                for tk, v in raw_fbt.items() if isinstance(v, list)
            }
            flagged_by_type = {tk: v for tk, v in flagged_by_type.items() if v}
        except Exception:
            flagged_by_type = {}
        user_flagged_summary = story_flagged_summary = None
        action_flagged_summary = session_flagged_summary = None
        anomaly_context = None
    elif scoped_agg and not (scoped_user or scoped_story or scoped_action or scoped_session):
        # Non-entity scope we can't represent on flagged_actions (end-time /
        # dominant-phase). No trustworthy scoped flag count exists.
        flagged_type_totals = {}
        flagged_by_type = {}
        anomaly_context = None
        _scope_flag_unavailable = True

    # Stored action rows (detail_rows, aggregation input) carry flags=null, so no
    # flag count may be derived from them — the *_flagged_summary fields are the
    # single authoritative source. This note is model-visible so the rule holds
    # even if the system prompt is stale.
    scoped_any = bool(scoped_user or scoped_story or scoped_action or scoped_session
                      or scoped_flagged_summary or _scope_flag_unavailable)
    if _scope_flag_unavailable:
        detail_rows_note = (
            "This question is scoped by a filter (e.g. end-time or dominant phase) "
            "that cannot be applied to the flagged-action data, so NO authoritative "
            "flagged COUNT is available for this exact scope. Report the activity "
            "numbers from the aggregation, and state plainly that the flagged count "
            "for this specific filter could not be computed — do NOT substitute a "
            "dataset-wide flagged total."
        )
    else:
        detail_rows_note = (
            "detail_rows, aggregation, and all stored action rows carry flags=null "
            "(flags are frontend-computed and not stored server-side). NEVER count "
            "flagged actions from them, and never read a flagged count off the "
            "aggregation's activity total. Use scoped_flagged_summary.flagged_count "
            "(for time/duration scopes) or the *_flagged_summary.flagged_count "
            "fields — these are authoritative and already deduplicated."
        ) if scoped_any else None

    return {
        "data_summary":                 ds_out,
        "flagged_users_ranking":        displayed_user_ranking,
        "flagged_stories_ranking":      displayed_story_ranking,
        "flagged_action_types_ranking": displayed_action_ranking,
        "flagged_by_type":              flagged_by_type,
        "flagged_type_totals":          flagged_type_totals,
        "question":                     question,
        "user_request":                 question,       # for _SCOPE_FILTER consistency
        "anomaly_context":              anomaly_context,
        "detail_rows":                  detail_rows,
        "detail_rows_note":             detail_rows_note,
        "anomaly_type_scope":           anomaly_type_scope,
        "user_filter":                  user_filter,
        "user_flagged_summary":         user_flagged_summary,
        "story_flagged_summary":        story_flagged_summary,
        "action_flagged_summary":       action_flagged_summary,
        "session_flagged_summary":      session_flagged_summary,
        "scoped_flagged_summary":       scoped_flagged_summary,
        "mode":                         mode,           # "ranking" | "detail" | "cross"
        "dimension":                    dimension,
        "ranking_request":              ranking_request,
        "cross_filter":                 cross_filter,   # None unless mode = "cross"
        "cross_results":                (cross_results[:ranking_request] if ranking_request else cross_results),  # [] unless mode = "cross"
        "metric_rankings":              metric_rankings,
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


def _compute_widget_metric_rankings(dataset_id, payload: dict, filters=None,
                                    sort_metric: str = "offset") -> dict:
    """
    Aggregate widget-level timing metrics (offset, render, network, backend) by
    action_name, story_name, and user — reading from the widget_rows stored in
    mesh_store alongside the action rows.

    widget_rows carry the `offset` (pre-render wait ms), `render`, `network`,
    and `backend` phase durations per widget per action instance.

    When `filters` is given (a query_engine filter spec — user/story/hour/date/
    duration etc.), the ranking is SCOPED: only widget rows whose parent action
    row passes query_engine.filter_rows are aggregated, so "most backend time
    after 4 PM" / "render time for story X" rank within that window instead of
    dataset-wide.

    Returns {
        "by_action": [...], "by_story": [...], "by_user": [...],
        "by_session": [...], "by_widget": [...],
        "available": bool,  # False when no widget rows exist
        "scoped": bool      # True when a filter was applied
    }
    All lists are pre-sorted by total_offset_ms descending.
    """
    import mesh_store as _ms

    _empty = {"by_action": [], "by_story": [], "by_user": [], "by_session": [],
              "by_widget": [], "available": False, "scoped": bool(filters)}
    if not dataset_id:
        return _empty

    entry = _ms.get_dataset(dataset_id)
    if not entry:
        return _empty

    widget_rows = entry.get("widget_rows", [])
    action_rows = entry.get("rows", [])

    if not widget_rows:
        return _empty

    # Scope: restrict to the action instances that pass the filter. The widget
    # row's action_key is "action_name::timestamp"; build the allowed-key set
    # from the filtered action rows so the widget aggregation honors the scope.
    allowed_keys = None
    if filters:
        try:
            import query_engine as _qe
            kept = _qe.filter_rows(action_rows, filters)
            allowed_keys = {f"{r.get('action_name','')}::{r.get('action_timestamp','')}"
                            for r in kept}
            action_rows = kept
        except Exception:
            log.exception("metric_rankings scope filter failed — using dataset-wide")
            allowed_keys = None

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
    widget_data_agg: dict = {}   # widget_name → summed phase timings (per-widget ranking)

    for w in widget_rows:
        action_key  = w.get("action_key", "")
        if allowed_keys is not None and action_key not in allowed_keys:
            continue  # outside the requested scope
        action_name = action_key.split("::")[0] if "::" in action_key else action_key

        meta       = action_key_meta.get(action_key, {})
        story_name = meta.get("story_name", "unknown")
        user       = meta.get("user",       "unknown")
        widget_name = w.get("widget_name") or "(unnamed)"

        offset_ms  = float(w.get("offset",  0) or 0)
        render_ms  = float(w.get("render",  0) or 0)
        network_ms = float(w.get("network", 0) or 0)
        backend_ms = float(w.get("backend", 0) or 0)

        for bucket, key in [
            (action_data,     action_name),
            (story_data,      story_name),
            (user_data,       user),
            (widget_data_agg, widget_name),
        ]:
            if key not in bucket:
                bucket[key] = {"offset": 0.0, "render": 0.0,
                               "network": 0.0, "backend": 0.0, "count": 0}
            bucket[key]["offset"]  += offset_ms
            bucket[key]["render"]  += render_ms
            bucket[key]["network"] += network_ms
            bucket[key]["backend"] += backend_ms
            bucket[key]["count"]   += 1

    # Sort key for widget-phase rankings: the metric the question asked about
    # ('backend'/'network'/'render'/'offset'), so "most backend time" ranks by
    # backend instead of the offset default. Falls back to offset if unknown.
    _sm = sort_metric if sort_metric in ("offset", "render", "network", "backend") else "offset"

    def _rank(bucket, entity_key):
        ranked = sorted(
            bucket.items(), key=lambda x: x[1][_sm], reverse=True
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
        # re-rank by the requested phase metric (primary), total_duration_ms
        # (secondary) so the merged list order matches the metric the question
        # asked about — not always offset.
        _sort_col = {"offset": "total_offset_ms", "render": "total_render_ms",
                     "network": "total_network_ms", "backend": "total_backend_ms"}.get(_sm, "total_offset_ms")
        merged.sort(key=lambda x: (x.get(_sort_col, 0), x["total_duration_ms"]), reverse=True)
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

    # ── Per-widget ranking (by widget_name, sorted by the requested phase) ───
    # Answers "which widget had the most render/backend/network/offset time".
    by_widget = [
        {
            "rank":             i + 1,
            "widget_name":      name,
            "total_render_ms":  round(data["render"]),
            "total_network_ms": round(data["network"]),
            "total_backend_ms": round(data["backend"]),
            "total_offset_ms":  round(data["offset"]),
            "avg_render_ms":    round(data["render"] / data["count"]) if data["count"] else 0,
            "widget_count":     data["count"],
        }
        for i, (name, data) in enumerate(
            sorted(widget_data_agg.items(),
                   key=lambda x: x[1][_sm if _sm != "offset" else "render"], reverse=True)
        )
    ]

    # Cap the two long-tail rankings. by_session (one row per session) and
    # by_widget (one row per distinct widget name) scale with the dataset — a
    # 2k-row upload yields ~340 sessions and ~800 widget names, together ~240KB
    # of JSON (~60k tokens) that would be fed to the LLM on EVERY exploration
    # question regardless of relevance. Both are pre-sorted by their primary
    # metric, so the top 50 answers any "which session/widget has the most X"
    # question; deep per-widget analysis is the widget_trace mode's job. The
    # pre-cap totals are kept so "how many sessions/widgets" stays answerable.
    _SESSION_CAP = _WIDGET_CAP = 50
    return {
        "by_action":        by_action_merged,
        "by_story":         by_story_merged,
        "by_user":          by_user_merged,
        "by_session":       by_session[:_SESSION_CAP],
        "by_session_total": len(by_session),
        "by_widget":        by_widget[:_WIDGET_CAP],
        "by_widget_total":  len(by_widget),
        "available":        True,
        "scoped":           bool(filters),
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
    extra_filters=None,
) -> list:
    """
    Filter flagged_actions to rows where filter_dim == filter_val, then rank
    by result_dim (deduplicated by action identity key).

    When `extra_filters` is given (a query_engine time/duration spec), it is
    applied first via query_engine.filter_rows so "which users on story X after
    4 PM" ranks only the flagged actions inside that window — otherwise the time
    scope was silently dropped and the result spanned all hours.

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
    if extra_filters:
        try:
            import query_engine as _qe
            flagged_actions = _qe.filter_rows(flagged_actions, extra_filters)
        except Exception:
            log.exception("cross-dim time/duration scope failed — using all hours")

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


_TRACE_SCOPED_TOP_N = 5  # slowest actions to trace for a targeted user/action query


def _build_trace_input(question: str, payload: dict, dataset_id) -> dict:
    """
    Build trace-agent input — mesh-native, token-controlled.

    In pipeline mode the LLM can't make HTTP calls, so we fetch widget data
    from the dataset store and include it. We aggressively trim to stay under
    token limits.

    Two scopes:
      - TARGETED: the question names a specific user/action/story/session
        (parsed deterministically by query_engine). We trace that entity's
        SLOWEST N actions from the full stored rows — not just anomaly-flagged
        ones — so any action with widget data can be asked about.
      - GENERIC (fallback): no entity named → the top 3 flagged actions by
        duration, as before.

    In both cases we include widget rows only for the chosen actions, a slim
    type summary, and compact mesh outputs.
    """
    import mesh_store
    import query_engine

    anomalies = payload.get("anomalies", {})
    flagged_actions = anomalies.get("flagged_actions", [])

    # ── Targeted scope: did the user name a specific entity? ──────────────────
    scoped = False
    slim_actions = []
    spec = query_engine.parse_query(question, dataset_id) if dataset_id else None
    scope_filters = (spec or {}).get("filters", {})
    # Only user/action/story/session make this an action-trace query; a bare
    # date/hour filter is an explorer-style breakdown, not a widget trace.
    if any(scope_filters.get(k) for k in ("user", "action", "story", "session")):
        entry = mesh_store.get_dataset(dataset_id)
        rows = (entry or {}).get("rows", []) or []
        matched = query_engine.filter_rows(rows, scope_filters)
        matched.sort(key=lambda r: r.get("action_duration_ms") or 0, reverse=True)
        for a in matched[:_TRACE_SCOPED_TOP_N]:
            slim_actions.append({
                "action_name":        a.get("action_name", ""),
                "action_timestamp":   a.get("action_timestamp", ""),
                "user":               a.get("user", ""),
                "action_duration_ms": a.get("action_duration_ms", 0),
                "anomaly_types":      a.get("anomaly_types", []),
            })
        scoped = bool(slim_actions)

    # ── Generic fallback: top actions by duration ────────────────────────────
    # Pull from ALL stored rows (not just flagged) so "the slowest action" is the
    # TRUE slowest overall — not merely the slowest FLAGGED action, which was
    # often a different, mid-ranked action and produced a misleading waterfall.
    # Prefer actions that actually have widget data so the trace/waterfall is
    # non-empty; fall back to flagged_actions when stored rows are unavailable.
    if not scoped:
        source = flagged_actions
        if dataset_id:
            entry = mesh_store.get_dataset(dataset_id)
            rows = (entry or {}).get("rows", []) or []
            if rows:
                wrows = (entry or {}).get("widget_rows", []) or []
                keys_with_widgets = {w.get("action_key") for w in wrows} if wrows else set()
                traceable = [
                    r for r in rows
                    if f"{r.get('action_name', '')}::{r.get('action_timestamp', '')}"
                    in keys_with_widgets
                ]
                source = traceable or rows
        top_actions = sorted(
            source,
            key=lambda a: a.get("action_duration_ms") or 0,
            reverse=True,
        )[:3]
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
        "scope":             "targeted" if scoped else "flagged",
        "scope_filters":     scope_filters if scoped else {},
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
            # Strip any [Previous: ...] / [Context: ...] enrichment tag before
            # the LLM sees it — the tag biases the model toward the prior turn's
            # scope (e.g. a session_id), which is exactly how an independent
            # question got answered against the wrong session. The deictic
            # resolution above already consumed the tag it needed.
            return call_llm(system, _strip_context_tag(question), history=llm_history)
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
    """Build an action_waterfall directive for the worst offending action.
    The runner only calls this when the user actually asked for a chart."""
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
    """Inject a chart only when the user explicitly asked to see one, matching the
    chart TYPE they named. Previously this always returned a Pareto (except pie),
    so "show me the action waterfall" rendered a Pareto. Now the named chart type
    drives the directive; waterfall uses the "worst_offender" selector so it always
    resolves on the frontend without a brittle exact action-name match."""
    ql = (question or "").lower()
    if not _VIZ_VERB_RE.search(ql):
        return None
    # Bespoke performance charts — matched before the registry defaults.
    if "waterfall" in ql:
        return {"family": "bespoke", "chart": "action_waterfall",
                "selector": "worst_offender", "title": "Action waterfall — slowest action"}
    if "scatter" in ql:
        return {"family": "bespoke", "chart": "action_scatter",
                "title": "Action phase scatter"}
    if "box" in ql:   # "boxplot" / "box plot"
        return {"family": "bespoke", "chart": "action_boxplot",
                "title": "Action duration spread"}
    # Registry charts keyed on action durations.
    if "pie" in ql or "donut" in ql:
        return {"family": "registry", "chartType": ("donut" if "donut" in ql else "pie"),
                "data": "actions",
                "config": {"nameKey": "action_name", "valueKey": "action_duration"},
                "title": "Action durations"}
    if "histogram" in ql:
        return {"family": "registry", "chartType": "histogram", "data": "actions",
                "config": {"key": "action_duration"}, "title": "Action duration distribution"}
    if "bar" in ql:
        return {"family": "registry", "chartType": "bar", "data": "actions",
                "config": {"xKey": "action_name", "yKey": "action_duration"},
                "title": "Action durations"}
    # Default explicit-request chart: Pareto of action durations.
    return {"family": "registry", "chartType": "pareto", "data": "actions",
            "config": {"nameKey": "action_name", "valueKey": "action_duration"},
            "title": "Action duration Pareto"}
