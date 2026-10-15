"""
query_engine.py — On-demand aggregation over stored action rows.

The full action dataset is held server-side (mesh_store.datasets, persisted to
backend/datasets/). This module lets the agents answer arbitrary drill-downs —
"hour-by-hour breakdown for MHURTADO's story on Jul 30", "which hour of day is
busiest", "median duration by story" — by filtering and grouping those rows and
computing a standard metric bundle per group.

Two entry points:
  parse_query(question, dataset_id) -> dict | None
      Deterministically parse a natural-language question into a filter + group
      specification, validating entity names against the actual dataset.
  aggregate_rows(rows, filters, group_by) -> list[dict]
      Filter and group rows, returning count + duration statistics per group.

No LLM calls happen here — the trigger is keyword parsing (see parse_query).
"""

import re
import logging
from datetime import datetime

log = logging.getLogger(__name__)

SLOW_ACTION_THRESHOLD_MS = 120000  # mirrors the frontend default (buildMeta)

# Fields we read off an action row (canonical after mesh_store.normalize_rows).
_TS_FIELDS       = ("action_timestamp", "_action_timestamp")
_DURATION_FIELDS = ("action_duration_ms", "action_duration")

# Per-action phase busy-time maxima stored on every row (ms). Historically these
# were never aggregated or exposed, so phase questions ("median backend time by
# user", "sort by network time") could not be answered. (row field, short name).
_PHASE_FIELDS = (
    ("max_frontend", "frontend"),
    ("max_network",  "network"),
    ("max_backend",  "backend"),
)

# Natural-language duration units → milliseconds. Longest spellings win in the
# regex alternation below so 'ms' beats 's' and 'minutes' beats 'min'/'m'.
_DUR_UNIT_MS = {
    "ms": 1, "msec": 1, "msecs": 1, "millisecond": 1, "milliseconds": 1,
    "s": 1000, "sec": 1000, "secs": 1000, "second": 1000, "seconds": 1000,
    "m": 60000, "min": 60000, "mins": 60000, "minute": 60000, "minutes": 60000,
    "h": 3600000, "hr": 3600000, "hrs": 3600000, "hour": 3600000, "hours": 3600000,
}
_DUR_UNIT_ALT = "|".join(
    re.escape(u) for u in sorted(_DUR_UNIT_MS, key=len, reverse=True)
)
# "longer than 5 minutes", "over 500ms", "at least 1 hour", ">= 90s" → min bound.
_DUR_MIN_RE = re.compile(
    r"(?:longer than|more than|greater than|at least|no (?:less|fewer) than|"
    r"over|above|exceed(?:s|ing)?|>=?|≥)\s*"
    r"(\d[\d,]*\.?\d*)\s*(" + _DUR_UNIT_ALT + r")\b",
    re.IGNORECASE,
)
# "shorter than 2 seconds", "under 1 min", "at most 30s", "<= 100ms" → max bound.
_DUR_MAX_RE = re.compile(
    r"(?:shorter than|less than|faster than|quicker than|at most|no (?:more|longer) than|"
    r"under|below|within|<=?|≤)\s*"
    r"(\d[\d,]*\.?\d*)\s*(" + _DUR_UNIT_ALT + r")\b",
    re.IGNORECASE,
)

_MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
    "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
    "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9, "oct": 10,
    "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}
_WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday",
             "Friday", "Saturday", "Sunday"]

