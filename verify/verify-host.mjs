/**
 * Standalone verification of the agents-md-every-turn Host plugin.
 *
 * Drives the real `agent/pre-step` listener and the REAL projection definition
 * captured from `ctx.sessionProjections.register()`, against a fake Cordis
 * context whose `fs` reads the real filesystem. Nothing is copied from the
 * plugin: the fold, schema validation, model matching, per-turn gating,
 * rendering, framing and byte budget are all exercised through the same code
 * the Host loads.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js'))
const mod = await import(PLUGIN)
const { apply, inject } = mod

let failures = 0
function check(name, ok, detail) {
  if (ok) {
    console.log(`PASS  ${name}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
}

/**
 * Build a fake Host context that records listeners and the projection unit.
 * @param {unknown} config - plugin config.
 * @param {string} [cwd] - the fake Session's effective working directory.
 */
async function createHost(config, cwd = process.cwd()) {
  const listeners = new Map()
  const services = {
    sessions: {
      get: (id) => (id === 'session-a' || id === 'session-b' || id === 'session-c'
        ? { id, header: { cwd } }
        : undefined),
    },
    workingDirectory: { get: (session) => session.header.cwd },
    fs: {
      async lstat(path) {
        try {
          const info = await stat(path)
          return { version: `${info.size}:${info.mtimeMs}`, type: info.isFile() ? 'file' : 'other', size: info.size }
        } catch {
          return undefined
        }
      },
      async resolve(path) {
        return { targetKey: path, displayPath: path }
      },
      async readText(target) {
        return readFile(target.targetKey, 'utf8')
      },
    },
  }
  let projection
  services.sessionProjections = {
    async register(definition) {
      projection = definition
      return { stateOf: () => 0, readerFor: () => () => 0, dispose: async () => {} }
    },
  }
  const ctx = {
    get(name) {
      return services[name]
    },
    on(event, listener) {
      listeners.set(event, listener)
      return () => {}
    },
  }

  await apply(ctx, config)
  return { listeners, getProjection: () => projection }
}

