# Explorer Agent — Validation Scenarios

Three scenarios that must pass before the Explorer Agent is marked ready.
Run each by pasting the **Input** block into the Joule chat panel (with the
Explorer Agent skill active). Compare the actual output to the **Expected
output** section. All three must pass for the skill to be confirmed.

---

## Scenario 1 — Ranking mode: "Which user appeared most?"

Tests that the agent reads `by_user[]` from the payload, shows ALL users (no
top-N cap), and pauses at the checkpoint.

### Input

Paste this JSON as the injected payload, then type the question below.

```json
{
  "data_summary": {
    "total_actions": 500,
    "total_unique_users": 4,
    "total_unique_stories": 3,
    "total_unique_action_types": 8,
    "by_user": [
      { "user": "DVIJAYAN",      "action_count": 145, "pct_of_total": 29.0 },
      { "user": "KRAJAGOPALAN",  "action_count":  89, "pct_of_total": 17.8 },
      { "user": "MARIOMENDOZA",  "action_count":  78, "pct_of_total": 15.6 },
      { "user": "SUPPORTUSER01", "action_count":  62, "pct_of_total": 12.4 },
      { "user": "ANANDKUMAR",    "action_count":  57, "pct_of_total": 11.4 },
      { "user": "RPATIL",        "action_count":  36, "pct_of_total":  7.2 },
      { "user": "TJONES",        "action_count":  33, "pct_of_total":  6.6 }
    ],
    "by_story": [
      { "story_name": "LS_OPEX_SG&A_PM_STORY",  "action_count": 210, "pct_of_total": 42.0 },
      { "story_name": "LS_WFP_CORP_PM_STORY",   "action_count": 180, "pct_of_total": 36.0 },
      { "story_name": "LS_REVENUE_ANALYSIS",    "action_count": 110, "pct_of_total": 22.0 }
    ],
    "by_action": [
      { "action_name": "Display Vendor Invoice",  "action_count": 87, "pct_of_total": 17.4 },
      { "action_name": "Post Document",           "action_count": 72, "pct_of_total": 14.4 },
      { "action_name": "Run Report",              "action_count": 68, "pct_of_total": 13.6 },
      { "action_name": "Input control changed",   "action_count": 55, "pct_of_total": 11.0 },
      { "action_name": "Apply filter",            "action_count": 48, "pct_of_total":  9.6 },
      { "action_name": "Export to Excel",         "action_count": 43, "pct_of_total":  8.6 },
      { "action_name": "Open story",              "action_count": 38, "pct_of_total":  7.6 },
      { "action_name": "Drill through",           "action_count": 27, "pct_of_total":  5.4 }
    ]
  },
  "question": "which user appeared most in the data?"
}
```

**Question typed by user:** `which user appeared most in the data?`

### Expected output

**Section 1 — Heading**
```
### Dataset Explorer
4 users · 3 stories · 8 action types · 500 total actions
```

**Section 2 — Results table**
All 7 users shown in rank order (not just top 3):

| Rank | User          | Actions | % of Total |
|------|---------------|---------|-----------|
| 1    | DVIJAYAN      | 145     | 29.0%     |
| 2    | KRAJAGOPALAN  | 89      | 17.8%     |
| 3    | MARIOMENDOZA  | 78      | 15.6%     |
| 4    | SUPPORTUSER01 | 62      | 12.4%     |
| 5    | ANANDKUMAR    | 57      | 11.4%     |
| 6    | RPATIL        | 36      | 7.2%      |
| 7    | TJONES        | 33      | 6.6%      |

**Session note (section 3):** One user dominates activity — DVIJAYAN accounts
for 29.0% of all actions.  *(fires because >15% threshold met)*

**Checkpoint question** (before JSON):
"DVIJAYAN was the most active. Want to explore another dimension, get
row-level detail, or is this what you needed?"

**Agent payload JSON** (after checkpoint, on "looks good"):
```json
{
  "agent": "explorer-agent",
  "status": "CONFIRMED",
  "dimension_explored": "users",
  "question_answered": "which user appeared most in the data?",
  "top_results": [
    { "rank": 1, "entity_type": "user", "entity_value": "DVIJAYAN", "action_count": 145, "pct_of_total": 29.0 },
    { "rank": 2, "entity_type": "user", "entity_value": "KRAJAGOPALAN", "action_count": 89, "pct_of_total": 17.8 }
  ],
  "detail_results": [],
  "cross_references": [],
  "session_notes": [
    { "agent": "explorer-agent", "observation": "One user dominates activity — DVIJAYAN accounts for 29.0% of all actions.", "significance": "high" }
  ],
  "user_requested_drill": null
}
```

### Pass criteria
- [ ] All 7 users appear in the table (not capped at 3 or 5)
- [ ] Session note fires ("29.0%" mentioned)
- [ ] Checkpoint question asked before JSON
- [ ] `status` is `"AWAITING_USER_DIRECTION"` in the mid-point JSON
- [ ] After "looks good" → `status` becomes `"CONFIRMED"`

---

## Scenario 2 — Detail mode: "Show me all DVIJAYAN's actions"

Tests that the agent switches to detail mode, calls GET /api/actions, and
presents the filtered row table. Also tests fallback messaging in standalone
testing (no real API available).

### Input

Use the same payload as Scenario 1 (paste it again).