# Group-by phrase → canonical key. Order matters: check most specific first.
# First match in list order wins, so this list is ordered by priority:
# weekday before the generic "day" patterns (so "day of the week" isn't eaten
# by "day"), and all time dimensions before the entity dimensions (so a
# superlative time question like "busiest hour ... by action count" groups by
# hour, not by the "by action" inside "action count"). Each pattern covers the
# explicit "by X"/"per X" phrasings plus the superlative/interrogative forms
# users actually type ("busiest hour", "which hour", "peak activity").
_GROUP_BY_PATTERNS = [
    (r"\b(by\s+weekday|weekday|day\s+of\s+(?:the\s+)?week|which\s+weekday|busiest\s+weekday)\b", "weekday"),
    (r"\b(hour[\s-]*by[\s-]*hour|hourly|by\s+hour|per\s+hour|each\s+hour|hour\s+of\s+day|by\s+the\s+hour"
     r"|busiest\s+hour|peak\s+hour|slowest\s+hour|quietest\s+hour|which\s+hour|what\s+hour"
     r"|most\s+active\s+hour|busiest\s+time(?:\s+of\s+day)?|peak\s+time(?:\s+of\s+day)?"
     r"|peak\s+activity|time\s+of\s+day|what\s+time\s+of\s+day)\b", "hour"),
    (r"\b(day[\s-]*by[\s-]*day|daily|by\s+day|per\s+day|each\s+day|by\s+date|over\s+time"
     r"|busiest\s+day|peak\s+day|slowest\s+day|quietest\s+day|which\s+day|what\s+day)\b", "day"),
    (r"\b(monthly|by\s+month|per\s+month|busiest\s+month|which\s+month|what\s+month)\b", "month"),
    (r"\b(by\s+user|per\s+user|for\s+each\s+user|users?\s+breakdown|busiest\s+user"
     r"|which\s+users?|what\s+users?|most\s+active\s+user|top\s+users?|who"
     r"|active\s+users?|users?\s+active|list\s+(?:of\s+|all\s+)?users?)\b", "user"),
    (r"\b(by\s+story|per\s+story|for\s+each\s+story|busiest\s+story|which\s+stor(?:y|ies)"
     r"|what\s+stor(?:y|ies)|top\s+stor(?:y|ies)|active\s+stor(?:y|ies)|stor(?:y|ies)\s+active)\b", "story"),
    (r"\b(by\s+action|per\s+action|for\s+each\s+action|which\s+action|what\s+actions?"
     r"|top\s+actions?|most\s+(?:common|frequent)\s+action)\b", "action"),
    (r"\b(by\s+session|per\s+session|for\s+each\s+session|busiest\s+session"
     r"|which\s+session|what\s+sessions?|top\s+sessions?)\b", "session"),
    (r"\b(by\s+dominant\s+phase|dominant\s+phase\s+breakdown|per\s+dominant\s+phase"
     r"|by\s+phase\s+dominance|by\s+phase|which\s+phase\s+dominates)\b", "dominant_phase"),
]

# Stopwords reused from the detail-row parser semantics — words that follow
# "for"/"by"/"show me" but are never a real entity name.
_STOPWORDS = {
    "the", "a", "an", "all", "each", "every", "me", "us", "them", "any",
    "top", "bottom", "most", "least", "slow", "slowest", "fast", "fastest",
    "this", "that", "these", "those", "hour", "day", "week", "month", "time",
    "user", "users", "story", "stories", "action", "actions", "session",
    "sessions", "widget", "widgets", "breakdown", "duration", "durations",
}


# ─── timestamp parsing ────────────────────────────────────────────────────────

