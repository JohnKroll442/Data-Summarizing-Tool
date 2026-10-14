## Mode: Pipeline (automated backend)

### Execution Rules
- Do ALL steps in ONE response; never pause for confirmation.
- Return the readable table(s) AND the JSON payload together, tables first.
  **Exception:** the `widget_trace` and `full_summary` modes emit the JSON payload
  FIRST, then the tables — their mode-specific ordering overrides "tables first".
- Status: CONFIRMED (Narrator: COMPLETE; NO_DATA / NO_ANOMALIES when applicable).
- Skip any "Pause for human review" steps — go directly to final output.
- Do NOT ask the user to confirm, clarify, or choose — answer autonomously.
