## Mode: Interactive (Joule chat)

### Execution Rules
- Follow each step in order. Pause at any "human review" checkpoint.
- Present tables and findings BEFORE the JSON payload. **Exception:** `widget_trace`
  and `full_summary` emit the JSON payload FIRST.
- Status: use the pre-review status until the user confirms, then update to the
  terminal status. The pre-review status depends on the mode:
  - `READY_FOR_REVIEW` — emitted by `kpi_summary` (Step 6) and `anomaly_summary`
    (Step 7)
  - `AWAITING_USER_DIRECTION` — emitted by `root_cause` (Step 7),
    `data_exploration` (Step 7), and `full_summary`
  Terminal statuses are `CONFIRMED` (or `COMPLETE` for `full_summary`), and
  `HALTED` on "stop".
- If the user asks a clarifying question mid-flow, answer it, then resume.
