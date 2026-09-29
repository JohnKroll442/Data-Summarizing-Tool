# Shared Workspace — Canonical Schemas

This directory contains the single-source-of-truth schema files for the
COE Datasphere performance analysis agent mesh.

## Files

| File | Replaces | Consumed By |
|------|----------|-------------|
| `anomaly-types.json` | `anomaly-agent/references/anomaly-type-reference.md` + `root-cause-agent/references/root-cause-catalogue.md` | anomaly-agent, root-cause-agent, narrator, orchestrator |
| `kpi-schema.json` | `stats-agent/references/tool-data-schema.md` | stats-agent, narrator |
| `action-row-schema.json` | (implicit in SKILL.md contracts) | root-cause-agent, explorer-agent |
| `session-note-schema.json` | (implicit in SKILL.md contracts) | all agents |

## Design Principles

1. **One writer, one file** — Each schema file has a single maintainer (the skill author).
2. **Many readers** — Any agent that needs the schema imports it rather than maintaining a local copy.
3. **No duplication** — The old per-agent reference files contained overlapping definitions. This directory eliminates that overlap.
4. **Machine-readable** — JSON format enables future tooling (validation, diffing, codegen).

## Migration Status

- [x] Canonical schemas created
- [ ] Agent SKILL.md files updated to reference shared schemas
- [ ] Per-agent reference files deprecated (kept as fallback during transition)
- [ ] Runtime shared namespace implemented (Phase 2)
