/**
 * Host half of the `agents-md-every-turn` bundle.
 *
 * The harness delivers the workspace instruction baseline once per Session.
 * A model that drifts away from that baseline later in the conversation has no
 * second reminder, so this plugin re-delivers the instruction files at the
 * start of every turn while the Session's selected model matches a pattern
 * (DeepSeek by default).
 *
 * Delivery happens on `agent/pre-step`, the waterfall that decides which
 * messages enter the next model step. The listener takes the loop's own
 * decision and returns it with one extra sourced user message appended, so the
 * content is committed to the Session log like any other history and replays,
 * resumes, and compacts instead of being a hidden request-level patch.
 *
 * @module @local/agents-md-every-turn
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/**
 * Service dependencies, kept for readiness ordering. Runtime reads go through
 * `ctx.get(name)` plus an undefined check — Cordis' documented optional access
 * form — so a direct property read can never raise "cannot get property
 * <name> without inject" or take a whole turn down.
 * `sessionProjections` is a hard dependency (as in the shipped session-stats
 * plugin): the counter projection is a core part of this bundle.
 */
export const inject = ['sessions', 'workingDirectory', 'fs', 'sessionProjections']

/** Message source kind that marks every batch this plugin injects. */
const SOURCE_KIND = 'agents-md-every-turn'

/** Default substring matched against `<provider>/<model>`; empty matches every model. */
const DEFAULT_MODEL_PATTERN = 'deepseek'

/** Instruction sources in delivery order; relative entries resolve against the Session directory. */
const DEFAULT_PATHS = ['~/.dsh/AGENTS.md', '~/.agents/AGENTS.md', 'AGENTS.md']

/** Byte budget for one injected batch, matching the harness baseline budget. */
const DEFAULT_MAX_BYTES = 65536

/**
 * Tools whose completion means the model just received a human answer, so the
 * next step re-delivers the instructions. Entries are exact names; an entry
 * containing `*` is a case-insensitive wildcard, which is how the shipped
 * `ask_user_question` and MCP question tools are covered by one pattern.
 */
const DEFAULT_INTERACTION_TOOLS = ['ask_user_question', '*question*']

/** How many recent tool calls one Session may remember for call/result pairing. */
const MAX_TRACKED_CALLS = 64

/** Closing frame inside instruction text must not end the plugin-owned block. */
const CLOSING_FRAME = /<\/system-reminder>/gi

/** Instruction files are listed in the message with the path that supplied them. */
const INTRO = [
  'Workspace instructions for this turn, re-delivered because this Session runs on a matched model.',
  'Apply them now: more specific instructions take precedence over broader ones, and they never override system, developer, or direct user instructions.',
].join(' ')

/**
 * Normalize one row's config into the values read on every turn.
 * @param {unknown} config - the Loader row's `config` value.
 * @returns {{modelPattern: string, cadence: 'turn' | 'step', paths: string[], maxBytes: number,
 *   interactionTools: string[], injectAfterApproval: boolean, injectAfterUserInput: boolean}}
 */
function readSettings(config) {
  const raw = config ?? {}
  const configured = Array.isArray(raw.paths) ? raw.paths.filter(isNonEmptyString) : []
  const tools = Array.isArray(raw.interactionTools) ? raw.interactionTools.filter(isNonEmptyString) : []
  return {
    modelPattern: typeof raw.modelPattern === 'string' ? raw.modelPattern.trim() : DEFAULT_MODEL_PATTERN,
    cadence: raw.cadence === 'step' ? 'step' : 'turn',
    paths: configured.length > 0 ? configured : DEFAULT_PATHS,
    maxBytes: Number.isSafeInteger(raw.maxBytes) && raw.maxBytes > 0 ? raw.maxBytes : DEFAULT_MAX_BYTES,
    interactionTools: tools.length > 0 ? tools : DEFAULT_INTERACTION_TOOLS,
    injectAfterApproval: raw.injectAfterApproval !== false,
    injectAfterUserInput: raw.injectAfterUserInput !== false,
  }
}