def parse_ts(value):
    """Lenient timestamp parse. Returns a datetime or None.

    Handles ISO strings, a space separator, and high-precision fractional
    seconds like '2026-07-30T08:46:43.227000000' (9 digits) that
    datetime.fromisoformat rejects — fractional seconds are truncated to 6.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    s = str(value).strip()
    if not s or s.lower() in ("nan", "none", "null", "ttfb"):
        return None
    s = s.replace("/", "-")
    # Truncate over-long fractional seconds to microseconds (6 digits).
    m = re.match(r"^(.*\.\d{6})\d+([+-].*|Z)?$", s)
    if m:
        s = m.group(1) + (m.group(2) or "")
    iso = s.replace(" ", "T", 1)
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        pass
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S",
                "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _row_ts(row):
    for f in _TS_FIELDS:
        dt = parse_ts(row.get(f))
        if dt is not None:
            return dt
    return None


def _row_duration(row):
    for f in _DURATION_FIELDS:
        v = row.get(f)
        if isinstance(v, (int, float)):
            return float(v)
    return None


def _row_phase(row, field):
    v = row.get(field)
    return float(v) if isinstance(v, (int, float)) else None


def _dominant_phase(row):
    """Return the phase ('frontend'|'network'|'backend') with the largest
    per-row maximum, or None when no phase timing is present.

    This classifies EVERY action by which phase contributed most to it — the
    argmax of max_frontend / max_network / max_backend — independent of whether
    the action was flagged. It is distinct from the frontend_bound /
    network_bound / backend_bound anomaly types, which cover only flagged
    actions. Ties resolve by the fixed _PHASE_FIELDS order (frontend first)."""
    best_name, best_val = None, None
    for field, name in _PHASE_FIELDS:
        v = _row_phase(row, field)
        if v is None:
            continue
        if best_val is None or v > best_val:
            best_name, best_val = name, v
    # best_val == 0 means every present phase was 0 (no real activity) → no
    # dominant phase, rather than defaulting to whichever field sorted first.
    return best_name if best_val else None


def _bucket_key(dt, granularity):
    """Return (sort_key, label) for grouping a datetime, or None."""
    if dt is None:
        return None
    if granularity == "hour":
        return (dt.hour, f"{dt.hour:02d}:00")
    if granularity == "day":
        key = dt.strftime("%Y-%m-%d")
        return (key, key)
    if granularity == "weekday":
        return (dt.weekday(), _WEEKDAYS[dt.weekday()])
    if granularity == "month":
        key = dt.strftime("%Y-%m")
        return (key, key)
    return None


# ─── statistics ───────────────────────────────────────────────────────────────

def _percentile(sorted_vals, pct):
    """Linear-interpolation percentile (PERCENTILE.INC), matching kpis.js."""
    if not sorted_vals:
        return None
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    rank = (pct / 100.0) * (len(sorted_vals) - 1)
    lo = int(rank)
    hi = min(lo + 1, len(sorted_vals) - 1)
    frac = rank - lo
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * frac


def _metric_bundle(durations, threshold_ms=SLOW_ACTION_THRESHOLD_MS):
    """Standard per-group statistics over a list of durations (ms)."""
    vals = sorted(d for d in durations if isinstance(d, (int, float)))
    n = len(vals)
    if n == 0:
        return {"count": 0}
    total = sum(vals)
    return {
        "count":            n,
        "total_duration_ms": int(round(total)),
        "avg_duration_ms":   int(round(total / n)),
        "median_ms":         int(round(_percentile(vals, 50))),
        "p90_ms":            int(round(_percentile(vals, 90))),
        "p95_ms":            int(round(_percentile(vals, 95))),
        "max_ms":            int(round(vals[-1])),
        "over_threshold":    sum(1 for v in vals if v >= threshold_ms),
    }


def _phase_bundle(rows):
    """Per-phase (frontend/network/backend) avg/median/max over rows, in ms.

    Reads the row-level max_frontend / max_network / max_backend fields that
    _metric_bundle ignores (it sees only total durations). Returns {} when a
    group has no phase data, and omits any single phase whose values are all
    absent, so a phase column never shows a misleading 0.
    """
    out = {}
    for field, name in _PHASE_FIELDS:
        vals = sorted(
            v for v in (_row_phase(r, field) for r in rows) if v is not None
        )
        if not vals:
            continue
        out[f"avg_{name}_ms"]    = int(round(sum(vals) / len(vals)))
        out[f"median_{name}_ms"] = int(round(_percentile(vals, 50)))
        out[f"max_{name}_ms"]    = int(round(vals[-1]))
    return out


# ─── filtering + aggregation ────────────────────────────────────────────────

def _match(row_val, wanted):
    if wanted is None:
        return True
    return str(row_val or "").strip().lower() == str(wanted).strip().lower()


def filter_rows(rows, filters):
    """Apply a filter spec to action rows. Unknown/None filters are ignored."""
    filters = filters or {}
    user    = filters.get("user")
    users   = filters.get("users")           # list — comparison across several users
    story   = filters.get("story")
    action  = filters.get("action")
    session = filters.get("session")
    date    = filters.get("date")            # "YYYY-MM-DD"
    hour    = filters.get("hour_of_day")     # int 0-23 (exact)
    hmin    = filters.get("hour_min")        # int 0-23 — dt.hour >= this
    hmax    = filters.get("hour_max")        # int 0-23 — dt.hour <= this
    dmin    = filters.get("duration_min_ms")
    dmax    = filters.get("duration_max_ms")
    dphase  = filters.get("dominant_phase")  # "frontend"|"network"|"backend"
    ehmin   = filters.get("end_hour_min")    # _action_end hour >= this
    ehmax   = filters.get("end_hour_max")    # _action_end hour <= this

    user_set = {str(u).strip().lower() for u in users if u} if users else None

    out = []
    for r in rows:
        if user_set is not None and str(r.get("user") or "").strip().lower() not in user_set:
            continue
        if not _match(r.get("user"), user):            continue
        if not _match(r.get("story_name"), story):     continue
        if not _match(r.get("action_name"), action):   continue
        if not _match(r.get("session_id"), session):   continue
        if date is not None or hour is not None or hmin is not None or hmax is not None:
            dt = _row_ts(r)
            if dt is None:
                continue
            if date is not None and dt.strftime("%Y-%m-%d") != date:
                continue
            if hour is not None and dt.hour != hour:
                continue
            if hmin is not None and dt.hour < hmin:
                continue
            if hmax is not None and dt.hour > hmax:
                continue
        if dmin is not None or dmax is not None:
            dur = _row_duration(r)
            if dur is None:
                continue
            if dmin is not None and dur < dmin:
                continue
            if dmax is not None and dur > dmax:
                continue
        if dphase is not None and _dominant_phase(r) != dphase:
            continue
        if ehmin is not None or ehmax is not None:
            edt = parse_ts(r.get("_action_end"))
            if edt is None:
                continue
            if ehmin is not None and edt.hour < ehmin:
                continue
            if ehmax is not None and edt.hour > ehmax:
                continue
        out.append(r)
    return out


def aggregate_rows(rows, filters=None, group_by=None,
                   threshold_ms=SLOW_ACTION_THRESHOLD_MS, limit=200):
    """Filter and group action rows, returning count + duration stats per group.

    Returns a dict:
      { "total_matching": N, "group_by": <key or None>, "groups": [ {group, ...metrics} ] }
    When group_by is None a single 'all' group is returned.
    """
    matched = filter_rows(rows, filters)
    result = {"total_matching": len(matched), "group_by": group_by, "groups": []}
    if not matched:
        return result

    if not group_by:
        bundle = _metric_bundle([_row_duration(r) for r in matched], threshold_ms)
        result["groups"] = [{"group": "all", **bundle, **_phase_bundle(matched)}]
        return result

    buckets = {}  # sort_key -> {"label": str, "rows": [..]}
    for r in matched:
        if group_by in ("hour", "day", "weekday", "month"):
            bk = _bucket_key(_row_ts(r), group_by)
        elif group_by == "user":
            v = r.get("user"); bk = (str(v), str(v)) if v else None
        elif group_by == "story":
            v = r.get("story_name"); bk = (str(v), str(v)) if v else None
        elif group_by == "action":
            v = r.get("action_name"); bk = (str(v), str(v)) if v else None
        elif group_by == "session":
            v = r.get("session_id"); bk = (str(v), str(v)) if v else None
        elif group_by == "dominant_phase":
            v = _dominant_phase(r); bk = (v, v) if v else None
        else:
            bk = None
        if bk is None:
            continue
        sort_key, label = bk
        buckets.setdefault(sort_key, {"label": label, "rows": []})
        buckets[sort_key]["rows"].append(r)

    is_time = group_by in ("hour", "day", "weekday", "month")
    for sort_key in sorted(buckets.keys(), key=lambda k: (k is None, k)) if is_time \
            else sorted(buckets.keys(), key=lambda k: -len(buckets[k]["rows"])):
        b = buckets[sort_key]
        durations = [_row_duration(r) for r in b["rows"]]
        result["groups"].append({
            "group": b["label"],
            **_metric_bundle(durations, threshold_ms),
            **_phase_bundle(b["rows"]),
        })

    if not is_time and limit:
        result["groups"] = result["groups"][:limit]
    return result


# ─── natural-language query parsing (deterministic trigger) ───────────────────

def _detect_group_by(q_lower):
    for pattern, key in _GROUP_BY_PATTERNS:
        if re.search(pattern, q_lower):
            return key
    return None


def _token_in(haystack_lower, needle_lower):
    """Whole-token containment: True when needle_lower appears in haystack_lower
    delimited by non-alphanumeric boundaries. Prevents a short entity name from
    matching inside an unrelated word — user "AL" must NOT match "overall",
    action "Login" must NOT match "Login Dashboard" as a bare substring — while
    still matching real multi-word names ("Sales Overview") and names bordered by
    punctuation/underscores. needle may contain spaces/punctuation."""
    if not needle_lower:
        return False
    pat = r"(?<![0-9a-z])" + re.escape(needle_lower) + r"(?![0-9a-z])"
    return re.search(pat, haystack_lower) is not None


def _detect_entity(question, known_values):
    """Return the known entity value whose name appears in the question, if any.

    Matches longest known value first so 'Sales Overview' wins over 'Sales'.
    Whole-token (word-boundary) match against the lowercased question text, so a
    short name is not spuriously found inside a longer unrelated word.
    """
    if not known_values:
        return None
    q_lower = question.lower()
    for val in sorted((v for v in known_values if v), key=lambda s: -len(str(s))):
        vs = str(val).strip()
        if len(vs) < 2:
            continue
        if _token_in(q_lower, vs.lower()):
            return val
    return None


def _detect_users(question, known_users):
    """Return EVERY known user named in the question (comparison questions name
    more than one, e.g. 'compare MHURTADO and KIZUMI'). Longest name first so a
    short name that is a substring of a longer one does not double-match the
    same span. Case-insensitive whole-substring match against the question."""
    if not known_users:
        return []
    q_lower = question.lower()
    found = []
    claimed = []  # (start, end) spans already consumed by a longer match
    for u in sorted((x for x in known_users if x), key=lambda s: -len(str(s))):
        us = str(u).strip()
        if len(us) < 2:
            continue
        m = re.search(r"(?<![0-9a-z])" + re.escape(us.lower()) + r"(?![0-9a-z])", q_lower)
        if not m:
            continue
        start, end = m.start(), m.end()
        if any(s <= start and end <= e for s, e in claimed):
            continue  # inside an already-matched longer name
        found.append(u)
        claimed.append((start, end))
    return found


def _detect_user(question, known_users):
    """Possessive / prefix user parse (mirrors orchestrate._fetch_detail_rows),
    validated against real user names."""
    lookup = {str(u).lower(): u for u in known_users if u}
    # "MHURTADO's ..." possessive
    apostrophe = question.find("'s")
    if apostrophe == -1:
        apostrophe = question.find("’s")
    if apostrophe != -1:
        start = question.rfind(" ", 0, apostrophe) + 1
        cand = question[start:apostrophe].strip()
        if cand.lower() in lookup:
            return lookup[cand.lower()]
    # "for X", "by X", "show me X"
    q_lower = question.lower()
    for prefix in ("for ", "by ", "show me "):
        idx = q_lower.find(prefix)
        if idx != -1:
            cand = question[idx + len(prefix):].split()[0].rstrip("'s,.’") if \
                question[idx + len(prefix):].split() else ""
            if cand and cand.lower() not in _STOPWORDS and cand.lower() in lookup:
                return lookup[cand.lower()]
    # bare mention of a known username anywhere
    return _detect_entity(question, known_users)


def _detect_date(question, rows):
    """Parse an explicit or month-name date, resolved against dates present in
    the data. Returns 'YYYY-MM-DD' or None."""
    # available dates in the dataset
    available = {}
    for r in rows:
        dt = _row_ts(r)
        if dt:
            available.setdefault(dt.strftime("%Y-%m-%d"), dt)
    if not available:
        return None
    # explicit ISO YYYY-MM-DD
    m = re.search(r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b", question)
    if m:
        iso = f"{int(m.group(1)):04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
        return iso if iso in available else None
    # "Jul 30", "July 30", "30 Jul"
    q_lower = question.lower()
    mon = day = None
    mm = re.search(r"\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b", q_lower)
    if mm and mm.group(1) in _MONTHS:
        mon, day = _MONTHS[mm.group(1)], int(mm.group(2))
    if mon is None:
        mm = re.search(r"\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\b", q_lower)
        if mm and mm.group(2) in _MONTHS:
            mon, day = _MONTHS[mm.group(2)], int(mm.group(1))
    if mon is None or day is None:
        return None
    # resolve the year from available dates for that month/day
    for iso, dt in available.items():
        if dt.month == mon and dt.day == day:
            return iso
    return None


def _detect_hour(question):
    """Parse an explicit clock hour like '3pm', '15:00', 'at 9 am', 'hour 11'.
    Returns int (0-23) or None."""
    q = question.lower()
    m = re.search(r"\b(\d{1,2})\s*(am|pm)\b", q)
    if m:
        h = int(m.group(1)) % 12
        return h + 12 if m.group(2) == "pm" else h
    m = re.search(r"\b(\d{1,2}):00\b", question)
    if m and 0 <= int(m.group(1)) <= 23:
        return int(m.group(1))
    # "hour 11", "during hour 11", "in hour 11", "hr 13" (but not "hour-by-hour",
    # "hour of day" — those have no digit immediately after the word)
    m = re.search(r"\b(?:hour|hr)\s+(\d{1,2})\b", q)
    if m and 0 <= int(m.group(1)) <= 23:
        return int(m.group(1))
    if re.search(r"\bnoon\b|\bmidday\b", q):
        return 12
    if re.search(r"\bmidnight\b", q):
        return 0
    return None


def _detect_duration_filter(question):
    """Parse a natural-language duration threshold into min/max millisecond bounds.

    Handles 'longer than 5 minutes', 'under 2 seconds', 'over 500ms', 'at least
    1 hour', '>= 90s', 'faster than 1 min'. Returns a dict with the
    duration_min_ms / duration_max_ms keys that were found (either, both, or
    neither), which filter_rows already understands. A bare clock-hour or date
    phrase is left untouched because a comparator word plus a duration unit are
    both required to match."""
    out = {}
    for rx, key in ((_DUR_MIN_RE, "duration_min_ms"), (_DUR_MAX_RE, "duration_max_ms")):
        m = rx.search(question)
        if not m:
            continue
        mult = _DUR_UNIT_MS.get(m.group(2).lower())
        if mult:
            out[key] = float(m.group(1).replace(",", "")) * mult
    return out


# Dominant-phase phrasings: "<phase> dominant/heavy", "dominant <phase>",
# "<phase> is the dominant/heaviest phase". front-end / back-end spelling
# variants are normalised in _norm_phase. Deliberately excludes "<phase> bound"
# — that is the anomaly-type wording handled separately in orchestrate.py.
_DOM_PHASE_RE = re.compile(
    r"\b(front[\s-]?end|frontend|network|back[\s-]?end|backend)[\s-]*"
    r"(?:dominant|dominated|dominance|heavy|heaviest)\b"
    r"|\b(?:dominant|heaviest)[\s-]+(front[\s-]?end|frontend|network|back[\s-]?end|backend)\b"
    r"|\b(front[\s-]?end|frontend|network|back[\s-]?end|backend)\s+(?:(?:is|was|were|are)\s+)?(?:the\s+)?"
    r"(?:dominant|heaviest|largest|biggest)\s+phase\b",
    re.IGNORECASE,
)


def _norm_phase(word):
    """Normalise a phase word ('front end', 'front-end', 'Frontend') to a
    canonical key, or None if it isn't a phase name."""
    if not word:
        return None
    w = re.sub(r"[\s-]+", "", word.lower())   # 'front end' / 'front-end' → 'frontend'
    return w if w in ("frontend", "network", "backend") else None


