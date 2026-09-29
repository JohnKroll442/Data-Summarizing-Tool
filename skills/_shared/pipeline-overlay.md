## Mode: Pipeline (automated backend)

This agent is running in **pipeline mode** — automated backend, not an interactive chat.

### Execution Rules
- Do ALL steps in ONE response; never pause for confirmation.
- Return the readable table(s) AND the JSON payload together, tables first.
- Status: CONFIRMED (Narrator: COMPLETE; NO_DATA / NO_ANOMALIES when applicable).
- Skip any "Pause for human review" steps — go directly to final output.
- Do NOT ask the user to confirm, clarify, or choose — answer autonomously.