/** @param {unknown} value */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Test the step's captured model selection against the configured pattern.
 * @param {{provider?: string, model?: string} | undefined} selection - the step's detached selection.
 * @param {string} pattern - case-insensitive substring; empty matches everything.
 * @returns {boolean} whether this step should receive the instructions.
 */
function matchesModel(selection, pattern) {
  if (pattern.length === 0) return true
  if (selection === undefined || selection === null) return false
  const provider = typeof selection.provider === 'string' ? selection.provider : ''
  const model = typeof selection.model === 'string' ? selection.model : ''
  return `${provider}/${model}`.toLowerCase().includes(pattern.toLowerCase())
}

/**
 * Read or create the per-agent delivery record.
 * @param {Map<string, {turn: number | undefined, force: boolean, calls: Map<string, string>, files: Map<string, {version: string, text: string}>}>} records
 * @param {string} agentId
 */
function recordFor(records, agentId) {
  let record = records.get(agentId)
  if (record === undefined) {
    record = { turn: undefined, force: false, calls: new Map(), files: new Map() }
    records.set(agentId, record)
  }
  return record
}

/** Escape one literal fragment for a RegExp. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Build one matcher over the configured interaction-tool entries.
 * An entry without `*` matches the exact tool name; an entry with `*` matches
 * case-insensitively as a wildcard, so `*question*` covers both the shipped
 * `ask_user_question` tool and MCP question tools.
 * @param {readonly string[]} patterns
 * @returns {(toolName: unknown) => boolean}
 */
