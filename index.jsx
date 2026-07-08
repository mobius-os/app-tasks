import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { formatDistanceToNow, format } from 'date-fns'
import { readSchedules, readTasks, sortTasks, normalizeUnixSeconds } from './domain.js'

// Tasks — a viewer for the agent's scheduled check-ins (its "self-reminders":
// the relational follow-ups the Möbius agent schedules for itself, stored append-
// only at /data/shared/self-reminders.jsonl as JSONL records shaped like
// {id,note,status,due_at,created_at}. due_at and created_at are Unix seconds;
// last record per id wins. A mini-app can READ shared storage but not WRITE it,
// and scheduling is owner-only, so rescheduling / cancelling a task is routed
// to the agent via a new chat. The app also reads platform app cron metadata
// to show scheduled app jobs; those rows are read-only here.

const CSS = `
/* mobius-ui:Root v1 — keep in sync; library candidate. */
.tk-root { position: relative; display: flex; flex-direction: column; height: 100%;
  overflow: hidden; background: var(--bg); color: var(--text); font-family: var(--font);
  --tk-amber: #d99a2b; }
.tk-scroll { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 0 0 32px; }
/* /mobius-ui:Root */

/* mobius-ui:Header v1 — keep in sync; library candidate. */
.tk-header { flex: 0 0 auto; display: flex; align-items: center; gap: 12px; min-height: 48px;
  padding: max(12px, var(--mobius-safe-top, env(safe-area-inset-top))) 16px 12px;
  background: var(--surface); border-bottom: 1px solid var(--border); }
.tk-brand { display: flex; align-items: center; gap: 11px; min-width: 0; flex: 1; }
.tk-mark { flex: 0 0 auto; width: 30px; height: 30px; border-radius: 9px; display: flex;
  align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); }
.tk-mark img { width: 100%; height: 100%; border-radius: inherit; object-fit: cover; display: block; }
.tk-title { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: -0.015em; }
.tk-subtitle { display: block; margin-top: 1px; font-size: 12px; color: var(--muted); }
.tk-actions { display: flex; gap: 8px; }
.tk-iconbtn { flex: 0 0 auto; width: 44px; height: 44px; display: inline-flex; align-items: center;
  justify-content: center; border-radius: 10px; border: 1px solid var(--border); background: var(--surface);
  color: var(--text); cursor: pointer; transition: background .14s ease, transform .1s ease; }
.tk-iconbtn:active { transform: scale(0.94); }
.tk-iconbtn:disabled { opacity: 0.5; cursor: default; }
.tk-iconbtn svg { width: 18px; height: 18px; }
.tk-iconbtn.is-spinning svg { animation: tk-spin 0.9s linear infinite; }
@keyframes tk-spin { to { transform: rotate(360deg); } }
/* /mobius-ui:Header */

/* status pill */
.tk-summary { display: flex; align-items: center; gap: 10px; margin: 14px 16px 6px; padding: 13px 16px;
  border-radius: 12px; background: var(--surface); border: 1px solid var(--border); }
.tk-summary.is-alert { background: color-mix(in srgb, var(--tk-amber) 12%, var(--surface)); border-color: color-mix(in srgb, var(--tk-amber) 40%, var(--border)); }
.tk-sync-pill { display: flex; align-items: center; gap: 8px; margin: 12px 16px 0; padding: 10px 12px;
  border-radius: 10px; border: 1px solid color-mix(in srgb, var(--tk-amber) 38%, var(--border));
  background: color-mix(in srgb, var(--tk-amber) 10%, var(--surface)); color: var(--text);
  font-size: 13px; line-height: 1.4; }
.tk-sync-pill strong { font-weight: 700; }
.tk-sync-pill svg { flex: 0 0 auto; width: 17px; height: 17px; color: var(--tk-amber); }
.tk-summary-ico { width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; color: var(--accent); }
.tk-summary.is-alert .tk-summary-ico { color: var(--tk-amber); }
.tk-summary-ico svg { width: 20px; height: 20px; }
.tk-summary-label { flex: 1; font-size: 15px; font-weight: 600; }
.tk-summary-count { font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--muted); }
.tk-summary.is-alert .tk-summary-count { color: var(--tk-amber); }

.tk-section-title { margin: 18px 16px 4px; font-size: 12px; font-weight: 700; letter-spacing: 0.06em;
  text-transform: uppercase; color: var(--muted); }

/* mobius-ui:Card v1 — keep in sync; library candidate. Diverge below the marker only. */
.tk-list { display: flex; flex-direction: column; gap: 10px; padding: 8px 16px 0; }
.tk-card { text-align: left; width: 100%; box-sizing: border-box; background: var(--surface);
  border: 1px solid var(--border); border-radius: 12px; padding: 15px 16px; color: var(--text);
  font-family: var(--font); cursor: pointer; transition: transform .1s ease, border-color .14s ease; }
.tk-card:active { transform: scale(0.99); }
.tk-card.is-readonly { cursor: default; }
.tk-card.is-readonly:active { transform: none; }
.tk-card.is-done { opacity: 0.62; }
.tk-card-top { display: flex; align-items: flex-start; gap: 10px; }
.tk-note { flex: 1; min-width: 0; font-size: 15.5px; font-weight: 600; line-height: 1.4; letter-spacing: -0.01em;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.tk-badge { flex: 0 0 auto; font-size: 11.5px; font-weight: 700; padding: 4px 9px; border-radius: 20px;
  white-space: nowrap; letter-spacing: 0.01em; }
.tk-badge.tone-active { color: var(--green); background: color-mix(in srgb, var(--green) 15%, transparent); }
.tk-badge.tone-attention { color: var(--tk-amber); background: color-mix(in srgb, var(--tk-amber) 16%, transparent); }
.tk-badge.tone-done { color: var(--green); background: color-mix(in srgb, var(--green) 13%, transparent); }
.tk-badge.tone-muted { color: var(--muted); background: color-mix(in srgb, var(--text) 8%, transparent); }
.tk-meta { margin-top: 12px; display: grid; grid-template-columns: auto 1fr; gap: 5px 14px; }
.tk-meta-k { font-size: 12.5px; color: var(--muted); }
.tk-meta-v { font-size: 12.5px; font-weight: 500; text-align: right; font-variant-numeric: tabular-nums; }
.tk-meta-v.is-attention { color: var(--tk-amber); font-weight: 650; }
/* /mobius-ui:Card */

/* mobius-ui:Empty v1 — keep in sync; library candidate. Diverge below the marker only. */
.tk-empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px;
  margin: auto; padding: 56px 28px; color: var(--muted); }
.tk-empty-mark { width: 64px; height: 64px; margin-bottom: 8px; border-radius: 18px; display: flex;
  align-items: center; justify-content: center; color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent); }
.tk-empty-mark svg { width: 30px; height: 30px; }
.tk-empty-title { font-size: 17px; font-weight: 700; color: var(--text); }
.tk-empty-text { margin: 0; font-size: 14px; line-height: 1.6; max-width: 32ch; }
.tk-spinner { width: 26px; height: 26px; border-radius: 50%; border: 2.5px solid var(--border);
  border-top-color: var(--accent); animation: tk-spin 0.8s linear infinite; }
/* /mobius-ui:Empty */

/* mobius-ui:Button v1 — keep in sync; library candidate. Diverge below the marker only. */
.tk-btn { min-height: 44px; padding: 10px 18px; border-radius: 11px; border: 1px solid var(--border);
  background: var(--surface); color: var(--text); font-weight: 600; font-size: 14px; cursor: pointer;
  font-family: var(--font); transition: transform .1s ease; }
.tk-btn:active { transform: scale(0.97); }
.tk-btn-primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
/* /mobius-ui:Button */

/* mobius-ui:Focus v1 — keep in sync; library candidate. Diverge below the marker only. */
.tk-iconbtn:focus-visible,
.tk-card:focus-visible,
.tk-btn:focus-visible,
.tk-back:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
/* /mobius-ui:Focus */

/* detail */
.tk-detail-head { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 10px;
  padding: max(12px, var(--mobius-safe-top, env(safe-area-inset-top))) 12px 12px;
  background: var(--surface); border-bottom: 1px solid var(--border); }
.tk-back { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 4px; min-height: 44px; padding: 8px 12px 8px 8px;
  border-radius: 10px; border: none; background: none; color: var(--accent); font-family: var(--font);
  font-size: 15px; font-weight: 600; cursor: pointer; }
.tk-back svg { width: 20px; height: 20px; }
.tk-detail-body { padding: 20px 18px 40px; max-width: 640px; margin: 0 auto; }
.tk-detail-note { font-size: 18px; font-weight: 650; line-height: 1.45; margin: 0 0 8px; }
.tk-detail-badge { margin-bottom: 20px; }
.tk-detail-grid { display: grid; grid-template-columns: auto 1fr; gap: 12px 16px; padding: 16px 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.tk-detail-k { font-size: 13px; color: var(--muted); }
.tk-detail-v { font-size: 13.5px; text-align: right; font-weight: 500; word-break: break-word; }
.tk-detail-actions { margin-top: 22px; display: flex; flex-direction: column; gap: 10px; }
.tk-hint { margin-top: 16px; font-size: 12.5px; color: var(--muted); text-align: center; line-height: 1.5; }
.tk-rel-time { color: var(--muted); }

/* mobius-ui:ReducedMotion v1 — keep in sync; library candidate. Diverge below the marker only. */
@media (prefers-reduced-motion: reduce) {
  .tk-iconbtn,
  .tk-card,
  .tk-btn { transition: none; }
  .tk-iconbtn:active,
  .tk-card:active,
  .tk-btn:active { transform: none; }
  .tk-iconbtn.is-spinning svg,
  .tk-spinner { animation: none; }
}
/* /mobius-ui:ReducedMotion */
`

