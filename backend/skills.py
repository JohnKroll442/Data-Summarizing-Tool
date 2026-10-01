"""
skills_loader.py — Single-source-of-truth agent skill registry.

Composes each agent's system prompt from three parts:
  1. Shared preamble  (skills/_shared/preamble.md)
  2. Agent SKILL.md   (skills/<agent>/SKILL.md, frontmatter stripped)
  3. Mode overlay     (skills/_shared/pipeline-overlay.md)

The public API is identical to the old monolithic skills.py:

    from skills_loader import get_skill, AVAILABLE_SKILLS

    prompt = get_skill("stats_agent")
    skills = AVAILABLE_SKILLS

To switch over: rename this file to skills.py (replacing the old monolith).
"""

import re
from pathlib import Path as _Path

# ── Paths ─────────────────────────────────────────────────────────────────────

_BACKEND_DIR = _Path(__file__).parent
_PROJECT_ROOT = _BACKEND_DIR.parent
_SKILLS_DIR = _PROJECT_ROOT / "skills"
_SHARED_DIR = _SKILLS_DIR / "_shared"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _read(path: _Path) -> str:
    """Read a file as UTF-8 text."""
    return path.read_text(encoding="utf-8")


def _strip_frontmatter(text: str) -> str:
    """Remove YAML frontmatter (---...---) from the top of a SKILL.md file."""
    return re.sub(r"\A---\s*\n.*?\n---\s*\n", "", text, count=1, flags=re.DOTALL)


def _load_skill_body(skill_dir_name: str) -> str:
    """Load a SKILL.md file, strip its YAML frontmatter, return the body."""
    path = _SKILLS_DIR / skill_dir_name / "SKILL.md"
    return _strip_frontmatter(_read(path))


# Matches a `references/<name>.md` citation anywhere in a SKILL body.
_REF_CITATION_RE = re.compile(r"references/([A-Za-z0-9_\-]+\.md)")


def _inline_references(skill_dir_name: str, body: str) -> str:
    """Inline every `references/<name>.md` file the SKILL body actually cites.

    The composed prompt string is the ONLY text the backend LLM ever sees — the
    runtime never opens the referenced files. So an agent instructed to "read the
    label and description verbatim from references/anomaly-type-reference.md" or
    "read verbatim from references/root-cause-catalogue.md" had no catalogue in
    front of it and fell back to inventing labels / root causes. This inlines the
    canonical content of each cited, existing reference file, in citation order,
    under a clearly delimited section appended to the body.

    Only files the body NAMES are inlined (citation-driven), so uncited workspace
    files such as workspace-permissions.md are naturally left out.
    """
    ref_dir = _SKILLS_DIR / skill_dir_name / "references"
    if not ref_dir.is_dir():
        return body

    ordered_names = []
    for name in _REF_CITATION_RE.findall(body):
        if name not in ordered_names and (ref_dir / name).exists():
            ordered_names.append(name)
    if not ordered_names:
        return body

    parts = [
        body,
        "\n\n---\n\n# Inlined reference material (canonical — read verbatim)",
        "The files your steps cite under `references/` are reproduced below in "
        "full. This is the canonical source: when a step says to read a `label`, "
        "`description`, `root_cause`, `nature`, or pattern verbatim from one of "
        "these files, quote the text below exactly — never paraphrase or invent.",
    ]
    for name in ordered_names:
        content = _strip_frontmatter(_read(ref_dir / name)).strip()
        parts.append(f"\n\n## references/{name}\n\n{content}")
    return "\n".join(parts)


# ── Shared components (loaded once at import time) ────────────────────────────

_PREAMBLE = _read(_SHARED_DIR / "preamble.md")
_PIPELINE_OVERLAY = _read(_SHARED_DIR / "pipeline-overlay.md")


# ── Skill directory names → Python registry keys ─────────────────────────────
# Maps the snake_case keys used by get_skill() to the kebab-case directory names.

_SKILL_MAP = {
    "orchestrator":     {"dir": "orchestrator",     "scope_filter": False},
    "stats_agent":      {"dir": "stats-agent",      "scope_filter": True},
    "anomaly_agent":    {"dir": "anomaly-agent",    "scope_filter": True},
    "root_cause_agent": {"dir": "root-cause-agent", "scope_filter": True},
    "explorer_agent":   {"dir": "explorer-agent",   "scope_filter": True},
    "narrator":         {"dir": "narrator",         "scope_filter": True},
    "trace_agent":      {"dir": "trace-agent",      "scope_filter": False},
}


# ── Assemble each agent's full system prompt ──────────────────────────────────
# Default pattern: PREAMBLE + PIPELINE_OVERLAY + SKILL.md body
#
# The preamble contains: Output Quality Standards, Chart Directives, Scope Filter.
# The pipeline overlay contains: "Do all steps in one response, status=CONFIRMED".
# The SKILL.md body contains: Role, Capability, Input/Output Contract, Steps, Guard Rails.
#
# Skill-local pipeline overlay (opt-out): if a skill ships its own
# skills/<dir>/pipeline-overlay.md, that file is a SELF-CONTAINED backend prompt
# and REPLACES the default composition entirely (no preamble, no shared overlay,
# no interactive body). This exists for agents whose backend/pipeline behaviour
# diverges from their interactive SKILL.md — notably the orchestrator: its
# SKILL.md is the interactive Phase 0-5 workflow used by Joule, but in the
# backend its only job is Phase 0 intent classification returning a routing JSON.
# Composing the interactive body would make the classifier run the whole workflow
# (prose, no JSON) and every question would fall back to ANOMALY_SUMMARY.

SKILLS = {}
for _key, _cfg in _SKILL_MAP.items():
    _local_overlay = _SKILLS_DIR / _cfg["dir"] / "pipeline-overlay.md"
    if _local_overlay.exists():
        SKILLS[_key] = _strip_frontmatter(_read(_local_overlay))
    else:
        _body = _load_skill_body(_cfg["dir"])
        _body = _inline_references(_cfg["dir"], _body)
        SKILLS[_key] = _PREAMBLE + "\n\n" + _PIPELINE_OVERLAY + "\n\n" + _body


# ── Public API ────────────────────────────────────────────────────────────────

# Shown in the frontend dropdown — order matches a natural workflow
AVAILABLE_SKILLS = [
    {"key": "auto",            "label": "Auto — AI decides route"},
    {"key": "stats_agent",     "label": "Stats Agent — KPIs & latency"},
    {"key": "anomaly_agent",   "label": "Anomaly Agent — detected types"},
    {"key": "root_cause_agent","label": "Root Cause Agent — why anomalies occur"},
    {"key": "explorer_agent",  "label": "Explorer Agent — user & story rankings"},
    {"key": "trace_agent",     "label": "Trace Agent — widget-level drill (mesh)"},
    {"key": "narrator",        "label": "Narrator — full summary"},
]


def get_skill(name: str) -> str:
    """Return the system prompt for a named skill. Raises KeyError for unknown names."""
    skill = SKILLS.get(name)
    if skill is None:
        available = list(SKILLS.keys())
        raise KeyError(f"Unknown skill '{name}'. Available: {available}")
    return skill
