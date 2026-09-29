"""Syntax-check all three backend Python files and report errors."""
import ast
import os
import sys

base = os.path.join(os.getcwd(), "backend")
files = ["app.py", "skills.py", "orchestrate.py"]
errors = []

for f in files:
    path = os.path.join(base, f)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            source = fh.read()
        ast.parse(source)
        print(f"  {f}: OK ({len(source.splitlines())} lines)")
    except SyntaxError as e:
        errors.append(f)
        print(f"  {f}: SYNTAX ERROR at line {e.lineno}: {e.msg}")
    except FileNotFoundError:
        errors.append(f)
        print(f"  {f}: FILE NOT FOUND")

print()
if errors:
    print(f"FAILED: {len(errors)} file(s) with errors")
    sys.exit(1)
else:
    print("All 3 backend files pass syntax check")
