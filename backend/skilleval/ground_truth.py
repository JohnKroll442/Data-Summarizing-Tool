"""
ground_truth.py — thin reader over the frozen ground_truth.json.

No formulas live here. groundtruth_gen.mjs already ran the tool's OWN src/lib
functions against the fixed dataset and froze the answers; this module just
exposes them through the truth-fn registry that benchmark.json references
(`{"fn": "kpi_p90"}`, `{"fn": "top_user_by_frequency", "args": {"k": 5}}`, …).

Each registry entry is `callable(gt: dict, args: dict) -> Any`. The value it
returns is the `expected` side handed to the scoring comparators.
"""
from __future__ import annotations
import json
from pathlib import Path
from typing import Any, Callable

_HERE = Path(__file__).resolve().parent
_GT_PATH = _HERE / "ground_truth.json"


def load_ground_truth(path: Path | str | None = None) -> dict:
    """Load the frozen ground-truth JSON produced by groundtruth_gen.mjs."""
    p = Path(path) if path else _GT_PATH
    if not p.exists():
        raise FileNotFoundError(
            f"{p} not found — run groundtruth_gen.mjs first "
            "(node --import ./viteResolveShim.mjs groundtruth_gen.mjs <csv>)."
        )
    return json.loads(p.read_text(encoding="utf-8"))


# ── Truth-fn registry ─────────────────────────────────────────────────────────
# Keys MUST match the "fn" strings in benchmark.json. Ranking truths are returned
# as ordered lists of GROUP-NAME strings so scoring.top1_correct / rank_overlap
# compare like-for-like against the agent's extracted ranking.

def _kpi_p90(gt, args):                 return gt["kpi_p90"]
def _kpi_p95(gt, args):                 return gt["kpi_p95"]
def _kpi_median(gt, args):              return gt["kpi_median"]
def _kpi_over_threshold(gt, args):      return gt["kpi_over_threshold"]
def _anomaly_flagged_count(gt, args):   return gt["anomaly_flagged_count"]
def _anomaly_flagged_pct(gt, args):     return gt["anomaly_flagged_pct"]
def _anomaly_headline_types(gt, args):  return gt["anomaly_headline_types"]
def _root_cause_categories(gt, args):   return gt["root_cause_categories"]
def _busiest_hour(gt, args):            return gt["busiest_hour"]
def _bottleneck_widget(gt, args):       return gt["bottleneck_widget_worst_action"]
def _bottleneck_phase(gt, args):        return gt["bottleneck_dominant_phase"]


def _top_user_by_frequency(gt, args):
    """Ordered list of the top-k user group names by action frequency."""
    k = int((args or {}).get("k", 5))
    return [row["group"] for row in gt.get("top_user_by_frequency", [])[:k]]


def _expected_agents(gt, args):
    """Static routing target — the agents this question SHOULD dispatch."""
    return list((args or {}).get("agents", []))


REGISTRY: dict[str, Callable[[dict, dict], Any]] = {
    "kpi_p90": _kpi_p90,
    "kpi_p95": _kpi_p95,
    "kpi_median": _kpi_median,
    "kpi_over_threshold": _kpi_over_threshold,
    "anomaly_flagged_count": _anomaly_flagged_count,
    "anomaly_flagged_pct": _anomaly_flagged_pct,
    "anomaly_headline_types": _anomaly_headline_types,
    "root_cause_categories": _root_cause_categories,
    "top_user_by_frequency": _top_user_by_frequency,
    "busiest_hour": _busiest_hour,
    "bottleneck_widget_worst_action": _bottleneck_widget,
    "bottleneck_dominant_phase": _bottleneck_phase,
    "expected_agents": _expected_agents,
}


def resolve_truth(spec: dict, gt: dict) -> Any:
    """Resolve a benchmark truth spec `{"fn": ..., "args": {...}}` to its value."""
    fn = spec.get("fn")
    if fn not in REGISTRY:
        raise KeyError(f"unknown truth fn {fn!r}; known: {sorted(REGISTRY)}")
    return REGISTRY[fn](gt, spec.get("args") or {})


if __name__ == "__main__":
    gt = load_ground_truth()
    print(f"Loaded ground truth for dataset {gt.get('dataset_id')}:")
    # Smoke-resolve every truth fn referenced in the benchmark.
    bench = json.loads((_HERE / "benchmark.json").read_text(encoding="utf-8"))
    for entry in bench["entries"]:
        for field in entry.get("answer_fields", []):
            spec = field["truth"]
            try:
                val = resolve_truth(spec, gt)
                print(f"  {entry['id']:28s} {field['path']:28s} {spec['fn']:32s} -> {val}")
            except Exception as e:  # noqa: BLE001
                print(f"  {entry['id']:28s} {field['path']:28s} {spec['fn']:32s} -> ERROR {e}")
