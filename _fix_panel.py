"""Truncate AgentChatPanel.jsx — keep only the first 211 lines (valid new component)."""
import os

target = os.path.join(os.getcwd(), "src", "components", "AgentChatPanel.jsx")

with open(target, "r", encoding="utf-8") as f:
    lines = f.readlines()

valid = lines[:211]
if valid and not valid[-1].endswith("\n"):
    valid[-1] += "\n"

with open(target, "w", encoding="utf-8") as f:
    f.writelines(valid)

print(f"Done. Kept {len(valid)} lines, removed {len(lines) - len(valid)} leftover lines.")