def _detect_dominant_phase_filter(question):
    """Detect a dominant-phase row filter. Returns {'dominant_phase': <phase>}
    (frontend/network/backend) or {}. Matches 'backend-dominant actions',
    'frontend heavy', 'actions where network was the heaviest phase'. This
    classifies ALL rows by argmax phase — distinct from the *_bound anomaly
    types which cover only flagged actions (see _dominant_phase)."""
    m = _DOM_PHASE_RE.search(question)
    if not m:
        return {}
    for g in m.groups():
        p = _norm_phase(g)
        if p:
            return {"dominant_phase": p}
    return {}


# End-timestamp (_action_end) clock-hour phrasings. An end/finish verb plus
# after/before/between is required, so start-time or duration phrases never
# match here.
_END_AFTER_RE   = re.compile(r"\b(?:end(?:ed|ing|s)?|finish(?:ed|ing|es)?)\s+after\b",   re.IGNORECASE)
_END_BEFORE_RE  = re.compile(r"\b(?:end(?:ed|ing|s)?|finish(?:ed|ing|es)?)\s+before\b",  re.IGNORECASE)
_END_BETWEEN_RE = re.compile(r"\b(?:end(?:ed|ing|s)?|finish(?:ed|ing|es)?)\s+between\b", re.IGNORECASE)
# Any end/finish verb — used to blank the end clause before start-hour parsing.
_END_VERB_RE    = re.compile(r"\b(?:end(?:ed|ing|s)?|finish(?:ed|ing|es)?)\b", re.IGNORECASE)


