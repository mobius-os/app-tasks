import assert from 'node:assert/strict'
import test from 'node:test'

import {
  APP_SCHEDULES_PATH,
  REMINDERS_PATH,
  describeCron,
  foldReminders,
  friendlyLoadError,
  friendlyScheduleLoadError,
  normalizeUnixSeconds,
  readSchedules,
  readTasks,
  sortSchedules,
  sortTasks,
  summarizeTasks,
} from '../domain.js'

test('foldReminders keeps parsing after malformed lines and lets the last record per id win', () => {
  const text = [
    JSON.stringify({ id: 'a', note: 'old', due_at: 1_700_000_000, created_at: 1_699_999_000 }),
    '{not json',
    JSON.stringify({ id: 'a', note: 'new', status: 'done', due_at: 1_700_000_000_000, created_at: 1_699_999_000_000 }),
    JSON.stringify({ id: 'b', note: 'second' }),
  ].join('\n')

  const folded = foldReminders(text)

  assert.equal(folded.length, 2)
  assert.deepEqual(folded[0], {
    id: 'a',
    note: 'new',
    status: 'done',
    due_at: 1_700_000_000,
    created_at: 1_699_999_000,
  })
  assert.equal(folded[1].id, 'b')
})

test('normalizeUnixSeconds accepts seconds and obvious milliseconds', () => {
  assert.equal(normalizeUnixSeconds(1_700_000_000), 1_700_000_000)
  assert.equal(normalizeUnixSeconds(1_700_000_000_000), 1_700_000_000)
  assert.equal(normalizeUnixSeconds(''), 0)
  assert.equal(normalizeUnixSeconds('not-a-date'), 0)
})

test('sortTasks preserves Needs Attention ranking before future and done tasks', () => {
  const now = 1_700_000_000_000
  const sorted = sortTasks([
    { id: 'future', due_at: 1_800_000_000 },
    { id: 'done', status: 'done', due_at: 1_600_000_000 },
    { id: 'late', due_at: 1_600_000_000 },
  ], now)

  assert.deepEqual(sorted.map((t) => [t.id, t._s.key]), [
    ['late', 'attention'],
    ['future', 'scheduled'],
    ['done', 'done'],
  ])
})

test('readTasks folds tasks on success and defers app_ready to the caller', async () => {
  const calls = []
  const fetchImpl = async (path) => {
    assert.equal(path, REMINDERS_PATH)
    return {
      ok: true,
      status: 200,
      text: async () => [
        JSON.stringify({ id: 'late', due_at: 1 }),
        JSON.stringify({ id: 'done', status: 'done', due_at: 1 }),
      ].join('\n'),
    }
  }

  const result = await readTasks({
    fetchImpl,
    authHeaders: { Authorization: 'Bearer test' },
    previousTasks: null,
    signal: (name, payload) => calls.push([name, payload]),
    online: true,
  })

  assert.equal(result.error, null)
  assert.equal(result.tasks.length, 2)
  // app_ready now fires from the component once both reads resolve (so it can
  // carry schedule_count); readTasks emits nothing on the success path.
  assert.deepEqual(calls, [])
})

test('readTasks preserves previous tasks and emits a technical load error on failed revalidate', async () => {
  const previousTasks = [{ id: 'keep', note: 'still visible', due_at: 1_800_000_000 }]
  const calls = []

  const result = await readTasks({
    fetchImpl: async () => ({ ok: false, status: 500 }),
    authHeaders: {},
    previousTasks,
    signal: (name, payload) => calls.push([name, payload]),
    online: true,
  })

  assert.equal(result.retained, true)
  assert.equal(result.tasks, previousTasks)
  assert.equal(result.error.title, "Couldn't load tasks")
  assert.match(result.error.message, /Task storage/)
  assert.deepEqual(calls, [['error', { message: 'load 500', source: 'load' }]])
})

test('readTasks uses the full friendly Offline state on first-load network failure', async () => {
  const result = await readTasks({
    fetchImpl: async () => { throw new Error('Failed to fetch') },
    authHeaders: {},
    previousTasks: null,
    signal: () => {},
    online: false,
  })

  assert.equal(result.retained, false)
  assert.deepEqual(result.tasks, [])
  assert.equal(result.error.title, 'Offline')
  assert.equal(result.error.offline, true)
})