function buildInteractionMatcher(patterns) {
  const exact = new Set()
  const wildcards = []
  for (const pattern of patterns) {
    if (!pattern.includes('*')) {
      exact.add(pattern)
      continue
    }
    wildcards.push(new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`, 'i'))
  }
  return (toolName) => {
    if (typeof toolName !== 'string' || toolName.length === 0) return false
    if (exact.has(toolName)) return true
    return wildcards.some((expression) => expression.test(toolName))
  }
}

/**
 * Pair a tool call with its result inside one Session so the result can be
 * attributed to the tool that produced it. The Session log carries the tool
 * name only on `tool/call`, so results are matched through their call id.
 * @param {{calls: Map<string, string>}} record - the Session's delivery record.
 * @param {{type: string, data: any}} event - one committed Session event.
 * @returns {string | undefined} the completed call's tool name, when known.
 */
function completeToolCall(record, event) {
  if (event.type === 'tool/call') {
    const { callId, name } = event.data ?? {}
    if (typeof callId !== 'string' || typeof name !== 'string') return undefined
    record.calls.set(callId, name)
    // Keep the pairing table bounded on long Sessions.
    if (record.calls.size > MAX_TRACKED_CALLS) {
      const oldest = record.calls.keys().next()
      if (!oldest.done) record.calls.delete(oldest.value)
    }
    return undefined
  }
  if (event.type !== 'tool/result') return undefined
  const callId = event.data?.message?.toolCallId
  if (typeof callId !== 'string') return undefined
  const name = record.calls.get(callId)
  record.calls.delete(callId)
  return name
}

/**
 * Expand one configured source into an absolute path.
 * @param {string} source - configured path, `~` home-relative, absolute, or Session-relative.
 * @param {string | undefined} cwd - the Session's effective directory.
 * @returns {string | undefined} the absolute path, or undefined when a relative source has no base.
 */
function expandSourcePath(source, cwd) {
  const trimmed = source.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(homedir(), trimmed.slice(2))
  if (isAbsolute(trimmed)) return trimmed
  return cwd === undefined ? undefined : resolve(cwd, trimmed)
}

/**
 * Read the Session's effective working directory.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{id: string}} agent
 * @returns {string | undefined}
 */
function sessionDirectory(ctx, agent) {
  const sessions = ctx.get('sessions')
  const workingDirectory = ctx.get('workingDirectory')
  if (sessions === undefined || workingDirectory === undefined) return undefined
  const session = sessions.get(agent.id)
  return session === undefined ? undefined : workingDirectory.get(session)
}

/**
 * Read one instruction file, reusing the cached text while the file identity is unchanged.
 * A provider failure keeps the last good content, so a transient error cannot silently
 * drop instructions the Session already applied.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} path - absolute path.
 * @param {{files: Map<string, {version: string, text: string}>}} record
 * @returns {Promise<{kind: 'absent'} | {kind: 'unavailable'} | {kind: 'text', text: string}>}
 */
async function readInstructionFile(ctx, path, record) {
  const fs = ctx.get('fs')
  if (fs === undefined) return { kind: 'unavailable' }
  const cached = record.files.get(path)
  let info
  try {
    info = await fs.lstat(path)
  } catch (_metadataFailure) {
    return cached === undefined ? { kind: 'unavailable' } : { kind: 'text', text: cached.text }
  }
  if (info === undefined || info.type !== 'file') {
    record.files.delete(path)
    return { kind: 'absent' }
  }
  if (cached !== undefined && cached.version === info.version) return { kind: 'text', text: cached.text }
  try {
    const target = await fs.resolve(path)
    const text = await fs.readText(target)
    record.files.set(path, { version: info.version, text })
    return { kind: 'text', text }
  } catch (_readFailure) {
    return cached === undefined ? { kind: 'unavailable' } : { kind: 'text', text: cached.text }
  }
}

/**
 * Cut text to a UTF-8 byte budget without splitting a multi-byte sequence.
 * @param {string} text
 * @param {number} maxBytes
 * @returns {{text: string, truncated: boolean}}
 */
function truncateToBytes(text, maxBytes) {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return { text, truncated: false }
  let end = Math.max(0, maxBytes)
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true }
}

/**
 * Compose the model-facing batch for one turn.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{id: string}} agent
 * @param {{paths: string[], maxBytes: number}} settings
 * @param {{files: Map<string, {version: string, text: string}>}} record
 * @returns {Promise<string | undefined>} the rendered block, or undefined when nothing is available.
 */
async function composeInstructionMessage(ctx, agent, settings, record) {
  const cwd = sessionDirectory(ctx, agent)
  const sections = []
  let remaining = settings.maxBytes
  let truncated = false

  for (const source of settings.paths) {
    const path = expandSourcePath(source, cwd)
    if (path === undefined) continue

    const read = await readInstructionFile(ctx, path, record)
    if (read.kind === 'absent') continue
    if (read.kind === 'unavailable') {
      sections.push(`Instructions from: ${path}\n\n[this file could not be read for this turn]`)
      continue
    }

    const escaped = read.text.replace(CLOSING_FRAME, '<\\/system-reminder>')
    const budgeted = truncateToBytes(escaped, remaining)
    sections.push(`Instructions from: ${path}\n\n${budgeted.text}`)
    remaining -= Buffer.byteLength(budgeted.text, 'utf8')
    if (budgeted.truncated) {
      truncated = true
      break
    }
  }

  if (sections.length === 0) return undefined

  const lines = ['<system-reminder>', INTRO, '', ...sections]
  if (truncated) {
    lines.push('', `[instruction budget of ${settings.maxBytes} bytes reached: the remaining content was truncated.]`)
  }
  lines.push('</system-reminder>')
  return lines.join('\n')
}

/**
 * Freeze a value graph in place, the way the loop publishes message batches.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return value
}

/**
 * Build the sourced user message that carries one rendered batch.
 * @param {string} text - rendered block.
 * @returns {object} a frozen, identified user message.
 */
function createInjectedMessage(text) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND },
  })
}

/**
 * Client-visible projection key. The composer-dock badge reads this through
 * the slot's `useProjection` hook. A custom key needs no Client registration:
 * declaring `wire.view` here is enough for the carrier to deliver it.
 */
const COUNT_KEY = 'agentsMdInjections'

/**
 * The registry only calls `schema.parse(value)` on our state and view. Our
 * state is a non-negative integer that is also the complete client view, so a
 * tiny self-contained validator keeps this bundle free of third-party imports.
 * It validates (rather than coerces) and returns the value unchanged.
 */
const countSchema = {
  parse(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`agentsMdInjections expects a non-negative integer, received ${String(value)}`)
    }
    return value
  },
}

/**
 * A pure, synchronous fold of committed session events into the number of
 * AGENTS.md injections. Every injected batch is an ordinary sourced
 * `user/message` event, so the count reconstructs from replay, resume, fork,
 * and cold checkpoint rows without plugin memory. Unrelated events return the
 * same state reference to keep the eager projection drive free of work.
 */
const injectionCountProjection = {
  key: COUNT_KEY,
  stateVersion: 1,
  stateSchema: countSchema,
  init: () => 0,
  apply: (state, event) => {
    if (event.type !== 'user/message') return state
    const message = event.data
    return message?.source?.kind === SOURCE_KIND ? state + 1 : state
  },
  wire: {
    viewSchema: countSchema,
    view: (state) => state,
    // The count is only rendered in an opened session's composer, never in a
    // Session list row. Consistent with the shipped sessionStats/tokenUsage
    // units, an opened Session still receives the value through a full snapshot.
    summary: false,
  },
}

/**
 * Register the per-turn re-delivery of the configured instruction files and
 * the derived injection counter served to the Web composer.
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning plugin context.
 * @param {unknown} config - the Loader row's config.
 */
export async function apply(ctx, config) {
  const settings = readSettings(config)
  const records = new Map()
  const isInteractionTool = buildInteractionMatcher(settings.interactionTools)

  // The registration is an effect on this plugin's fiber; unloading removes
  // the key. Await it before the listener can admit a step, as the shipped
  // session-stats plugin does.
  await ctx.get('sessionProjections')?.register(injectionCountProjection)

  // Interaction boundary: every signal below means the model just resumed from
  // something that needed a human, so its attention is no longer on the
  // instructions. Each signal only raises a one-shot flag; the next admitted
  // step consumes it and injects once. The Session log is the source for all
  // three signals, so no approval or question API is intercepted (both are
  // fail-closed paths this plugin must not perturb).
  ctx.on('session/event', (session, event) => {
    try {
      if (event.type === 'tool/call') {
        // Pairing only; a call alone is not an interaction.
        completeToolCall(recordFor(records, session.id), event)
        return
      }
      if (event.type === 'tool/result') {
        const toolName = completeToolCall(recordFor(records, session.id), event)
        if (isInteractionTool(toolName)) recordFor(records, session.id).force = true
        return
      }
      if (event.type === 'approval/decided') {
        if (settings.injectAfterApproval) recordFor(records, session.id).force = true
        return
      }
      if (event.type === 'user/message' && settings.injectAfterUserInput) {
        // A mid-turn human message (steering, or a queued note admitted inside
        // an open turn). Our own injected batches carry a different source kind.
        if (event.data?.source?.kind === 'user') recordFor(records, session.id).force = true
      }
    } catch (_signalFailure) {
      // Observing the feed must never disturb the Session's own drive.
    }
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    // A waterfall listener must always yield a decision. If anything in this
    // optional enrichment fails, return the loop's own decision untouched so a
    // plugin problem can never fail the whole turn.
    const decision = await next()
    try {
      if (decision.kind !== 'enter') return decision
      if (!matchesModel(payload.modelSelection, settings.modelPattern)) return decision

      const record = recordFor(records, payload.agent.id)
      // Two independent reasons to re-deliver: a new turn started, or a human
      // interaction completed inside the current turn.
      const newTurn = settings.cadence === 'step' || record.turn !== payload.turn
      if (!newTurn && !record.force) return decision

      const text = await composeInstructionMessage(ctx, payload.agent, settings, record)
      if (text === undefined) return decision

      record.turn = payload.turn
      record.force = false
      return { ...decision, messages: [...decision.messages, createInjectedMessage(text)] }
    } catch (_injectionFailure) {
      return decision
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    records.delete(agent.id)
  })
}
