"""One-shot recovery: rebuild skills.py from the valid compiled .pyc after the
source file was truncated. Verifies the reconstruction matches the .pyc exactly
before overwriting."""
import importlib.util, io, os, shutil, sys

PYC = "__pycache__/skills.cpython-314.pyc"
spec = importlib.util.spec_from_file_location("skills_pyc", PYC)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

# Order: helpers first (cosmetic), then final prompt constants, then wiring.
STR_ORDER = [
    "PIPELINE_PREAMBLE", "_SCOPE_FILTER", "_ORCHESTRATOR_CAPABILITY_CATALOGUE",
    "_TOOL_DATA_SCHEMA", "_ANOMALY_TYPE_REFERENCE", "_ROOT_CAUSE_CATALOGUE",
    "_WIDGET_TRACE_PATTERNS",
    "ORCHESTRATOR_PROMPT", "STATS_AGENT_PROMPT", "ANOMALY_AGENT_PROMPT",
    "ROOT_CAUSE_AGENT_PROMPT", "EXPLORER_AGENT_PROMPT", "NARRATOR_PROMPT",
    "TRACE_AGENT_PROMPT",
]
SKILLS_MAP = [
    ("orchestrator", "ORCHESTRATOR_PROMPT"),
    ("stats_agent", "STATS_AGENT_PROMPT"),
    ("anomaly_agent", "ANOMALY_AGENT_PROMPT"),
    ("root_cause_agent", "ROOT_CAUSE_AGENT_PROMPT"),
    ("explorer_agent", "EXPLORER_AGENT_PROMPT"),
    ("narrator", "NARRATOR_PROMPT"),
    ("trace_agent", "TRACE_AGENT_PROMPT"),
]

# Sanity: every string is triple-quote/backslash safe.
for n in STR_ORDER:
    v = getattr(m, n)
    assert '"""' not in v and "\\" not in v and not v.endswith('"'), f"unsafe: {n}"

# Verify our assumed SKILLS mapping against the real dict.
for key, const in SKILLS_MAP:
    assert m.SKILLS[key] == getattr(m, const), f"SKILLS[{key}] != {const}"
assert list(m.SKILLS.keys()) == [k for k, _ in SKILLS_MAP], "SKILLS key order mismatch"

out = io.StringIO()
out.write('"""Agent skill prompts and the get_skill lookup.\n\n')
out.write("Reconstructed from the compiled module after the source was truncated;\n")
out.write("values are byte-for-byte identical to the last valid compile.\n\n")
out.write("Usage:\n")
out.write('    from skills import get_skill, AVAILABLE_SKILLS\n')
out.write('    prompt = get_skill("stats_agent")   # raises KeyError for unknown names\n')
out.write('    skills = AVAILABLE_SKILLS           # list of { key, label } for the UI dropdown\n')
out.write('"""\n\n')

for n in STR_ORDER:
    v = getattr(m, n)
    out.write(f'{n} = """{v}"""\n\n')

out.write("SKILLS = {\n")
for key, const in SKILLS_MAP:
    out.write(f'    "{key}": {const},\n')
out.write("}\n\n")

out.write(f"AVAILABLE_SKILLS = {m.AVAILABLE_SKILLS!r}\n\n")

out.write("def get_skill(name):\n")
out.write('    """Return the system prompt for an agent skill. Raises KeyError if unknown."""\n')
out.write("    return SKILLS[name]\n")

src = out.getvalue()

# Verify: compiles, re-imports, values match .pyc exactly.
ns = {}
exec(compile(src, "skills_rebuilt", "exec"), ns)
for n in STR_ORDER + ["AVAILABLE_SKILLS"]:
    assert ns[n] == getattr(m, n), f"value mismatch after rebuild: {n}"
for key, _ in SKILLS_MAP:
    assert ns["get_skill"](key) == m.get_skill(key), f"get_skill mismatch: {key}"
try:
    ns["get_skill"]("____nope____"); raise SystemExit("get_skill should raise KeyError")
except KeyError:
    pass

# Back up the corrupted file, then write the recovered source as UTF-8.
shutil.copyfile("skills.py", "skills.py.corrupted.bak")
with open("skills.py", "w", encoding="utf-8", newline="\n") as f:
    f.write(src)

print("RECOVERY OK")
print("  wrote skills.py  (%d bytes, %d lines)" % (len(src), src.count("\n") + 1))
print("  backup: skills.py.corrupted.bak")
print("  verified: 14 strings + AVAILABLE_SKILLS + get_skill match the .pyc")