test('readSchedules reads platform cron metadata with the app token', async () => {
  const calls = []
  const result = await readSchedules({
    fetchImpl: async (path, opts) => {
      calls.push([path, opts.headers.Authorization])
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 2, name: 'Reflection', slug: 'reflection', cron: '0 6 * * *', job: 'fetch.sh' },
          { id: 1, name: 'News', slug: 'news', cron: '0 10 * * *', job: 'fetch.sh' },
        ],
      }
    },
    authHeaders: { Authorization: 'Bearer app-token' },
    previousSchedules: null,
    signal: () => {},
  })

  assert.deepEqual(calls, [[APP_SCHEDULES_PATH, 'Bearer app-token']])
  assert.equal(result.error, null)
  assert.deepEqual(result.schedules.map((s) => s.name), ['News', 'Reflection'])
})

test('readSchedules preserves previous schedules on refresh failure', async () => {
  const previousSchedules = [{ id: 1, name: 'News', cron: '0 10 * * *', job: 'fetch.sh' }]
  const calls = []

  const result = await readSchedules({
    fetchImpl: async () => ({ ok: false, status: 500 }),
    authHeaders: {},
    previousSchedules,
    signal: (name, payload) => calls.push([name, payload]),
  })

  assert.equal(result.retained, true)
  assert.equal(result.schedules, previousSchedules)
  assert.equal(result.error.title, "Couldn't load schedules")
  assert.deepEqual(calls, [['error', { message: 'load schedules 500', source: 'schedule_load' }]])
})

test('sortSchedules drops unusable rows', () => {
  assert.deepEqual(sortSchedules([
    { id: 2, name: 'Reflection', cron: '0 6 * * *', job: 'fetch.sh' },
    { id: 3, name: 'Broken', job: 'fetch.sh' },
    { id: 1, name: 'News', cron: '0 10 * * *', job: 'fetch.sh' },
  ]).map((s) => s.name), ['News', 'Reflection'])
})

test('friendlyLoadError maps HTTP failures without leaking raw status copy', () => {
  const error = friendlyLoadError(new Error('load 500'), true)

  assert.equal(error.title, "Couldn't load tasks")
  assert.equal(error.raw, 'load 500')
  assert.doesNotMatch(error.message, /load 500/)
})

test('friendlyScheduleLoadError labels schedule refresh failures separately', () => {
  const error = friendlyScheduleLoadError(new Error('load schedules 500'))

  assert.equal(error.title, "Couldn't load schedules")
  assert.match(error.message, /Scheduled app jobs/)
})

test('summarizeTasks reports flat primitive counts', () => {
  const summary = summarizeTasks([
    { id: 'late', due_at: 1 },
    { id: 'done', status: 'done', due_at: 1 },
  ], 1_700_000_000_000)

  assert.deepEqual(summary, { item_count: 2, attention_count: 1, done_count: 1 })
})

test('describeCron labels minute, hourly and daily schedules', () => {
  assert.equal(describeCron('* * * * *'), 'Every minute')
  assert.equal(describeCron('*/1 * * * *'), 'Every minute')
  assert.equal(describeCron('*/15 * * * *'), 'Every 15 minutes')
  assert.equal(describeCron('0 * * * *'), 'Hourly on the hour')
  assert.equal(describeCron('5 * * * *'), 'Hourly at :05')
  assert.equal(describeCron('30 */1 * * *'), 'Hourly at :30')
  assert.equal(describeCron('0 */6 * * *'), 'Every 6 hours on the hour')
  assert.equal(describeCron('15 */2 * * *'), 'Every 2 hours at :15')
  assert.equal(describeCron('0 9 * * *'), 'Daily at 9:00 AM')
  assert.equal(describeCron('30 18 * * 1'), 'Mondays at 6:30 PM')
})

test('describeCron falls back to the raw expression for other shapes', () => {
  assert.equal(describeCron('0 9 1 * *'), '0 9 1 * *')
  assert.equal(describeCron('75 * * * *'), '75 * * * *')
  assert.equal(describeCron(''), 'Cron schedule')
})

test('describeCron only claims an interval that stays even across midnight and the hour', () => {
  // */5 hours runs 20:00 then 00:00; */7 minutes runs :56 then :00.
  assert.equal(describeCron('0 */5 * * *'), '0 */5 * * *')
  assert.equal(describeCron('30 */7 * * *'), '30 */7 * * *')
  assert.equal(describeCron('0 */24 * * *'), '0 */24 * * *')
  assert.equal(describeCron('0 */12 * * *'), 'Every 12 hours on the hour')
  assert.equal(describeCron('*/7 * * * *'), '*/7 * * * *')
  assert.equal(describeCron('*/45 * * * *'), '*/45 * * * *')
  assert.equal(describeCron('*/0 * * * *'), '*/0 * * * *')
  assert.equal(describeCron('*/30 * * * *'), 'Every 30 minutes')
})