const CLOCK = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
const CAL = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2v4M16 2v4M3 10h18"/><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/></svg>
const ALERT = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/><path d="M12 9v4M12 17h.01"/></svg>
const REFRESH = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
const BACK = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>

function fmtAbs(unixSec) {
  const normalized = normalizeUnixSeconds(unixSec)
  if (!normalized) return '—'
  try { return format(new Date(normalized * 1000), 'MMM d, yyyy · h:mm a') } catch { return '—' }
}
function fmtRel(unixSec) {
  const normalized = normalizeUnixSeconds(unixSec)
  if (!normalized) return ''
  try { return formatDistanceToNow(new Date(normalized * 1000), { addSuffix: true }) } catch { return '' }
}

function fmtHour(minute, hour) {
  const h = Number(hour)
  const m = Number(minute)
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null
  const suffix = h >= 12 ? 'PM' : 'AM'
  const displayHour = h % 12 || 12
  return `${displayHour}:${String(m).padStart(2, '0')} ${suffix}`
}

function describeCron(expr) {
  const s = String(expr || '').trim()
  const parts = s.split(/\s+/)
  if (/^\*\/\d+$/.test(parts[0]) && parts.slice(1).join(' ') === '* * * *') {
    return `Every ${parts[0].slice(2)} minutes`
  }
  if (parts.length === 5) {
    const time = fmtHour(parts[0], parts[1])
    if (time && parts[2] === '*' && parts[3] === '*') {
      if (parts[4] === '*') return `Daily at ${time}`
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
      if (/^[0-6]$/.test(parts[4])) return `${days[Number(parts[4])]}s at ${time}`
    }
  }
  return s || 'Cron schedule'
}

