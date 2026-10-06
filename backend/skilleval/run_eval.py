"""
run_eval.py — Phase 0 driver: benchmark × paraphrase × reps → rollout → score.

Ties the harness together:
  benchmark.json  (paraphrase families, owner, answer fields, truth specs, guards)
  ground_truth.json (frozen truths, via ground_truth.resolve_truth)
  payload.json    (the exact agent input, via rollout.run_rollout)
  scoring.py      (comparators + weighted total + family/agent aggregation)

Every rollout runs in AUTO mode so routing (0.20) is scored honestly alongside
answer (0.50), schema (0.15) and guardrails (0.15). Prints a per-agent table
(the numbers the optimization loop hill-climbs) and writes results.json.

Usage:
  python run_eval.py [--reps N] [--entries id1,id2] [--max-paraphrases K]
"""
from __future__ import annotations
import argparse
import json
import re
import sys
from pathlib import Path

import scoring
import ground_truth as gtmod
import rollout

_HERE = Path(__file__).resolve().parent

# agent_outputs key (orchestrate.py) → skill name used in benchmark/routing
KEY_TO_SKILL = {
    "stats": "stats-agent", "anomaly": "anomaly-agent",
    "root_cause": "root-cause-agent", "explorer": "explorer-agent",
    "trace": "trace-agent", "narrator": "narrator",
}
OWNER_TO_KEY = {v: k for k, v in KEY_TO_SKILL.items()}
GROUP_NAME_FIELDS = ("group", "entity_value", "value", "label", "name", "user", "entity", "key",
                     "type_key", "category", "type")
# Statuses that mean the agent did NOT produce a usable contract. Any other
# status (CONFIRMED, NO_DATA, AWAITING_USER_DIRECTION, …) is a valid schema.
SCHEMA_FAILURE_STATUSES = {"PARSE_ERROR", "ERROR", "FAILED", ""}


# ── path resolution over an agent's output JSON ───────────────────────────────
def resolve_path(obj, path: str):
    """Resolve a dotted path with `[]` (project field over a list) and `[i]`
    (index) segments. Returns None on any miss."""
    cur = obj
    for seg in path.split("."):
        m = re.match(r"^([^\[\]]*)((?:\[\d*\])*)$", seg)
        if not m:
            return None
        key, brackets = m.group(1), m.group(2)
        if key:
            if isinstance(cur, dict) and key in cur:
                cur = cur[key]
            else:
                return None
        for b in re.findall(r"\[(\d*)\]", brackets):
            if b == "":  # [] → project remaining handled by caller; here collect list
                if not isinstance(cur, list):
                    return None
                # projection marker: return list as-is; field extraction done below
                return cur
            else:
                i = int(b)
                if isinstance(cur, list) and 0 <= i < len(cur):
                    cur = cur[i]
                else:
                    return None
    return cur


def resolve_answer(agent_out, path: str):
    """Resolve an answer path, handling the `list[].field` projection form."""
    if "[]" in path:
        before, after = path.split("[]", 1)
        after = after.lstrip(".")
        lst = resolve_path(agent_out, before.rstrip("."))
        if not isinstance(lst, list):
            return None
        if not after:
            return lst
        return [resolve_path(item, after) for item in lst if isinstance(item, dict)]
    return resolve_path(agent_out, path)


def normalize_ranking(actual):
    """Coerce a ranking answer (list of dicts or scalars) to group-name strings."""
    if not isinstance(actual, list):
        return []
    out = []
    for it in actual:
        if isinstance(it, dict):
            for f in GROUP_NAME_FIELDS:
                if f in it:
                    out.append(it[f]); break
        else:
            out.append(it)
    return out


