import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

// Render smoke: bundle index.jsx the way the platform compiler does — Möbius
// compiles mini-apps with Rolldown, so this bundles with Rolldown too — stub
// the react runtime with minimally-functional hooks, and invoke the exported
// App(). Catches the bug class unit tests of extracted helpers cannot see —
// a TDZ reference, a missing import, any synchronous render-path throw (the
// exact class that shipped broken in app-latex while its suite stayed green).
// Needs the shell's frontend deps (rolldown, plus the packages index.jsx
// bundles). CI provides them via MOBIUS_FRONTEND_NODE_MODULES; locally a
// sibling mobius checkout works too. Skips (not fails) when neither is
// available, so bare `node --test` on a fresh clone stays green.

const CLONE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = dirname(fileURLToPath(import.meta.url))
const buildDir = join(root, '.build-render')
const bundled = join(buildDir, 'app.mjs')

const RUNTIME_LIBS = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'date-fns',
]

const REACT_SPEC = 'react'
const JSX_SPECS = new Set(['react/jsx-runtime', 'react/jsx-dev-runtime'])

function hasFrontendTestDeps(candidate) {
  if (!candidate) return false
  try {
    createRequire(join(candidate, 'noop.js')).resolve('rolldown')
    return true
  } catch {
    return false
  }
}

function frontendNodeModules() {
  const fromEnv = process.env.MOBIUS_FRONTEND_NODE_MODULES
  if (hasFrontendTestDeps(fromEnv)) return fromEnv
  for (const rel of ['.mobius/frontend/node_modules', '../mobius/frontend/node_modules']) {
    const candidate = join(CLONE_ROOT, rel)
    if (hasFrontendTestDeps(candidate)) return candidate
  }
  return null
}

const nm = frontendNodeModules()

async function bundleAndImport() {
  await rm(buildDir, { recursive: true, force: true })
  await mkdir(buildDir, { recursive: true })
  const requireFromFrontend = createRequire(join(nm, 'noop.js'))
  const { rolldown } = await import(
    pathToFileURL(requireFromFrontend.resolve('rolldown')).href
  )
  const build = await rolldown({
    input: join(CLONE_ROOT, 'index.jsx'),
    platform: 'node',
    tsconfig: false,
    transform: { jsx: 'react-jsx' },
    external: RUNTIME_LIBS,
    resolve: { modules: [nm, 'node_modules'] },
  })
  await build.write({ file: bundled, format: 'es' })
  await build.close()

  const bundleSrc = readFileSync(bundled, 'utf8')
  const exportsBySpec = {}
  const importRe = /import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*["']([^"']+)["']/g
  for (const m of bundleSrc.matchAll(importRe)) {
    const [, dflt, named, spec] = m
    const set = (exportsBySpec[spec] ||= new Set())
    if (dflt) set.add('default')
    if (named) {
      for (const piece of named.split(',')) {
        const name = piece.trim().split(/\s+as\s+/).pop().trim()
        if (name) set.add(name)
      }
    }
  }
  const serial = {}
  for (const [spec, names] of Object.entries(exportsBySpec)) serial[spec] = [...names]

  const hook = join(buildDir, 'runtime-lib-hook.mjs')
  await writeFile(hook, HOOK_SOURCE.replace('__EXPORTS__', JSON.stringify(serial)))
  const { register } = await import('node:module')
  register(pathToFileURL(hook))
  return import(pathToFileURL(bundled))
}

