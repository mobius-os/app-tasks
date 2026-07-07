export const REMINDERS_PATH = '/api/storage/shared/self-reminders.jsonl'

const MILLISECOND_UNIX_THRESHOLD = 100_000_000_000

// The shared JSONL contract stores due_at and created_at as Unix seconds.
// Some producers have historically emitted obvious millisecond values; normalize
// those without rejecting otherwise valid records.
export function normalizeUnixSeconds(value) {
  if (value == null || value === '') return 0
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.abs(n) >= MILLISECOND_UNIX_THRESHOLD ? Math.trunc(n / 1000) : n
}

function normalizeReminder(record) {
  return {
    ...record,
    due_at: normalizeUnixSeconds(record.due_at),
    created_at: normalizeUnixSeconds(record.created_at),
  }
}

// Fold the append-only JSONL: last record per id wins.
export function foldReminders(text) {
  const byId = new Map()
  for (const line of (text || '').split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const r = JSON.parse(s)
      if (r && r.id != null) byId.set(r.id, normalizeReminder(r))
    } catch { /* tolerate a malformed line, keep the rest */ }
  }
  return [...byId.values()]
}

// Derived status: a pending task whose due time has passed is surfaced as
// "Needs Attention" rather than silently sitting active.
export function statusOf(task, now) {
  if (task.status === 'cancelled') return { key: 'cancelled', label: 'Cancelled', tone: 'muted', rank: 3 }
  if (task.status === 'done') return { key: 'done', label: 'Done', tone: 'done', rank: 2 }
  const due = normalizeUnixSeconds(task.due_at) * 1000
  if (due && due <= now) return { key: 'attention', label: 'Needs Attention', tone: 'attention', rank: 0 }
  return { key: 'scheduled', label: 'Scheduled', tone: 'active', rank: 1 }
}

export function sortTasks(tasks, now) {
  return (tasks || [])
    .map((t) => ({ ...t, _s: statusOf(t, now) }))
    .sort((a, b) => (a._s.rank - b._s.rank) || ((a.due_at || Infinity) - (b.due_at || Infinity)))
}

export function summarizeTasks(tasks, now) {
  const sorted = sortTasks(tasks, now)
  return {
    item_count: sorted.length,
    attention_count: sorted.filter((t) => t._s.key === 'attention').length,
    done_count: sorted.filter((t) => t._s.key === 'done').length,
  }
}

export function friendlyLoadError(err, online = true) {
  const raw = String(err?.message || err || 'Could not load tasks')
  const offline = online === false || /failed to fetch|networkerror|network request failed/i.test(raw)
  if (offline) {
    return {
      title: 'Offline',
      message: 'Tasks are unavailable while this app is offline. Reconnect and try again.',
      raw,
      offline: true,
    }
  }
  if (/^load\s+\d+/.test(raw)) {
    return {
      title: "Couldn't load tasks",
      message: 'Task storage did not respond cleanly. Try again in a moment.',
      raw,
      offline: false,
    }
  }
  return {
    title: "Couldn't load tasks",
    message: 'Tasks could not be refreshed. Try again in a moment.',
    raw,
    offline: false,
  }
}

export async function readTasks({ fetchImpl, authHeaders, previousTasks, signal, online }) {
  try {
    const res = await fetchImpl(REMINDERS_PATH, { headers: authHeaders })
    if (res.status === 404) {
      const tasks = []
      signal?.('app_ready', summarizeTasks(tasks, Date.now()))
      return { tasks, error: null, retained: false }
    }
    if (!res.ok) throw new Error(`load ${res.status}`)
    const text = await res.text()
    const tasks = foldReminders(text)
    signal?.('app_ready', summarizeTasks(tasks, Date.now()))
    return { tasks, error: null, retained: false }
  } catch (err) {
    signal?.('error', { message: String(err?.message || err), source: 'load' })
    const fallback = Array.isArray(previousTasks) ? previousTasks : []
    return {
      tasks: fallback,
      error: friendlyLoadError(err, online),
      retained: Array.isArray(previousTasks),
    }
  }
}