# ── scoring one rollout for one benchmark entry ───────────────────────────────
def score_rollout(entry, roll, gt) -> scoring.RolloutScore:
    owner = entry["owner"]
    okey = OWNER_TO_KEY.get(owner)
    agent_out = (roll["agent_outputs"] or {}).get(okey) if okey else None
    detail = {}

    # ── answer (0.50) ──
    checks = []
    for f in entry.get("answer_fields", []):
        path, match = f["path"], f["match"]
        expected = gtmod.resolve_truth(f["truth"], gt)
        if path == "agents_run":  # orchestrator routing membership
            actual = sorted(KEY_TO_SKILL.get(k, k) for k in (roll["agent_outputs"] or {}))
        else:
            actual = resolve_answer(agent_out, path) if agent_out else None
        if match == "numeric":
            s = scoring.compare_numeric(actual, expected)
        elif match == "count":
            s = scoring.compare_count(actual, expected)
        elif match == "pct":
            s = scoring.compare_pct(actual, expected)
        elif match == "exact":
            s = scoring.compare_exact(actual, expected)
        elif match == "set_f1":
            # Agents may emit set members as dicts ({"key": "slow_action", ...})
            # or as plain strings; normalize dict lists to their category names
            # so F1 compares like-for-like against the truth's string set.
            a = normalize_ranking(actual) if isinstance(actual, list) else []
            s = scoring.set_f1(a, expected)
        elif match == "top1_and_overlap":
            a = normalize_ranking(actual)
            k = int(f.get("k", 5))
            s = 0.5 * scoring.top1_correct(a, expected) + 0.5 * scoring.rank_overlap_at_k(a, expected, k)
        else:
            s = 0.0
        checks.append(s)
        detail[f"answer:{path}"] = {"actual": actual, "expected": expected, "match": match, "score": s}
    answer = scoring.score_answer_fields(checks)

    # ── routing (0.20) ──
    routing = 1.0 if roll.get("intent") == entry.get("expected_intent") else 0.0
    detail["routing"] = {"intent": roll.get("intent"), "expected": entry.get("expected_intent"), "score": routing}

    # ── schema (0.15): owner agent present, CONFIRMED, answer paths resolvable ──
    if owner == "orchestrator":
        schema = 1.0 if roll.get("intent") else 0.0
    elif not agent_out:
        schema = 0.0
    else:
        status_ok = str(agent_out.get("status", "")).upper() not in SCHEMA_FAILURE_STATUSES
        paths_ok = all(
            detail[f"answer:{fl['path']}"]["actual"] is not None
            for fl in entry.get("answer_fields", []) if fl["path"] != "agents_run"
        )
        notes_ok = isinstance(agent_out.get("session_notes"), list)
        schema = (status_ok + paths_ok + notes_ok) / 3.0
    detail["schema"] = {"score": schema}

    # ── guardrails (0.15) ──
    guard_scores = []
    resp = roll.get("response_text", "") or ""
    for g in entry.get("guardrails", []):
        if g == "session_notes_present":
            gs = 1.0 if (agent_out and isinstance(agent_out.get("session_notes"), list)) or \
                        isinstance(roll.get("session_notes"), list) else 0.0
        elif g == "no_kpi_values":
            # trace must not leak KPI-style durations ("22.6 s", "N ms", "Mm Ss")
            leak = re.search(r"\b\d+(?:\.\d+)?\s*(?:ms|s)\b|\b\d+m\s*\d+s\b", resp)
            gs = 0.0 if leak else 1.0
        elif g == "tables_before_json":
            ti = resp.find("|")
            ji = resp.find("```json")
            gs = 1.0 if ti != -1 and (ji == -1 or ti < ji) else 0.0
        elif g in ("prose_faithful_judge", "headline_faithful_judge",
                   "no_fabricated_numbers", "no_leakage"):
            gs = None  # LLM-judge / deferred — recorded, excluded from the mean
        else:
            gs = None
        detail[f"guard:{g}"] = gs
        if gs is not None:
            guard_scores.append(gs)
    guardrail = scoring.mean(guard_scores) if guard_scores else 1.0

    return scoring.RolloutScore(
        entry_id=entry["id"], owner=owner, paraphrase=roll["_paraphrase"], rep=roll["_rep"],
        answer=answer, routing=routing, schema=schema, guardrail=guardrail, detail=detail,
    )


