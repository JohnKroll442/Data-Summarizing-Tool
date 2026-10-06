"""
scoring.py — domain-agnostic scoring for the skilleval harness.

No I/O, no dataset knowledge, no backend imports. Given an agent's captured
answer values and the recomputed ground truth, produce a 0..1 score; given many
scored rollouts, aggregate them into per-agent means and a brittleness (paraphrase
variance) metric.

Correctness definition: an answer matches iff it equals the recomputed truth
within the tolerance appropriate to its type. See README for the principle.
"""

from __future__ import annotations
import re
from dataclasses import dataclass, field
from statistics import mean, pvariance
from typing import Any, Iterable

# ── Approved weights ────────────────────────────────────────────────────────
W_ANSWER = 0.50
W_ROUTING = 0.20
W_SCHEMA = 0.15
W_GUARDRAIL = 0.15

# ── Approved tolerances ─────────────────────────────────────────────────────
TOL_REL = 0.005   # ±0.5% relative, for percentiles / durations
TOL_PP = 1.0      # ±1 percentage point, for pct fields
# Agents ECHO the payload's display-formatted KPI strings ("22.6 s"), which are
# rounded to a display granularity (0.1 s for the seconds band). Comparing a
# rounded display value against the precise recomputed truth can exceed the
# relative tolerance for small magnitudes, so allow a small absolute floor that
# absorbs one display-rounding step.
TOL_ABS_DISPLAY_MS = 150.0


# ── Formatted-value parsing ───────────────────────────────────────────────────
# Agents don't emit raw numbers — they echo the payload's formatted KPI strings
# (formatDurationMs / formatCount in src/lib/format.js). Parse those back to a
# canonical number: durations → milliseconds, counts → the integer.
_DUR_MS   = re.compile(r'^\s*(-?[\d.]+)\s*ms\s*$', re.I)
_DUR_S    = re.compile(r'^\s*(-?[\d.]+)\s*s\s*$', re.I)
_DUR_MMSS = re.compile(r'^\s*(-?)(\d+)\s*m\s*(\d+)\s*s\s*$', re.I)


def parse_measure(x: Any) -> float | None:
    """Parse a raw number OR a formatted KPI string into a canonical float.
    Durations are normalized to milliseconds; counts ("2,070", "47 (2%)") to
    their leading integer. Returns None if nothing numeric can be extracted."""
    if isinstance(x, bool):
        return None
    if isinstance(x, (int, float)):
        return float(x)
    if not isinstance(x, str):
        return None
    s = x.strip()
    if not s:
        return None
    # "Mm Ss" duration (e.g. "2m 30s", "172m 48s")
    m = _DUR_MMSS.match(s)
    if m:
        sign = -1.0 if m.group(1) == '-' else 1.0
        return sign * (int(m.group(2)) * 60 + int(m.group(3))) * 1000.0
    # "N ms" / "0.50 ms" — check ms BEFORE s (ms also ends in 's')
    m = _DUR_MS.match(s)
    if m:
        return float(m.group(1))
    # "N.N s" duration → milliseconds
    m = _DUR_S.match(s)
    if m:
        return float(m.group(1)) * 1000.0
    # count-with-share ("47 (2%)") → leading number; strip thousands separators
    head = s.split('(')[0].replace(',', '').strip()
    m = re.search(r'-?\d+(?:\.\d+)?', head)
    if m:
        return float(m.group(0))
    return None


# ── Comparators (each returns a 0..1 partial score) ──────────────────────────

def compare_count(actual: Any, expected: Any) -> float:
    """Exact integer match. Counts must be exact."""
    a, e = parse_measure(actual), parse_measure(expected)
    if a is None or e is None:
        return 0.0
    return 1.0 if round(a) == round(e) else 0.0


def compare_numeric(actual: Any, expected: Any, tol_rel: float = TOL_REL,
                    tol_abs: float | None = TOL_ABS_DISPLAY_MS) -> float:
    """Relative-tolerance match for percentiles / durations. Parses formatted
    strings ("22.6 s") on both sides. tol_abs is a display-rounding floor so an
    echoed, display-rounded value still matches the precise truth."""
    a, e = parse_measure(actual), parse_measure(expected)
    if a is None or e is None:
        return 0.0
    if e == 0:
        return 1.0 if abs(a) <= (tol_abs if tol_abs is not None else 1e-9) else 0.0
    if abs(a - e) <= abs(e) * tol_rel:
        return 1.0
    if tol_abs is not None and abs(a - e) <= tol_abs:
        return 1.0
    return 0.0


def compare_pct(actual: Any, expected: Any, tol_pp: float = TOL_PP) -> float:
    """Percentage-point tolerance for pct fields (e.g. total_flagged.pct)."""
    a, e = parse_measure(actual), parse_measure(expected)
    if a is None or e is None:
        return 0.0
    return 1.0 if abs(a - e) <= tol_pp else 0.0