def _detect_end_time_filter(question):
    """Parse an end-timestamp (_action_end) clock-hour filter.

    'ended after 3pm' → {end_hour_min: 15}; 'finished before noon' →
    {end_hour_max: 12}; 'ended between 2pm and 5pm' → both bounds. Returns {}
    when no end/finish + after/before/between phrase with a parseable clock
    time is present. filter_rows applies these against each row's _action_end."""
    mb = _END_BETWEEN_RE.search(question)
    if mb:
        out = {}
        tail = question[mb.end():]
        parts = re.split(r"\band\b", tail, maxsplit=1, flags=re.IGNORECASE)
        lo = _detect_hour(parts[0]) if parts else None
        hi = _detect_hour(parts[1]) if len(parts) > 1 else None
        if lo is not None:
            out["end_hour_min"] = lo
        if hi is not None:
            out["end_hour_max"] = hi
        return out
    out = {}
    ma = _END_AFTER_RE.search(question)
    if ma:
        h = _detect_hour(question[ma.end():])
        if h is not None:
            out["end_hour_min"] = h
    mbf = _END_BEFORE_RE.search(question)
    if mbf:
        h = _detect_hour(question[mbf.end():])
        if h is not None:
            out["end_hour_max"] = h
    return out


# Start-of-action clock-hour RANGE: "after 4pm" / "from 2pm" / "since 14:00" →
# hour_min; "before noon" / "until 5pm" / "by 3pm" → hour_max; "between 2pm and
# 5pm" / "from 9am to 5pm" / "2pm-5pm" → both. Distinct from
# _detect_end_time_filter, which needs an end/finish verb and reads _action_end.
# Returns {} when no range phrase with a parseable clock hour is present, so a
# bare "at 4pm" / "hour 16" still falls through to the exact-hour _detect_hour
# path. Fixes the long-standing bug where "after 4pm" scoped to EXACTLY hour 16
# (16:00-16:59) instead of 16:00 onward.
_RANGE_BETWEEN_RE = re.compile(
    r"\b(?:between|from)\s+(.+?)\s+(?:and|to|through|thru|till|until|[-–—])\s+(.+)",
    re.IGNORECASE)
