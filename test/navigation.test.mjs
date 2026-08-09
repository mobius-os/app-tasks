import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.jsx'), 'utf8')

test('task detail uses reversible shell navigation', () => {
  const start = source.indexOf('async function openTask')
  const end = source.indexOf('function closeTask', start)
  const openTask = source.slice(start, end)

  assert.match(openTask, /onBack:\s*\(\)\s*=>/)
  assert.match(openTask, /onForward:\s*\(\)\s*=>[\s\S]*setSelected\(id\)/)
  assert.match(openTask, /const outcome = await handle\.outcome/)
  assert.doesNotMatch(openTask, /handle\.ready/)
})