const HOOK_SOURCE = `
const EXPORTS = __EXPORTS__
const REACT_SPEC = ${JSON.stringify(REACT_SPEC)}
const JSX_SPECS = ${JSON.stringify([...JSX_SPECS])}

const PROXY = 'const stub = new Proxy(function () {}, {'
  + ' get: (t, p) => (p === Symbol.toPrimitive || p === Symbol.iterator ? undefined : stub),'
  + ' apply: () => stub, construct: () => stub })\\n'

const REACT_FN = [
  'export const useState = (init) => [typeof init === "function" ? init() : init, () => {}]',
  'export const useRef = (init) => ({ current: init === undefined ? null : init })',
  'export const useMemo = (factory) => factory()',
  'export const useCallback = (fn) => fn',
  'export const useEffect = () => {}',
  'export const useLayoutEffect = () => {}',
  'export const useId = () => "smoke-id"',
  'export const useReducer = (r, init, initFn) => [typeof initFn === "function" ? initFn(init) : init, () => {}]',
  'export const useContext = () => null',
  'export const createElement = () => ({})',
  'export const Fragment = "Fragment"',
]
const REACT_DEFINED = new Set(['useState','useRef','useMemo','useCallback','useEffect','useLayoutEffect','useId','useReducer','useContext','createElement','Fragment'])

const JSX_FN = [
  'export const jsx = () => ({})',
  'export const jsxs = () => ({})',
  'export const jsxDEV = () => ({})',
  'export const Fragment = "Fragment"',
]
const JSX_DEFINED = new Set(['jsx','jsxs','jsxDEV','Fragment'])

export async function resolve(spec, ctx, next) {
  if (Object.prototype.hasOwnProperty.call(EXPORTS, spec)) {
    return { url: 'runtime-lib-stub:' + encodeURIComponent(spec), shortCircuit: true }
  }
  return next(spec, ctx)
}

export async function load(url, ctx, next) {
  if (!url.startsWith('runtime-lib-stub:')) return next(url, ctx)
  const spec = decodeURIComponent(url.slice('runtime-lib-stub:'.length))
  const names = EXPORTS[spec] || []
  let lines
  if (spec === REACT_SPEC) {
    const extra = names.filter((n) => n !== 'default' && !REACT_DEFINED.has(n)).map((n) => 'export const ' + n + ' = stub')
    lines = [...REACT_FN, ...extra, 'export default { useState, useRef, useMemo, useCallback, useEffect, useLayoutEffect, useId, useReducer, useContext, createElement, Fragment }']
  } else if (JSX_SPECS.includes(spec)) {
    const extra = names.filter((n) => n !== 'default' && !JSX_DEFINED.has(n)).map((n) => 'export const ' + n + ' = stub')
    lines = [...JSX_FN, ...extra, 'export default {}']
  } else {
    lines = names.map((n) => (n === 'default' ? 'export default stub' : 'export const ' + n + ' = stub'))
  }
  return { format: 'module', shortCircuit: true, source: PROXY + (lines.join('\\n') || 'export {}') }
}
`

function installGlobals() {
  const noop = () => {}
  const mobius = {
    signal: noop,
    online: true,
    onOnlineChange: (cb) => { cb(true); return noop },
    nav: { open: () => ({ ready: Promise.resolve(), close: noop }), close: noop },
    chat: { open: noop, close: noop },
  }
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: true }, configurable: true, writable: true,
    })
  } catch { /* keep Node's built-in navigator */ }
  globalThis.window = {
    mobius,
    addEventListener: noop,
    removeEventListener: noop,
    location: { origin: 'http://localhost' },
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  }
  globalThis.document = {
    addEventListener: noop,
    removeEventListener: noop,
    visibilityState: 'visible',
  }
  // TasksApp's load() calls the real global fetch on first render (useEffect is
  // a no-op under this stub, so it never actually fires — but stub it anyway
  // defensively in case any top-level code path reaches for it).
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '' })
}

test('App() renders without throwing (render smoke)', async (t) => {
  if (!nm) {
    t.skip('frontend bundle deps unavailable — set MOBIUS_FRONTEND_NODE_MODULES')
    return
  }
  installGlobals()
  const mod = await bundleAndImport()
  const App = mod.default
  assert.equal(typeof App, 'function', 'index.jsx must default-export the App component')
  const rendered = App({ appId: 1, token: 'smoke-token' })
  assert.notEqual(rendered, undefined, 'App() must return an element tree')
  await rm(buildDir, { recursive: true, force: true })
})