**Question typed by user:** `show me all DVIJAYAN's actions`

### Expected output (standalone — API not running)

The agent recognises this as a detail-mode query and attempts to call
`GET /api/actions?user=DVIJAYAN`. Because no API is running in standalone
testing, it surfaces the fallback message:

```
Row-level detail requires the tool's API to be running.
In production this is handled automatically. For standalone testing,
provide the row data directly in the input.
```

Then re-asks the checkpoint question without crashing.

**No** mock data is invented. **No** rows from `by_user[]` are misused as
row-level detail.

### Expected output (production — API running)

The agent calls `GET /api/actions?dataset_id=<id>&user=DVIJAYAN` and
receives the filtered rows. It presents:

**Section heading:** `DVIJAYAN's actions — 145 actions:`

Table columns: Action | Story | User | Session ID | Timestamp | Duration

Example first row (sorted by duration desc):
| Display Vendor Invoice | LS_OPEX_SG&A_PM_STORY | DVIJAYAN | 1785410815681... | 2026-09-15T10:23:00 | 187.4s |

`action_duration_ms` converted to seconds (divide by 1000, 1 decimal).

`detail_results[]` in the output JSON is populated with the returned rows.

### Pass criteria
- [ ] Standalone: fallback message shown, no data invented
- [ ] Standalone: checkpoint question re-asked after fallback
- [ ] Production: table shown with correct columns
- [ ] Production: durations displayed in seconds (not ms)
- [ ] Production: `detail_results[]` populated in output JSON
- [ ] Neither mode: `by_user[]` values are NOT reused as row data

---

## Scenario 3 — Cross-reference: most active user also in flagged actions

Tests that when `flagged_by_type` is present in the input and the most
active user appears in it, the agent surfaces the cross-reference and offers
to route to Root Cause.

### Input

```json
{
  "data_summary": {
    "total_actions": 500,
    "total_unique_users": 4,
    "total_unique_stories": 3,
    "total_unique_action_types": 8,
    "by_user": [
      { "user": "DVIJAYAN",     "action_count": 145, "pct_of_total": 29.0 },
      { "user": "KRAJAGOPALAN", "action_count":  89, "pct_of_total": 17.8 },
      { "user": "MARIOMENDOZA", "action_count":  78, "pct_of_total": 15.6 }
    ],
    "by_story": [
      { "story_name": "LS_OPEX_SG&A_PM_STORY", "action_count": 210, "pct_of_total": 42.0 }
    ],
    "by_action": [
      { "action_name": "Display Vendor Invoice", "action_count": 87, "pct_of_total": 17.4 }
    ]
  },
  "flagged_by_type": {
    "slow_action": [
      { "user": "DVIJAYAN",     "action_name": "Display Vendor Invoice", "story_name": "LS_OPEX_SG&A_PM_STORY", "session_id": "abc123", "action_duration_ms": 187432, "action_timestamp": "2026-09-15T10:23:00" },
      { "user": "DVIJAYAN",     "action_name": "Post Document",          "story_name": "LS_OPEX_SG&A_PM_STORY", "session_id": "abc124", "action_duration_ms": 195000, "action_timestamp": "2026-09-15T11:00:00" }
    ],
    "straggler": [
      { "user": "MARIOMENDOZA", "action_name": "Run Report",             "story_name": "LS_WFP_CORP_PM_STORY",  "session_id": "xyz001", "action_duration_ms": 142000, "action_timestamp": "2026-09-15T09:15:00" }
    ]
  },
  "question": "who is the most active user?"
}
```

**Question typed by user:** `who is the most active user?`

### Expected output

**Section 1 — Heading**
```
### Dataset Explorer
4 users · 3 stories · 8 action types · 500 total actions
```

**Section 2 — User table** (all users, no cap)

**Section 3 — Cross-references** (REQUIRED — must appear):
```
**Also in flagged actions:**
- DVIJAYAN: appears in slow_action flagged actions
```
Then: *Want me to route to Root Cause Agent for the full breakdown on DVIJAYAN?*

**Checkpoint question:**
"DVIJAYAN was the most active. I also noticed they appear in the flagged
actions — want me to route to Root Cause for their anomaly breakdown, or
is this what you needed?"

**If user responds "yes route it":**
```json
{
  "agent": "explorer-agent",
  "status": "DRILL_REQUESTED",
  "user_requested_drill": "DVIJAYAN",
  ...
}
```

### Pass criteria
- [ ] Cross-reference section appears with DVIJAYAN → slow_action
- [ ] MARIOMENDOZA → straggler NOT mentioned (they aren't the top user being discussed)
- [ ] Checkpoint question mentions the flagged-actions cross-reference
- [ ] "yes route it" → `status: "DRILL_REQUESTED"`, `user_requested_drill: "DVIJAYAN"`
- [ ] "looks good" → `status: "CONFIRMED"` (cross-reference in output but no drill)

---

## Summary checklist

| # | Scenario | Key checks | Pass? |
|---|---|---|---|
| 1 | Ranking | All 7 users shown, session note fires, checkpoint before JSON | |
| 2 | Detail (standalone) | Fallback message, no invented data, no crash | |
| 3 | Cross-reference | DVIJAYAN flagged, checkpoint mentions it, DRILL_REQUESTED on "yes" | |
