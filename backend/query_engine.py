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
     r"|which\s+user|most\s+active\s+user|top\s+users?)\b", "user"),
    (r"\b(by\s+story|per\s+story|for\s+each\s+story|busiest\s+story|which\s+story"
     r"|top\s+stor(?:y|ies))\b", "story"),
    (r"\b(by\s+action|per\s+action|for\s+each\s+action|which\s+action|top\s+actions?"
     r"|most\s+(?:common|frequent)\s+action)\b", "action"),
    (r"\b(by\s+session|per\s+session|for\s+each\s+session|busiest\s+session"
     r"|which\s+session|top\s+sessions?)\b", "session"),
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


# ─── filtering + aggregation ────────────────────────────────────────────────

def _match(row_val, wanted):
    if wanted is None:
        return True
    return str(row_val or "").strip().lower() == str(wanted).strip().lower()


def filter_rows(rows, filters):
    """Apply a filter spec to action rows. Unknown/None filters are ignored."""
    filters = filters or {}
    user    = filters.get("user")
    story   = filters.get("story")
    action  = filters.get("action")
    session = filters.get("session")
    date    = filters.get("date")            # "YYYY-MM-DD"
    hour    = filters.get("hour_of_day")     # int 0-23
    dmin    = filters.get("duration_min_ms")
    dmax    = filters.get("duration_max_ms")

    out = []
    for r in rows:
        if not _match(r.get("user"), user):            continue
        if not _match(r.get("story_name"), story):     continue
        if not _match(r.get("action_name"), action):   continue
        if not _match(r.get("session_id"), session):   continue
        if date is not None or hour is not None:
            dt = _row_ts(r)
            if dt is None:
                continue
            if date is not None and dt.strftime("%Y-%m-%d") != date:
                continue
            if hour is not None and dt.hour != hour:
                continue
        if dmin is not None or dmax is not None:
            dur = _row_duration(r)
            if dur is None:
                continue
            if dmin is not None and dur < dmin:
                continue
            if dmax is not None and dur > dmax:
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
        result["groups"] = [{"group": "all", **bundle}]
        return result

    buckets = {}  # sort_key -> {"label": str, "durations": [..]}
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
        else:
            bk = None
        if bk is None:
            continue
        sort_key, label = bk
        buckets.setdefault(sort_key, {"label": label, "durations": []})
        buckets[sort_key]["durations"].append(_row_duration(r))

    is_time = group_by in ("hour", "day", "weekday", "month")
    for sort_key in sorted(buckets.keys(), key=lambda k: (k is None, k)) if is_time \
            else sorted(buckets.keys(), key=lambda k: -len(buckets[k]["durations"])):
        b = buckets[sort_key]
        result["groups"].append({"group": b["label"], **_metric_bundle(b["durations"], threshold_ms)})

    if not is_time and limit:
        result["groups"] = result["groups"][:limit]
    return result


# ─── natural-language query parsing (deterministic trigger) ───────────────────

def _detect_group_by(q_lower):
    for pattern, key in _GROUP_BY_PATTERNS:
        if re.search(pattern, q_lower):
            return key
    return None


def _detect_entity(question, known_values):
    """Return the known entity value whose name appears in the question, if any.

    Matches longest known value first so 'Sales Overview' wins over 'Sales'.
    Case-insensitive whole-substring match against the question text.
    """
    if not known_values:
        return None
    q_lower = question.lower()
    for val in sorted((v for v in known_values if v), key=lambda s: -len(str(s))):
        vs = str(val).strip()
        if len(vs) < 2:
            continue
        if vs.lower() in q_lower:
            return val
    return None


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
    """Parse an explicit clock hour like '3pm', '15:00', 'at 9 am'. Returns int or None."""
    m = re.search(r"\b(\d{1,2})\s*(am|pm)\b", question.lower())
    if m:
        h = int(m.group(1)) % 12
        return h + 12 if m.group(2) == "pm" else h
    m = re.search(r"\b(\d{1,2}):00\b", question)
    if m and 0 <= int(m.group(1)) <= 23:
        return int(m.group(1))
    return None


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
    user = _detect_user(question, known_users)
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
    hour = _detect_hour(question)
    if hour is not None:
        filters["hour_of_day"] = hour

    group_by = _detect_group_by(question.lower())

    if not filters and not group_by:
        return None
    return {"filters": filters, "group_by": group_by,
            "matched": {"users": len(known_users), "stories": len(known_stories)}}


# ─── rendering the result for an LLM prompt ───────────────────────────────────

def format_aggregation(spec, agg):
    """Render an aggregate_rows result as a compact markdown table for prompts."""
    if not agg or not agg.get("groups"):
        return ""
    filters = spec.get("filters", {})
    group_by = agg.get("group_by")
    parts = ["## On-demand breakdown (computed from the full dataset)"]
    if filters:
        desc = ", ".join(f"{k}={v}" for k, v in filters.items())
        parts.append(f"Filters: {desc}")
    parts.append(f"Matching actions: {agg.get('total_matching', 0)}")
    label = {"hour": "Hour", "day": "Date", "weekday": "Weekday",
             "month": "Month", "user": "User", "story": "Story",
             "action": "Action", "session": "Session"}.get(group_by, "Group")
    parts.append("")
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
