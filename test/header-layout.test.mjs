import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')

test('compact header divider stays inset from both pane edges', () => {
  assert.doesNotMatch(source, /\.tk-header-inner\s*\{[^}]*border-bottom/s)
  assert.match(source, /\.tk-header-inner::after\s*\{[^}]*inset-inline:\s*16px[^}]*background:\s*var\(--border\)/s)
})