_RANGE_AFTER_RE = re.compile(
    r"\b(?:after|since|from|starting(?:\s+(?:at|from))?|onwards?"
    r"|at\s+or\s+after|no\s+earlier\s+than)\b", re.IGNORECASE)
_RANGE_BEFORE_RE = re.compile(
    r"\b(?:before|until|till|up\s+to|by|earlier\s+than|prior\s+to"
    r"|no\s+later\s+than)\b", re.IGNORECASE)


def _bare_hour(text):
    """Clock hour from a short span: _detect_hour first, then a bare 0-23 int.
    Skips the bare-int fallback when the span carries a duration unit so
    'between 2 and 5 minutes' is not misread as an hour range."""
    h = _detect_hour(text)
    if h is not None:
        return h
    if re.search(r"\b(?:" + _DUR_UNIT_ALT + r")\b", text, re.IGNORECASE):
        return None
    m = re.search(r"\b(\d{1,2})\b", text)
    if m and 0 <= int(m.group(1)) <= 23:
        return int(m.group(1))
    return None


def _detect_hour_range(question):
    """Parse a start-of-action clock-hour RANGE into {hour_min, hour_max} (either,
    both, or neither). filter_rows applies these as dt.hour >= min / <= max."""
    mb = _RANGE_BETWEEN_RE.search(question)
    if mb:
        out = {}
        lo = _bare_hour(mb.group(1))
        hi = _bare_hour(mb.group(2))
        if lo is not None:
            out["hour_min"] = lo
        if hi is not None:
            out["hour_max"] = hi
        if out:
            return out
    out = {}
    ma = _RANGE_AFTER_RE.search(question)
    if ma:
        h = _detect_hour(question[ma.end():])
        if h is not None:
            out["hour_min"] = h
    mbf = _RANGE_BEFORE_RE.search(question)
    if mbf:
        h = _detect_hour(question[mbf.end():])
        if h is not None:
            out["hour_max"] = h
    return out


