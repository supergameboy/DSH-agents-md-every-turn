/**
 * Smoke-test the Client half without a browser: stub window.__ModuleLoader__
 * and a minimal React.createElement, then render the registered component for
 * several projection values and assert the resulting element tree.
 */
import { readFile } from 'node:fs/promises'

const source = await readFile(
  'C:/Users/01/Documents/deepseek-harness/default-workspace/dsh-plugins/agents-md-every-turn/client.js',
  'utf8',
)

let failures = 0
function check(name, ok, detail) {
  if (ok) console.log(`PASS  ${name}`)
  else { failures += 1; console.log(`FAIL  ${name}${detail ? ` :: ${detail}` : ''}`) }
}

/** Collect the loaded factory and expose a fake module table. */
let captured
globalThis.window = {
  __ModuleLoader__: {
    load(spec) { captured = spec },
  },
}

// An inert React stand-in that records element props/children.
const reactStub = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }
  },
  Fragment: Symbol('Fragment'),
}
const modules = { react: reactStub }

new Function('window', 'require', source)(globalThis.window, (name) => {
  if (!(name in modules)) throw new Error(`unexpected require: ${name}`)
  return modules[name]
})

check('client registers a factory with the package id', captured?.id === '@local/agents-md-every-turn')
const exported = captured.factory((name) => modules[name])
check('factory declares slots + locale services', ['slots', 'locale'].every((s) => exported.inject.includes(s)))

// Build the component through apply(), capturing the slot registration.
let slotRegistration
let dictionary
const ctx = {
  effect(register, label) {
    // Locale registration returns a disposer; capture the dictionary payload.
    if (label.includes('dictionary')) dictionary = register()
    return () => {}
  },
  locale: {
    register(ns, dicts) {
      check('locale namespace is registered', ns === 'agents-md-every-turn')
      check('dictionaries cover both baseline locales', 'en' in dicts && 'zh' in dicts)
      return () => {}
    },
    bind() {
      const dict = {
        badge: 'AGENTS.md injected {count} time(s)',
        tooltip: 'Injection count tooltip',
      }
      return (key) => dict[key] ?? key
    },
  },
  slots: {
    inject(slot, callback) {
      check('component is injected into conversation.composer.dock', slot === 'conversation.composer.dock')
      const dispose = callback()
      check('inject returns a disposer', typeof dispose === 'function')
      return () => {}
    },
    register(options, Component) {
      check('registration has a unique id', options.id === 'agents-md-every-turn')
      check('registration binds its locale namespace', options.locale === 'agents-md-every-turn')
      slotRegistration = { options, Component }
      return () => {}
    },
  },
}
exported.apply(ctx)
check('slot entry produced a component', typeof slotRegistration?.Component === 'function')

const Badge = slotRegistration.Component

/** Walk the element tree collecting text and the strong value. */
function readTree(node, acc = { texts: [], strong: null, attrs: {} }) {
  if (node === null || node === undefined || typeof node !== 'object') {
    if (typeof node === 'string' || typeof node === 'number') acc.texts.push(String(node))
    return acc
  }
  if (typeof node.type === 'object' || typeof node.type === 'symbol') {
    for (const child of node.children) readTree(child, acc)
    return acc
  }
  Object.assign(acc.attrs, node.props)
  if (node.type === 'strong') acc.strong = node.children.join('')
  for (const child of node.children) readTree(child, acc)
  return acc
}

function render(count, withT = true) {
  const props = { useProjection: (key) => (key === 'agentsMdInjections' ? count : undefined) }
  if (withT) props.t = ctx.locale.bind('agents-md-every-turn')
  return readTree(Badge(props))
}

const zero = render(0)
check('count 0 renders a 0 badge', zero.attrs['data-agents-md-injections'] === '0' && zero.strong === '0')
check('count 0 keeps the full English label', zero.texts.join('').includes('AGENTS.md injected') && zero.texts.join('').includes('time(s)'))
check('badge carries an accessible tooltip', zero.attrs.title === 'Injection count tooltip')

const three = render(3)
check('count 3 renders the value', three.attrs['data-agents-md-injections'] === '3' && three.strong === '3')

const missing = render(undefined)
check('undefined projection falls back to 0', missing.attrs['data-agents-md-injections'] === '0')

const negative = render(-5)
check('negative projection is clamped to 0', negative.attrs['data-agents-md-injections'] === '0')

const noHook = readTree(Badge({ t: ctx.locale.bind('agents-md-every-turn') }))
check('missing useProjection still renders safely', noHook.attrs['data-agents-md-injections'] === '0')

check('styling uses only theme tokens', Object.entries(zero.attrs.style ?? {}).every(([, v]) => typeof v !== 'string' || !v.includes('#') || v.startsWith('var(')))

console.log(failures === 0 ? '\nALL CLIENT CHECKS PASSED' : `\n${failures} CLIENT CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
