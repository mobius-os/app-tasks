# app-tasks - Tasks

Tasks is a read-only Möbius catalog mini-app for the agent's scheduled check-ins and installed apps' recurring cron jobs. It reads the shared self-reminder log, folds it into the latest task state, and routes completions, cancellations, reschedules, and discussion back to the agent through a new chat.

## Data Contract

The app reads:

```text
/data/shared/self-reminders.jsonl
GET /api/apps/schedules
```

Each non-empty line is a JSON object. Malformed lines are ignored so one bad append does not hide the rest of the task list.

Expected fields:

```json
{
  "id": "stable-task-id",
  "note": "Human-readable task text",
  "status": "pending",
  "due_at": 1783420800,
  "created_at": 1783334400
}
```

- `id` is required for display. Records without `id` are ignored.
- `note` is shown as task text; missing notes render as "Untitled task".
- `status` may be `pending`, `done`, or `cancelled`. Unknown or missing statuses are treated as pending for display.
- `due_at` and `created_at` are Unix seconds. The app normalizes obvious millisecond values, but producers should write seconds.
- The log is append-only. The last valid record for each `id` wins.

Derived status:

- `pending` with `due_at <= now` displays as `Needs Attention`.
- `pending` with a future due time displays as `Scheduled`.
- `done` and `cancelled` display directly and sort below active work.

## Write Model

Tasks does not write `shared/self-reminders.jsonl` or app cron schedules. Shared scheduling belongs to the Möbius agent, so task update actions emit an `agent_handoff` signal and open a chat draft:

- `reschedule`
- `done`
- `cancel`
- `discuss`

App cron rows from `/api/apps/schedules` are displayed read-only and have no reschedule, cancel, or discuss affordance in this app.

The app refreshes shared storage on mount, manual refresh, focus/visibility return, online return, and a visible 60 second interval. If refresh fails after data was already loaded, the last visible task list stays on screen with an inline Offline or refresh-failed pill.

## Signals

The app emits guarded `window.mobius?.signal?.()` calls:

- `app_ready { item_count, attention_count, done_count }`
- `item_opened { type: "task", status }`
- `agent_handoff { action }`
- `error { message, source }`

Payloads are flat primitives and contain no task text.

## Manifest Offline Contract

`mobius.json` intentionally keeps:

```json
"offline": {
  "reads": false,
  "writes": "none",
  "execution": "none"
}
```

The installer reads this object and stores it as `App.offline_contract`. It reflects that this viewer depends on online shared storage and performs no local writes.

## File Layout

```text
index.jsx             # React mini-app entry and UI
domain.js             # Pure parsing, folding, sorting, status, and load helpers
test/domain.test.js   # Node test runner regression tests
mobius.json           # Catalog manifest
icon.png              # Catalog icon
```

Run tests with:

```bash
npm test
```