def parse_query(question, dataset_id):
    """Deterministically parse a question into an aggregation spec.

    Returns a dict { filters, group_by, matched } when the question names a
    concrete filter (user / story / action / session / date / hour) OR a
    group-by breakdown, else None. Entity names are validated against the
    actual dataset so analytical phrasings ('for each user') never become a
    bogus user filter.
    """
    if not question or not dataset_id:
        return None
    import mesh_store as _ms
    entry = _ms.get_dataset(dataset_id)
    if not entry:
        return None
    rows = entry.get("rows", []) or []
    if not rows:
        return None

    known_users   = {r.get("user") for r in rows if r.get("user")}
    known_stories = {r.get("story_name") for r in rows if r.get("story_name")}
    known_actions = {r.get("action_name") for r in rows if r.get("action_name")}
    known_sessions = {r.get("session_id") for r in rows if r.get("session_id")}

    filters = {}
    users = _detect_users(question, known_users)
    if len(users) >= 2:
        filters["users"] = users          # comparison across several users
    elif len(users) == 1:
        filters["user"] = users[0]
    else:
        user = _detect_user(question, known_users)  # possessive / prefix phrasings
        if user:
            filters["user"] = user
    story = _detect_entity(question, known_stories)
    if story:
        filters["story"] = story
    action = _detect_entity(question, known_actions)
    if action:
        filters["action"] = action
    session = _detect_entity(question, known_sessions)
    if session:
        filters["session"] = session
    date = _detect_date(question, rows)
    if date:
        filters["date"] = date
    dur = _detect_duration_filter(question)
    if dur:
        filters.update(dur)
    dp = _detect_dominant_phase_filter(question)
    if dp:
        filters.update(dp)
    et = _detect_end_time_filter(question)
    if et:
        filters.update(et)

    # Start-of-action hour. When an end-time clause is present, parse the
    # start hour from only the text before the end/finish verb, so
    # 'ended after 3pm' sets end_hour_min=15 and NOT hour_of_day=15 too.
    hour_q = question
    if et:
        mk = _END_VERB_RE.search(question)
        if mk:
            hour_q = question[:mk.start()]
    # A RANGE phrase ("after 4pm", "before noon", "between 2pm and 5pm") takes
    # precedence over an exact single hour — otherwise "after 4pm" would scope to
    # only the 16:00 hour instead of 16:00 onward.
    hour_range = _detect_hour_range(hour_q)
    if hour_range:
        filters.update(hour_range)
    else:
        hour = _detect_hour(hour_q)
        if hour is not None:
            filters["hour_of_day"] = hour

    group_by = _detect_group_by(question.lower())
    # A multi-user comparison with no explicit breakdown → group by user so the
    # aggregation yields one row of stats per named user (not a single blended slice).
    if filters.get("users") and not group_by:
        group_by = "user"

    if not filters and not group_by:
        return None
    return {"filters": filters, "group_by": group_by,
            "matched": {"users": len(known_users), "stories": len(known_stories)}}


