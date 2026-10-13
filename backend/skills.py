"""
skills_loader.py — Single-source-of-truth agent skill registry.

Composes each agent's system prompt from three parts:
  1. Shared preamble  (skills/_shared/preamble.md)
  2. Agent SKILL.md   (skills/<agent>/SKILL.md, frontmatter stripped)
  3. Mode overlay     (skills/_shared/pipeline-overlay.md)

The public API is identical to the old monolithic skills.py:

    from skills_loader import get_skill, AVAILABLE_SKILLS

    prompt = get_skill("unified_agent")
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
    "orchestrator":  {"dir": "orchestrator",  "scope_filter": False},
    # Single merged analyst — replaces the six former specialist skills
    # (stats/anomaly/root-cause/explorer/trace/narrator). It performs one mode
    # per call, selected by the `agent_mode` field the backend injects into the
    # input. See skills/unified-agent/SKILL.md.
    "unified_agent": {"dir": "unified-agent", "scope_filter": True},
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


# ── Mode-specific unified prompts (token optimization) ────────────────────────
# The unified agent's full prompt contains all SIX `## MODE:` sections plus all
# four reference catalogues (~27k tokens). But the orchestrator ALWAYS resolves
# the mode BEFORE the analyst runs, so only one section is ever used per call.
# We pre-assemble a trimmed prompt per mode: shared preamble + overlay + the
# dispatch header + that ONE mode section + only the references that section
# cites. This cuts the system prompt 3–6× per call with zero behaviour change
# (the model received all six modes before but was told to follow only one).
# The full prompt stays in SKILLS["unified_agent"] as a fallback.

_MODE_SECTION_RE = re.compile(r"^={6,}\n## MODE: (\w+)\n={6,}", re.MULTILINE)


def _split_unified_body(body: str):
    """Split the unified SKILL body into (header, {mode_name: section_text}).

    header  — everything before the first `## MODE:` marker (dispatch rules and
              shared contract); prepended to every mode prompt.
    section — each `======\\n## MODE: X\\n======` block through to the next marker
              (or end-of-body for the last mode).
    Returns (None, {}) when the markers aren't found so callers fall back to the
    full prompt rather than emitting an empty one.
    """
    marks = list(_MODE_SECTION_RE.finditer(body))
    if not marks:
        return None, {}
    header = body[:marks[0].start()]
    sections = {}
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(body)
        sections[m.group(1)] = body[m.start():end]
    return header, sections


def _build_mode_skills(skill_dir_name: str) -> dict:
    """Pre-assemble a trimmed system prompt for each MODE of the unified skill."""
    body = _load_skill_body(skill_dir_name)
    header, sections = _split_unified_body(body)
    if header is None:
        return {}
    out = {}
    for mode, section in sections.items():
        mode_body = _inline_references(skill_dir_name, header + section)
        out[mode] = _PREAMBLE + "\n\n" + _PIPELINE_OVERLAY + "\n\n" + mode_body
    return out


UNIFIED_MODE_SKILLS = _build_mode_skills("unified-agent")


def get_skill_for_mode(mode: str) -> str:
    """Return the trimmed unified prompt for one `agent_mode`.

    Falls back to the full unified prompt for an unknown or missing mode, so a
    newly added mode can never yield an empty/wrong prompt — it just costs the
    old (full) token count until a section is added for it.
    """
    prompt = UNIFIED_MODE_SKILLS.get(mode)
    return prompt if prompt is not None else get_skill("unified_agent")



# ── Public API ────────────────────────────────────────────────────────────────

# Shown in the frontend dropdown. The six specialist agents were merged into one
# unified agent; "auto" (orchestrator classifies, unified agent answers) is the
# normal path. The explicit unified entry lets a user force the analyst directly.
AVAILABLE_SKILLS = [
    {"key": "auto",          "label": "Auto — AI decides route"},
    {"key": "unified_agent", "label": "Unified Agent — full analysis"},
]


def get_skill(name: str) -> str:
    """Return the system prompt for a named skill. Raises KeyError for unknown names."""
    skill = SKILLS.get(name)
    if skill is None:
        available = list(SKILLS.keys())
        raise KeyError(f"Unknown skill '{name}'. Available: {available}")
    return skill
