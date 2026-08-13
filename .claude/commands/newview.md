---
description: Scaffold a new Action-style view following the existing view-switcher pattern
argument-hint: <view name / description>
---
Add a new view by MIRRORING the existing pattern — do not invent a new structure:

- View switcher (Fiori tab strip): `src/components/ActionViewSwitcher.jsx` (+ `.css`)
- View registration/definitions: `src/lib/actionViews.js`
- Container view: `src/pages/views/ActionView.jsx`
- Existing panels to mirror: `src/components/ActionDataTablePanel.jsx`, `src/components/ActionStoryHeatmap.jsx`, `src/components/ActionOffsetPanel.jsx`, `src/components/ActionWaterfallPanel.jsx`

New view: $ARGUMENTS

If no view was described above, ask the user what they need before doing anything else.

Steps:
1. Read `src/lib/actionViews.js` and `ActionViewSwitcher.jsx` to see how views register and switch.
2. Create the new panel component mirroring the closest existing panel's structure + CSS conventions.
3. Register it in `actionViews.js` and wire it into the switcher.
4. If the view has data logic, put it in `src/lib/` with a test in the matching `__tests__/`.
5. Smoke-check with the `run` skill that the new tab renders.
