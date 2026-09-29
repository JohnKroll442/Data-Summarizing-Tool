#!/bin/bash
# switch-to-skill-loader.sh
#
# Switches the backend from the monolithic skills.py to the new
# single-source-of-truth loader that reads from SKILL.md files.
#
# What this does:
#   1. Restores the original skills.py from git (in case it was damaged)
#   2. Backs up the old monolith as skills_monolith.py.bak
#   3. Renames skills_loader.py → skills.py
#   4. Cleans up the stale .txt files from backend/prompts/ that are
#      no longer needed (the new loader reads from skills/*/SKILL.md)
#
# Run from the project root: bash scripts/switch-to-skill-loader.sh

set -e

echo "=== Switching to SKILL.md-based loader ==="

# Step 1: Restore original skills.py from git (undo any damage)
echo "1. Restoring backend/skills.py from git..."
git checkout HEAD -- backend/skills.py

# Step 2: Back up the old monolith
echo "2. Backing up old monolith → backend/skills_monolith.py.bak"
cp backend/skills.py backend/skills_monolith.py.bak

# Step 3: Replace with the new loader
echo "3. Replacing skills.py with skills_loader.py"
cp backend/skills_loader.py backend/skills.py
rm backend/skills_loader.py

# Step 4: Clean up files that were created during the failed earlier refactor
echo "4. Cleaning up stale files..."
rm -f backend/prompts/_preamble.txt
rm -f backend/prompts/_scope_filter.txt
rm -f backend/prompts/trace_agent.txt

# Step 5: Restore any prompts/*.txt files that were overwritten
echo "5. Restoring original backend/prompts/ files from git..."
git checkout HEAD -- backend/prompts/

echo ""
echo "=== Done! ==="
echo ""
echo "The backend now reads agent prompts from skills/*/SKILL.md files."
echo "The old monolith is backed up at backend/skills_monolith.py.bak"
echo ""
echo "Structure:"
echo "  skills/_shared/preamble.md          ← Quality standards, charts, scope filter"
echo "  skills/_shared/pipeline-overlay.md   ← Pipeline mode behavior"
echo "  skills/_shared/interactive-overlay.md← Interactive mode behavior"  
echo "  skills/*/SKILL.md                   ← Each agent's single source of truth"
echo "  backend/skills.py                   ← Thin loader (~100 lines)"
echo ""
echo "Test: python -c \"import sys; sys.path.insert(0,'backend'); from skills import get_skill; print('OK:', len(get_skill('stats_agent')), 'chars')\""