def compare_exact(actual: Any, expected: Any) -> float:
    """Case-insensitive exact match for categorical strings (widget name,
    dominant phase, dimension, loading pattern, intent)."""
    if actual is None or expected is None:
        return 0.0
    return 1.0 if str(actual).strip().lower() == str(expected).strip().lower() else 0.0


def set_f1(actual: Iterable[Any], expected: Iterable[Any]) -> float:
    """F1 over sets — partial credit for type sets (anomaly types, root-cause
    categories, dispatched agents)."""
    a = {str(x).strip().lower() for x in (actual or [])}
    e = {str(x).strip().lower() for x in (expected or [])}
    if not a and not e:
        return 1.0
    if not a or not e:
        return 0.0
    tp = len(a & e)
    if tp == 0:
        return 0.0
    prec, rec = tp / len(a), tp / len(e)
    return 2 * prec * rec / (prec + rec)


def top1_correct(actual: list[Any], expected: list[Any]) -> float:
    """The #1 ranked item must be right — the headline of any ranking answer."""
    if not actual or not expected:
        return 0.0
    return compare_exact(actual[0], expected[0])


def rank_overlap_at_k(actual: list[Any], expected: list[Any], k: int) -> float:
    """Fraction of the true top-k that appear anywhere in the actual top-k
    (order-insensitive beyond top-1). Pair with top1_correct for order."""
    if not expected:
        return 1.0 if not actual else 0.0
    a = {str(x).strip().lower() for x in actual[:k]}
    e = {str(x).strip().lower() for x in expected[:k]}
    return len(a & e) / len(e) if e else 0.0


# ── Per-rollout score ─────────────────────────────────────────────────────────

@dataclass
class RolloutScore:
    """One question phrasing, one repetition, one graded rollout."""
    entry_id: str
    owner: str
    paraphrase: str
    rep: int
    answer: float = 0.0      # 0..1, mean of the entry's answer-field comparators
    routing: float = 0.0     # 0..1, right agent invoked
    schema: float = 0.0      # 0..1, required contract fields present & typed
    guardrail: float = 0.0   # 0..1, guard rails respected / no domain leakage
    detail: dict = field(default_factory=dict)  # per-check breakdown for reports

    @property
    def total(self) -> float:
        return (W_ANSWER * self.answer + W_ROUTING * self.routing
                + W_SCHEMA * self.schema + W_GUARDRAIL * self.guardrail)


def score_answer_fields(checks: list[float]) -> float:
    """Combine an entry's answer-field comparator results into one answer score."""
    return mean(checks) if checks else 0.0


# ── Aggregation ────────────────────────────────────────────────────────────────

@dataclass
class FamilyResult:
    entry_id: str
    owner: str
    per_paraphrase_mean: dict[str, float]   # paraphrase -> mean total over reps
    mean: float                             # mean total across the whole family
    brittleness: float                      # variance of per-paraphrase means

    @property
    def is_brittle(self, threshold: float = 0.05) -> bool:
        return self.brittleness > threshold


def aggregate_family(scores: list[RolloutScore]) -> FamilyResult:
    """Collapse all rollouts for one benchmark entry: mean over reps within a
    paraphrase, then mean + variance across paraphrases. High variance means the
    skill handles some phrasings and not others — the phrasing-brittleness signal."""
    if not scores:
        raise ValueError("no scores to aggregate")
    by_paraphrase: dict[str, list[float]] = {}
    for s in scores:
        by_paraphrase.setdefault(s.paraphrase, []).append(s.total)
    per_paraphrase_mean = {p: mean(v) for p, v in by_paraphrase.items()}
    family_means = list(per_paraphrase_mean.values())
    return FamilyResult(
        entry_id=scores[0].entry_id,
        owner=scores[0].owner,
        per_paraphrase_mean=per_paraphrase_mean,
        mean=mean(family_means),
        brittleness=pvariance(family_means) if len(family_means) > 1 else 0.0,
    )


def aggregate_by_agent(families: list[FamilyResult]) -> dict[str, dict[str, float]]:
    """Per-agent benchmark score (mean of its entries' means) and mean brittleness.
    This is the number the optimization loop hill-climbs, per agent."""
    by_agent: dict[str, list[FamilyResult]] = {}
    for f in families:
        by_agent.setdefault(f.owner, []).append(f)
    out: dict[str, dict[str, float]] = {}
    for agent, fams in by_agent.items():
        out[agent] = {
            "score": mean(f.mean for f in fams),
            "brittleness": mean(f.brittleness for f in fams),
            "entries": len(fams),
        }
    return out
