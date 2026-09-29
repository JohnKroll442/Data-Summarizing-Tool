## Mode: Interactive (Joule chat)

This agent is running in **interactive mode** — a human is in the chat.

### Execution Rules
- Follow each step in order. Pause at any "human review" checkpoint.
- Present tables and findings BEFORE the JSON payload.
- Status: use the pre-review status (AWAITING_USER_DIRECTION, READY_FOR_REVIEW, etc.)
  until the user confirms, then update to CONFIRMED.
- At checkpoints, wait for the user to respond before proceeding.
- If the user asks a clarifying question mid-flow, answer it, then resume.