# ── main ──────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reps", type=int, default=5)
    ap.add_argument("--entries", type=str, default="", help="comma-separated entry ids to run")
    ap.add_argument("--max-paraphrases", type=int, default=0, help="cap paraphrases per entry (0 = all)")
    args = ap.parse_args()

    if not rollout.llm_configured():
        print("ERROR: no LLM configured (backend/.env). Cannot run rollouts.", file=sys.stderr)
        sys.exit(2)

    bench = json.loads((_HERE / "benchmark.json").read_text(encoding="utf-8"))
    gt = gtmod.load_ground_truth()
    payload = json.loads((_HERE / "payload.json").read_text(encoding="utf-8"))
    dataset_id = gt["dataset_id"]

    wanted = set(x.strip() for x in args.entries.split(",") if x.strip())
    entries = [e for e in bench["entries"] if not wanted or e["id"] in wanted]

    all_scores: list[scoring.RolloutScore] = []
    total_rollouts = sum(
        len(e["paraphrases"] if not args.max_paraphrases else e["paraphrases"][:args.max_paraphrases]) * args.reps
        for e in entries
    )
    done = 0
    for e in entries:
        paras = e["paraphrases"]
        if args.max_paraphrases:
            paras = paras[:args.max_paraphrases]
        for para in paras:
            for rep in range(args.reps):
                roll = rollout.run_rollout(para, payload, dataset_id, "auto")
                roll["_paraphrase"] = para
                roll["_rep"] = rep
                sc = score_rollout(e, roll, gt)
                all_scores.append(sc)
                done += 1
                flag = "" if not roll["error"] else f" ERR:{roll['error'][:40]}"
                print(f"[{done}/{total_rollouts}] {e['id']:24s} r{rep} "
                      f"tot={sc.total:.2f} a={sc.answer:.2f} rt={sc.routing:.0f} "
                      f"sc={sc.schema:.2f} g={sc.guardrail:.2f}{flag}", file=sys.stderr)

    # aggregate
    by_entry: dict[str, list] = {}
    for s in all_scores:
        by_entry.setdefault(s.entry_id, []).append(s)
    families = [scoring.aggregate_family(v) for v in by_entry.values()]
    by_agent = scoring.aggregate_by_agent(families)

    print("\n================ PER-ENTRY ================")
    for fam in sorted(families, key=lambda f: f.mean):
        print(f"  {fam.entry_id:24s} owner={fam.owner:16s} mean={fam.mean:.3f} brittleness={fam.brittleness:.4f}")
    print("\n================ PER-AGENT (hill-climb target) ================")
    for agent, m in sorted(by_agent.items(), key=lambda kv: kv[1]["score"]):
        print(f"  {agent:18s} score={m['score']:.3f} brittleness={m['brittleness']:.4f} entries={m['entries']}")
    overall = scoring.mean([f.mean for f in families]) if families else 0.0
    print(f"\nOVERALL mean total: {overall:.3f}  ({len(all_scores)} rollouts, {len(families)} families)")

    out = {
        "overall_mean": overall,
        "reps": args.reps,
        "per_agent": by_agent,
        "per_entry": {f.entry_id: {"owner": f.owner, "mean": f.mean, "brittleness": f.brittleness,
                                   "per_paraphrase": f.per_paraphrase_mean} for f in families},
        "rollouts": [{"entry": s.entry_id, "owner": s.owner, "paraphrase": s.paraphrase, "rep": s.rep,
                      "total": s.total, "answer": s.answer, "routing": s.routing,
                      "schema": s.schema, "guardrail": s.guardrail, "detail": s.detail}
                     for s in all_scores],
    }
    (_HERE / "results.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
    print("wrote results.json")


if __name__ == "__main__":
    main()