function emitSignal(name, payload) {
  window.mobius?.signal?.(name, payload)
}

export default function TasksApp({ appId, token }) {
  const [tasks, setTasks] = useState(null) // null = loading
  const [schedules, setSchedules] = useState(null)
  const [error, setError] = useState(null)
  const [scheduleError, setScheduleError] = useState(null)
  // True when the visible tasks came from an earlier successful load and the
  // LAST refresh merely failed to revalidate them. Distinguishes "no tasks,
  // load failed" (full error page) from "genuinely zero tasks, refresh failed"
  // (normal empty state + compact pill) — length alone can't tell those apart.
  const [retained, setRetained] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [selected, setSelected] = useState(null) // task id
  const navRef = useRef(null)
  const tasksRef = useRef(null)
  const schedulesRef = useRef(null)

  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token])

  const getOnline = useCallback(() => {
    if (window.mobius && typeof window.mobius.online === 'boolean') return window.mobius.online
    if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') return navigator.onLine
    return true
  }, [])

  // Five triggers can call load() concurrently (mount, 60s interval, focus,
  // online, manual refresh); without a generation guard a slow older response
  // could land after a newer one and paint stale data. Newest wins.
  const loadGenRef = useRef(0)
  const load = useCallback(async () => {
    const gen = ++loadGenRef.current
    setError(null)
    const [result, scheduleResult] = await Promise.all([
      readTasks({
        fetchImpl: fetch,
        authHeaders,
        previousTasks: tasksRef.current,
        signal: emitSignal,
        online: getOnline(),
      }),
      readSchedules({
        fetchImpl: fetch,
        authHeaders,
        previousSchedules: schedulesRef.current,
        signal: emitSignal,
      }),
    ])
    if (gen !== loadGenRef.current) return
    tasksRef.current = result.tasks
    schedulesRef.current = scheduleResult.schedules
    setTasks(result.tasks)
    setSchedules(scheduleResult.schedules)
    setError(result.error)
    setScheduleError(scheduleResult.error)
    setRetained(result.retained)
    setNow(Date.now())
  }, [authHeaders, getOnline])

  useEffect(() => { load() }, [load])
  // Keep relative times and shared JSONL fresh while visible (shared storage has no subscribe()).
  useEffect(() => {
    const refetchIfVisible = () => {
      setNow(Date.now())
      if (document.visibilityState !== 'hidden') load()
    }
    const onVisibility = () => { if (document.visibilityState === 'visible') refetchIfVisible() }
    const onFocus = () => refetchIfVisible()
    window.addEventListener('focus', onFocus)
    let unsubscribeOnline = null
    if (window.mobius && typeof window.mobius.onOnlineChange === 'function') {
      let sawInitialOnline = false
      unsubscribeOnline = window.mobius.onOnlineChange((online) => {
        if (!sawInitialOnline) { sawInitialOnline = true; return }
        if (online) refetchIfVisible()
      })
    } else {
      window.addEventListener('online', onFocus)
    }
    document.addEventListener('visibilitychange', onVisibility)
    const t = setInterval(refetchIfVisible, 60000)
    return () => {
      window.removeEventListener('focus', onFocus)
      if (unsubscribeOnline) unsubscribeOnline()
      else window.removeEventListener('online', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      clearInterval(t)
    }
  }, [load])

  async function refresh() { setRefreshing(true); await load(); setRefreshing(false) }

  function askAgent(draft, action) {
    try {
      emitSignal('agent_handoff', { action })
      window.parent.postMessage({ type: 'moebius:new-chat', draft }, window.location.origin)
    } catch (err) {
      emitSignal('error', { message: String(err?.message || err), source: 'handoff' })
    }
  }

  async function openTask(id) {
    const task = sorted.find((t) => t.id === id)
    if (window.mobius?.nav?.open) {
      let handle = null
      try {
        handle = window.mobius.nav.open('task-detail', () => { navRef.current = null; setSelected(null) })
        navRef.current = handle
        await handle.ready
        if (navRef.current !== handle) return
      } catch (err) {
        if (navRef.current === handle) navRef.current = null
        emitSignal('error', { message: String(err?.message || err), source: 'nav' })
        return
      }
    }
    emitSignal('item_opened', { type: 'task', status: task?._s?.key || task?.status || 'unknown' })
    setSelected(id)
  }
  function closeTask() { try { navRef.current?.close?.() } catch {}; navRef.current = null; setSelected(null) }

  const sorted = useMemo(() => {
    if (!tasks) return []
    return sortTasks(tasks, now)
  }, [tasks, now])
  const scheduledApps = schedules || []

  const attentionCount = useMemo(() => sorted.filter((t) => t._s.key === 'attention').length, [sorted])
  const upcomingCount = useMemo(() => sorted.filter((t) => t._s.key === 'scheduled').length, [sorted])

  const current = selected && tasks ? sorted.find((t) => t.id === selected) : null

  useEffect(() => {
    if (!selected || !tasks) return
    if (!tasks.some((t) => t.id === selected)) closeTask()
  }, [selected, tasks])

  // ---- Detail view ----
  if (current) {
    const s = current._s
    return (
      <div className="tk-root">
        <style>{CSS}</style>
        <div className="tk-detail-head">
          <button className="tk-back" onClick={closeTask} aria-label="Back to tasks">{BACK}<span>Tasks</span></button>
        </div>
        <div className="tk-scroll">
          <div className="tk-detail-body">
            <p className="tk-detail-note">{current.note || 'Untitled task'}</p>
            <div className="tk-detail-badge"><span className={`tk-badge tone-${s.tone}`}>{s.label}</span></div>
            <div className="tk-detail-grid">
              <div className="tk-detail-k">Due</div>
              <div className="tk-detail-v">{fmtAbs(current.due_at)}{fmtRel(current.due_at) && <><br /><span className="tk-rel-time">{fmtRel(current.due_at)}</span></>}</div>
              <div className="tk-detail-k">Created</div>
              <div className="tk-detail-v">{fmtAbs(current.created_at)}</div>
              <div className="tk-detail-k">Status</div>
              <div className="tk-detail-v">{current.status || 'pending'}</div>
            </div>
            <div className="tk-detail-actions">
              {s.key !== 'done' && s.key !== 'cancelled' && (
                <>
                  <button className="tk-btn tk-btn-primary" onClick={() => askAgent(`Reschedule this check-in: "${current.note}". New timing: `, 'reschedule')}>Ask agent to reschedule</button>
                  <button className="tk-btn" onClick={() => askAgent(`Mark this check-in as done: "${current.note}".`, 'done')}>Mark done</button>
                  <button className="tk-btn" onClick={() => askAgent(`Cancel this scheduled check-in: "${current.note}".`, 'cancel')}>Cancel task</button>
                </>
              )}
              <button className="tk-btn" onClick={() => askAgent(`About my scheduled check-in "${current.note}": `, 'discuss')}>Discuss with agent</button>
            </div>
            <p className="tk-hint">Scheduling lives with your agent — these actions open a chat so it can update the task.</p>
          </div>
        </div>
      </div>
    )
  }

  // ---- List view ----
  const loading = tasks === null
  return (
    <div className="tk-root">
      <style>{CSS}</style>
      <header className="tk-header">
        <div className="tk-brand">
          <span className="tk-mark">
            {appId ? <img src={`/api/apps/${appId}/icon?size=64`} alt="" /> : null}
          </span>
          <div>
            <h1 className="tk-title">Tasks</h1>
            <span className="tk-subtitle">Your agent’s scheduled check-ins</span>
          </div>
        </div>
        <div className="tk-actions">
          <button className={`tk-iconbtn${refreshing ? ' is-spinning' : ''}`} onClick={refresh} disabled={refreshing} aria-label="Refresh tasks">{REFRESH}</button>
        </div>
      </header>

      <div className="tk-scroll">
        {loading && <div className="tk-empty"><div className="tk-spinner" /><div className="tk-empty-title">Loading tasks…</div></div>}

        {!loading && error && sorted.length === 0 && scheduledApps.length === 0 && !retained && (
          <div className="tk-empty">
            <div className="tk-empty-mark" aria-hidden="true">{ALERT}</div>
            <div className="tk-empty-title">{error.title}</div>
            <p className="tk-empty-text">{error.message}</p>
            <button className="tk-btn" onClick={refresh}>Try again</button>
          </div>
        )}

        {!loading && (!error || retained) && sorted.length === 0 && scheduledApps.length === 0 && (
          <div className="tk-empty">
            <div className="tk-empty-mark" aria-hidden="true">{CAL}</div>
            <div className="tk-empty-title">No scheduled tasks</div>
            <p className="tk-empty-text">When your agent schedules a check-in or app job, it shows up here.</p>
          </div>
        )}

        {!loading && (error || scheduleError) && (sorted.length > 0 || scheduledApps.length > 0 || retained) && (
          <div className="tk-sync-pill" role="status">
            <span aria-hidden="true">{ALERT}</span>
            <span><strong>{(error || scheduleError).offline ? 'Offline' : 'Refresh failed'}</strong> {(error || scheduleError).message}</span>
          </div>
        )}

        {!loading && sorted.length > 0 && (
          <>
            <div className={`tk-summary${attentionCount > 0 ? ' is-alert' : ''}`}>
              <span className="tk-summary-ico" aria-hidden="true">{attentionCount > 0 ? ALERT : CLOCK}</span>
              <span className="tk-summary-label">{attentionCount > 0 ? 'Needs attention' : 'Upcoming'}</span>
              <span className="tk-summary-count">{attentionCount > 0 ? attentionCount : upcomingCount}</span>
            </div>
            <div className="tk-section-title">Self-reminders</div>
            <div className="tk-list">
              {sorted.map((t) => {
                const s = t._s
                return (
                  <button key={t.id} className={`tk-card${s.key === 'done' || s.key === 'cancelled' ? ' is-done' : ''}`} onClick={() => openTask(t.id)}>
                    <div className="tk-card-top">
                      <div className="tk-note">{t.note || 'Untitled task'}</div>
                      <span className={`tk-badge tone-${s.tone}`}>{s.label}</span>
                    </div>
                    <div className="tk-meta">
                      <div className="tk-meta-k">{s.key === 'attention' ? 'Was due' : s.key === 'done' || s.key === 'cancelled' ? 'Due' : 'Next'}</div>
                      <div className={`tk-meta-v${s.key === 'attention' ? ' is-attention' : ''}`}>{fmtAbs(t.due_at)}{fmtRel(t.due_at) ? ` · ${fmtRel(t.due_at)}` : ''}</div>
                      <div className="tk-meta-k">Created</div>
                      <div className="tk-meta-v">{fmtRel(t.created_at) || fmtAbs(t.created_at)}</div>
                    </div>
                  </button>
                )
              })}
            </div>
          </>
        )}

        {!loading && scheduledApps.length > 0 && (
          <>
            <div className="tk-section-title">Scheduled apps</div>
            <div className="tk-list">
              {scheduledApps.map((job) => (
                <div key={job.id} className="tk-card is-readonly">
                  <div className="tk-card-top">
                    <div className="tk-note">{job.name || 'Untitled app'}</div>
                    <span className="tk-badge tone-muted">{job.slug || `app ${job.id}`}</span>
                  </div>
                  <div className="tk-meta">
                    <div className="tk-meta-k">Schedule</div>
                    <div className="tk-meta-v">{describeCron(job.cron)}</div>
                    <div className="tk-meta-k">Job</div>
                    <div className="tk-meta-v">{job.job || 'job.sh'}</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
