---
description: Run lint, tests, and build, then smoke-check the app actually renders
allowed-tools: Bash(npm run *), Bash(npx vitest *), Skill(run), Skill(run:*)
---
Run these checks and report results **concisely** — PASS/FAIL per step, and only show output for steps that fail:

1. `npm run lint`
2. `npm run test:run`
3. `npm run build`

Then smoke-check that the app actually renders. IMPORTANT: the test harness has no render tests — lint, tests, and build all pass even when the app crashes on load. Use the `run` skill to launch the app and capture a screenshot, then confirm the main view renders (not a blank page or error overlay). Report the screenshot path.

Do not fix anything unless I ask — just report.