/** Run one pre-step through the registered listener. */
async function runStep(listeners, { agentId, turn, step, provider, model, reject }) {
  const listener = listeners.get('agent/pre-step')
  const enter = { kind: 'enter', messages: [{ id: 'user-1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }], startsRequestSeries: true }
  const decision = await listener(
    {
      agent: { id: agentId },
      messages: enter.messages,
      turn,
      step,
      signal: new AbortController().signal,
      modelSelection: { provider, model },
    },
    async () => (reject === true ? { kind: 'reject' } : enter),
  )
  return decision
}

const agentsMd = join(homedir(), '.dsh', 'AGENTS.md')

// --- Dependency declaration (the reported regression) -----------------------
check('inject declares all four services', ['sessions', 'workingDirectory', 'fs', 'sessionProjections'].every((k) => inject.includes(k)), JSON.stringify(inject))

// --- DeepSeek: one delivery per turn, content and framing intact -------------
{
  const { listeners, getProjection } = await createHost({})
  const first = await runStep(listeners, { agentId: 'session-a', turn: 1, step: 1, provider: 'deepseek', model: 'deepseek-chat' })
  const injected = first.messages.at(-1)
  check('deepseek turn 1 injects one message', first.messages.length === 2)
  check('keeps startsRequestSeries', first.startsRequestSeries === true)
  check('injected message is a user message', injected.role === 'user')
  check('injected message carries the plugin source kind', injected.source?.kind === 'agents-md-every-turn')
  check('injected message is frozen', Object.isFrozen(injected) && Object.isFrozen(injected.content))
  const text = injected.content[0].text
  check('block is framed by system-reminder', text.startsWith('<system-reminder>') && text.endsWith('</system-reminder>'))
  check('names the configured source path', text.includes(agentsMd))
  check('carries the real AGENTS.md content', text.includes('Pre-Execution Alignment'))
  check('closing frames inside content are escaped', (text.match(/<\/system-reminder>/g) ?? []).length === 1)

  const sameTurn = await runStep(listeners, { agentId: 'session-a', turn: 1, step: 2, provider: 'deepseek', model: 'deepseek-chat' })
  check('same turn step 2 does not inject again', sameTurn.messages.length === 1)

  const nextTurn = await runStep(listeners, { agentId: 'session-a', turn: 2, step: 1, provider: 'deepseek', model: 'deepseek-chat' })
  check('turn 2 injects again', nextTurn.messages.length === 2)
  check('each turn mints a fresh message id', nextTurn.messages.at(-1).id !== injected.id)

  // --- The REAL projection fold, captured from register() -------------------
  const def = getProjection()
  check('projection key matches the Client hook', def.key === 'agentsMdInjections')
  check('projection declares wire.view', typeof def.wire?.view === 'function' && typeof def.wire?.viewSchema?.parse === 'function')
  check('projection is excluded from session summaries', def.wire.summary === false)
  check('state schema validates a non-negative integer', def.stateSchema.parse(3) === 3)
  let threw = false
  try { def.stateSchema.parse(-1) } catch { threw = true }
  check('state schema rejects negative values', threw)

  let state = def.init()
  const event = (type, data) => ({ type, data, seq: 0, time: 0 })
  const injectedEvent = event('user/message', injected)
  const ordinaryEvent = event('user/message', { id: 'x', role: 'user', content: [], source: { kind: 'user' } })
  const toolEvent = event('tool/result', { message: {} })

  check('fold ignores unrelated event types by reference', def.apply(state, toolEvent) === state)
  check('fold ignores ordinary user messages by reference', def.apply(state, ordinaryEvent) === state)
  const afterOne = def.apply(state, injectedEvent)
  check('fold counts one injected message', afterOne === 1)
  const afterTwo = def.apply(afterOne, injectedEvent)
  check('fold accumulates across injections', afterTwo === 2)
  check('wire.view returns the count directly', def.wire.view(afterTwo) === 2)
  check('wire.viewSchema accepts the view', def.wire.viewSchema.parse(def.wire.view(afterTwo)) === 2)
}

// --- Other models and rejected steps stay untouched -------------------------
{
  const { listeners } = await createHost({})
  const other = await runStep(listeners, { agentId: 'session-a', turn: 1, step: 1, provider: 'openai', model: 'gpt-5' })
  check('non-deepseek model is untouched', other.messages.length === 1)
  const rejected = await runStep(listeners, { agentId: 'session-a', turn: 1, step: 1, provider: 'deepseek', model: 'deepseek-chat', reject: true })
  check('rejected step stays rejected', rejected.kind === 'reject')
}

// --- A throwing inject helper must never fail the turn ---------------------
{
  const { listeners } = await createHost({ paths: ['<malformed>'] })
  // Even a hostile path must still yield the loop's own decision, not throw.
  let ok = true
  try {
    const d = await runStep(listeners, { agentId: 'session-a', turn: 1, step: 1, provider: 'deepseek', model: 'deepseek-chat' })
    ok = d.kind === 'enter'
  } catch { ok = false }
  check('listener always yields a decision on errors', ok)
}

// --- Cadence and pattern are configurable ----------------------------------
{
  const { listeners } = await createHost({ cadence: 'step', modelPattern: 'deepseek-reasoner' })
  const stepOne = await runStep(listeners, { agentId: 'session-b', turn: 3, step: 1, provider: 'deepseek', model: 'deepseek-reasoner' })
  const stepTwo = await runStep(listeners, { agentId: 'session-b', turn: 3, step: 2, provider: 'deepseek', model: 'deepseek-reasoner' })
  check('cadence: step injects on every step', stepOne.messages.length === 2 && stepTwo.messages.length === 2)
  const unmatched = await runStep(listeners, { agentId: 'session-b', turn: 4, step: 1, provider: 'deepseek', model: 'deepseek-chat' })
  check('modelPattern narrows the match', unmatched.messages.length === 1)
}

// --- Byte budget truncates with a visible notice ---------------------------
{
  const { listeners } = await createHost({ maxBytes: 600 })
  const decision = await runStep(listeners, { agentId: 'session-a', turn: 1, step: 1, provider: 'deepseek', model: 'deepseek-chat' })
  const text = decision.messages.at(-1).content[0].text
  check('budget notice is rendered', text.includes('instruction budget of 600 bytes reached'))
  check('truncated block stays under budget plus framing', Buffer.byteLength(text, 'utf8') < 1200)
}

// --- Missing sources produce no message at all -----------------------------
{
  const { listeners } = await createHost({ paths: [join(homedir(), '.dsh', 'does-not-exist.md')] })
  const decision = await runStep(listeners, { agentId: 'session-a', turn: 1, step: 1, provider: 'deepseek', model: 'deepseek-chat' })
  check('absent sources inject nothing', decision.messages.length === 1)
}

// --- Disposal clears the record so a rebuilt Session injects again ---------
{
  const { listeners } = await createHost({})
  await runStep(listeners, { agentId: 'session-a', turn: 7, step: 1, provider: 'deepseek', model: 'deepseek-chat' })
  listeners.get('agent/disposed')({ agent: { id: 'session-a' } })
  const afterDispose = await runStep(listeners, { agentId: 'session-a', turn: 7, step: 1, provider: 'deepseek', model: 'deepseek-chat' })
  check('disposal resets per-turn state', afterDispose.messages.length === 2)
}

// --- Interaction boundaries re-deliver inside the same turn ----------------
/** Feed one committed Session event through the session/event listener. */
function feed(listeners, sessionId, type, data) {
  listeners.get('session/event')({ id: sessionId }, { type, data, seq: 1, time: 0 })
}

/** Simulate one completed tool call, including the call/result pairing. */
function completeCall(listeners, sessionId, callId, toolName) {
  feed(listeners, sessionId, 'tool/call', { turn: 1, step: 1, callId, name: toolName, arguments: '{}' })
  feed(listeners, sessionId, 'tool/result', { turn: 1, step: 2, message: { toolCallId: callId } })
}

{
  const { listeners } = await createHost({})
  const first = await runStep(listeners, { agentId: 'session-a', turn: 5, step: 1, provider: 'deepseek', model: 'deepseek-chat' })
  check('turn 5 step 1 injects', first.messages.length === 2)

  const plain = await runStep(listeners, { agentId: 'session-a', turn: 5, step: 2, provider: 'deepseek', model: 'deepseek-chat' })
  check('plain step in the same turn does not inject', plain.messages.length === 1)

  // ask_user_question completed -> the very next step re-delivers, same turn.
  completeCall(listeners, 'session-a', 'call-1', 'ask_user_question')
  const afterQuestion = await runStep(listeners, { agentId: 'session-a', turn: 5, step: 3, provider: 'deepseek', model: 'deepseek-chat' })
  check('ask_user_question result re-injects in the same turn', afterQuestion.messages.length === 2)
  check('re-injected batch still carries the source kind', afterQuestion.messages.at(-1).source?.kind === 'agents-md-every-turn')

  const consumed = await runStep(listeners, { agentId: 'session-a', turn: 5, step: 4, provider: 'deepseek', model: 'deepseek-chat' })
  check('the interaction flag is one-shot', consumed.messages.length === 1)

  // A non-interaction tool must not trigger.
  completeCall(listeners, 'session-a', 'call-2', 'read')
  const afterRead = await runStep(listeners, { agentId: 'session-a', turn: 5, step: 5, provider: 'deepseek', model: 'deepseek-chat' })
  check('ordinary tool results do not re-inject', afterRead.messages.length === 1)

  // Wildcard pattern covers MCP question tools.
  completeCall(listeners, 'session-a', 'call-3', 'mcp__LibTV__ask_followup_questions')
  const afterMcp = await runStep(listeners, { agentId: 'session-a', turn: 5, step: 6, provider: 'deepseek', model: 'deepseek-chat' })
  check('wildcard matches MCP question tools', afterMcp.messages.length === 2)

  // Approval outcome re-delivers.
  feed(listeners, 'session-a', 'approval/decided', { outcome: 'allowed-once' })
  const afterApproval = await runStep(listeners, { agentId: 'session-a', turn: 5, step: 7, provider: 'deepseek', model: 'deepseek-chat' })
  check('approval outcome re-injects', afterApproval.messages.length === 2)

  // A mid-turn human message re-delivers; our own injected batch must not.
  feed(listeners, 'session-a', 'user/message', { role: 'user', content: [], source: { kind: 'user' } })
  const afterUser = await runStep(listeners, { agentId: 'session-a', turn: 5, step: 8, provider: 'deepseek', model: 'deepseek-chat' })
  check('mid-turn user message re-injects', afterUser.messages.length === 2)

  feed(listeners, 'session-a', 'user/message', { role: 'user', content: [], source: { kind: 'agents-md-every-turn' } })
  const afterOwn = await runStep(listeners, { agentId: 'session-a', turn: 5, step: 9, provider: 'deepseek', model: 'deepseek-chat' })
  check('own injected batch is not an interaction', afterOwn.messages.length === 1)
}

// --- Non-deepseek models ignore every interaction signal -------------------
{
  const { listeners } = await createHost({})
  completeCall(listeners, 'session-b', 'call-x', 'ask_user_question')
  feed(listeners, 'session-b', 'approval/decided', { outcome: 'allowed-once' })
  const decision = await runStep(listeners, { agentId: 'session-b', turn: 2, step: 1, provider: 'openai', model: 'gpt-5' })
  check('interaction signals do not bypass the model gate', decision.messages.length === 1)
}

// --- Each interaction switch is independently configurable ----------------
{
  const { listeners } = await createHost({ injectAfterApproval: false, injectAfterUserInput: false })
  await runStep(listeners, { agentId: 'session-c', turn: 1, step: 1, provider: 'deepseek', model: 'deepseek-chat' })
  feed(listeners, 'session-c', 'approval/decided', { outcome: 'allowed-once' })
  feed(listeners, 'session-c', 'user/message', { role: 'user', content: [], source: { kind: 'user' } })
  const quiet = await runStep(listeners, { agentId: 'session-c', turn: 1, step: 2, provider: 'deepseek', model: 'deepseek-chat' })
  check('disabled switches suppress those triggers', quiet.messages.length === 1)

  completeCall(listeners, 'session-c', 'call-y', 'ask_user_question')
  const stillWorks = await runStep(listeners, { agentId: 'session-c', turn: 1, step: 3, provider: 'deepseek', model: 'deepseek-chat' })
  check('interaction tools stay active independently', stillWorks.messages.length === 2)
}

// --- A malformed event must not escape the observer ------------------------
{
  const { listeners } = await createHost({})
  let threw = false
  try {
    listeners.get('session/event')({ id: 'session-a' }, { type: 'tool/result' })
    listeners.get('session/event')({ id: 'session-a' }, { type: 'user/message' })
  } catch { threw = true }
  check('malformed session events are contained', threw === false)
}

// --- Project-chain discovery from the Session directory --------------------
{
  const fixture = await mkdtemp(join(tmpdir(), 'amd-fixture-'))
  const nowhere = join(fixture, 'no-such-file.md')
  // A marked project: root AGENTS.md plus a nested one, broad to specific.
  const project = join(fixture, 'proj')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'AGENTS.md'), 'ROOT-RULE-ONLY', 'utf8')
  await mkdir(join(project, 'packages', 'app'), { recursive: true })
  await writeFile(join(project, 'packages', 'app', 'AGENTS.md'), 'APP-RULE-ONLY', 'utf8')
  // An unmarked directory: only its own file may contribute.
  const loose = join(fixture, 'loose')
  await mkdir(loose, { recursive: true })
  await writeFile(join(loose, 'AGENTS.md'), 'LOOSE-RULE-ONLY', 'utf8')
  // A project whose two levels carry identical content.
  const dup = join(fixture, 'dup')
  await mkdir(join(dup, '.git'), { recursive: true })
  await writeFile(join(dup, 'AGENTS.md'), 'SAME-RULE-EVERYWHERE', 'utf8')
  await mkdir(join(dup, 'sub'), { recursive: true })
  await writeFile(join(dup, 'sub', 'AGENTS.md'), 'SAME-RULE-EVERYWHERE', 'utf8')

  /** Read the injected text for one fake Session anchored at `cwd`. */
  async function injectAt(cwd, config = { paths: [nowhere] }) {
    const { listeners } = await createHost(config, cwd)
    const decision = await runStep(listeners, { agentId: 'session-c', turn: 1, step: 1, provider: 'deepseek', model: 'deepseek-chat' })
    return decision.messages.length === 2 ? decision.messages.at(-1).content[0].text : ''
  }

  const nested = await injectAt(join(project, 'packages', 'app'))
  check('discovers the project root above the Session directory', nested.includes('ROOT-RULE-ONLY'))
  check('includes the Session directory own file', nested.includes('APP-RULE-ONLY'))
  check('delivers broad before specific', nested.indexOf('ROOT-RULE-ONLY') < nested.indexOf('APP-RULE-ONLY'))

  const unmarked = await injectAt(loose)
  check('an unmarked tree contributes only the Session directory', unmarked.includes('LOOSE-RULE-ONLY'))
  check('an unmarked tree does not climb into unrelated directories', (unmarked.match(/Instructions from:/g) ?? []).length === 1)

  const duplicated = await injectAt(join(dup, 'sub'))
  check('identical content is delivered once', (duplicated.match(/SAME-RULE-EVERYWHERE/g) ?? []).length === 1)

  const disabled = await injectAt(join(project, 'packages', 'app'), { paths: [nowhere], discover: false })
  check('discover:false disables the chain entirely', disabled === '')

  const customCandidate = await injectAt(join(project, 'packages', 'app'), {
    paths: [nowhere],
    instructionFileCandidates: ['AGENTS.md', 'CLAUDE.md'],
  })
  check('candidate names stay configurable', customCandidate.includes('ROOT-RULE-ONLY'))

  await rm(fixture, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