# ─── rendering the result for an LLM prompt ───────────────────────────────────

def _fmt_filters(filters):
    """Human-readable filter description, e.g. 'user=NROS, hour_of_day=11'."""
    parts = []
    for k, v in (filters or {}).items():
        if isinstance(v, (list, tuple)):
            parts.append(f"{k}={', '.join(str(x) for x in v)}")
        else:
            parts.append(f"{k}={v}")
    return ", ".join(parts)


def format_answer(spec, agg):
    """One authoritative, deterministic sentence answering the scoped query.

    This is computed from the aggregation — never from any full-dataset ranking —
    so the agent can open with it verbatim and cannot contradict the real count.
    """
    if not agg or not agg.get("groups"):
        return ""
    filters  = spec.get("filters", {})
    group_by = agg.get("group_by")
    total    = agg.get("total_matching", 0)
    fdesc    = _fmt_filters(filters)
    scope    = f" ({fdesc})" if fdesc else ""

    if not group_by:
        # Scalar scoped count — the single number that answers the question.
        return f"{total} matching action{'s' if total != 1 else ''}{scope}."

    groups = agg.get("groups", [])
    label  = {"hour": "Hour", "day": "Date", "weekday": "Weekday",
              "month": "Month", "user": "User", "story": "Story",
              "action": "Action", "session": "Session",
              "dominant_phase": "Dominant phase"}.get(group_by, "Group")
    if groups:
        top = groups[0]
        return (f"{total} matching action{'s' if total != 1 else ''}{scope} "
                f"across {len(groups)} {group_by} group{'s' if len(groups) != 1 else ''}; "
                f"top {label.lower()}: {top.get('group','?')} ({top.get('count',0)} actions).")
    return f"{total} matching actions{scope}."


def format_aggregation(spec, agg):
    """Render an aggregate_rows result as a compact markdown table for prompts."""
    if not agg or not agg.get("groups"):
        return ""
    filters = spec.get("filters", {})
    group_by = agg.get("group_by")
    parts = ["## On-demand breakdown (computed from the full dataset)"]
    if filters:
        desc = _fmt_filters(filters)
        parts.append(f"Filters: {desc}")
    parts.append(f"Matching actions: {agg.get('total_matching', 0)}")
    label = {"hour": "Hour", "day": "Date", "weekday": "Weekday",
             "month": "Month", "user": "User", "story": "Story",
             "action": "Action", "session": "Session",
             "dominant_phase": "Dominant phase"}.get(group_by, "Group")
    parts.append("")
    # Phase columns are appended only when the groups actually carry phase data,
    # so count-only breakdowns ("actions by hour") stay narrow.
    has_phase = any(
        any(k in g for k in ("avg_frontend_ms", "avg_network_ms", "avg_backend_ms"))
        for g in agg["groups"]
    )
    if has_phase:
        parts.append(
            f"| {label} | Count | Median ms | p90 ms | Max ms | Total ms | "
            f">Threshold | Avg FE ms | Avg NW ms | Avg BE ms |")
        parts.append("|---|---|---|---|---|---|---|---|---|---|")
        for g in agg["groups"]:
            parts.append(
                f"| {g.get('group','?')} | {g.get('count',0)} | "
                f"{g.get('median_ms','—')} | {g.get('p90_ms','—')} | "
                f"{g.get('max_ms','—')} | {g.get('total_duration_ms','—')} | "
                f"{g.get('over_threshold','—')} | {g.get('avg_frontend_ms','—')} | "
                f"{g.get('avg_network_ms','—')} | {g.get('avg_backend_ms','—')} |"
            )
    else:
        parts.append(f"| {label} | Count | Median ms | p90 ms | Max ms | Total ms | >Threshold |")
        parts.append("|---|---|---|---|---|---|---|")
        for g in agg["groups"]:
            parts.append(
                f"| {g.get('group','?')} | {g.get('count',0)} | "
                f"{g.get('median_ms','—')} | {g.get('p90_ms','—')} | "
                f"{g.get('max_ms','—')} | {g.get('total_duration_ms','—')} | "
                f"{g.get('over_threshold','—')} |"
            )
    return "\n".join(parts)
