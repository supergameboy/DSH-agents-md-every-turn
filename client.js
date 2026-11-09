/**
 * Client half of `agents-md-every-turn`.
 *
 * Renders a small, always-visible pill in `conversation.composer.dock` (the
 * ambient row below the composer card) showing how many AGENTS.md instruction
 * batches this plugin has injected into the current Session.
 *
 * The count is NOT kept here. The Host half registers a `sessionProjections`
 * unit whose `wire.view` folds sourced `user/message` events, and the slot's
 * session-scoped `useProjection` hook delivers that already-computed value and
 * subscribes to its changes. The Client never folds the Session log itself.
 *
 * Styling uses only `--dsw-alias-*` theme tokens, so light/dark switching is
 * inherited from the host without any hardcoded surface colors.
 *
 * @module @local/agents-md-every-turn/client
 */

window.__ModuleLoader__.load({
  id: '@local/agents-md-every-turn',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'agents-md-every-turn'

    const dictionaries = {
      en: {
        badge: 'AGENTS.md injected {count} time(s)',
        tooltip: 'Number of AGENTS.md instruction batches injected into this Session by the Agents.md every turn plugin.',
      },
      zh: {
        badge: 'AGENTS.md 已注入 {count} 次',
        tooltip: '本会话中由「Agents.md 每轮注入」插件注入的 AGENTS.md 指令批次数。',
      },
    }

    /**
     * Split a dictionary template at its `{count}` placeholder so the numeric
     * value can be emphasized without searching for its text in the result.
     */
    function labelParts(template, count) {
      const parts = String(template).split('{count}')
      return {
        before: parts[0],
        value: String(count),
        after: parts.slice(1).join('{count}'),
      }
    }

    /** Pill component; `t` is bound to our namespace by the slot's `locale` option. */
    function makeBadge(fallbackT) {
      return function AgentsMdBadge(props) {
        const useProjection = props?.useProjection
        const t = typeof props?.t === 'function' ? props.t : fallbackT

        // A custom projection key is read directly; the framework's slot scope
        // binds it to the current Session and re-renders on value changes.
        const raw = typeof useProjection === 'function' ? useProjection('agentsMdInjections') : undefined
        const count = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0

        const parts = labelParts(t('badge'), count)
        const tooltip = t('tooltip')

        return h('span', {
          'data-agents-md-injections': String(count),
          title: tooltip,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '2px 10px',
            borderRadius: '999px',
            fontSize: '12px',
            lineHeight: '18px',
            whiteSpace: 'nowrap',
            userSelect: 'none',
            color: 'var(--dsw-alias-label-secondary)',
            border: '1px solid var(--dsw-alias-border-l1)',
            backgroundColor: 'var(--dsw-alias-bg-layer-1)',
          },
        },
          h('span', {
            'aria-hidden': true,
            style: {
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              backgroundColor: 'var(--dsw-alias-brand-primary)',
              flex: '0 0 auto',
            },
          }),
          h('span', null,
            parts.before,
            h('strong', {
              style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 },
            }, parts.value),
            parts.after,
          ),
        )
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // Both registrations are owned by this plugin's Client fiber: unloading
        // removes the namespace dictionaries and the composer-dock entry.
        ctx.effect(() => ctx.locale.register(NS, dictionaries), 'agents-md-every-turn: dictionary')

        const Badge = makeBadge(ctx.locale.bind(NS))
        const disposeSlot = ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'agents-md-every-turn',
          order: 100,
          label: 'AGENTS.md injections',
          locale: NS,
        }, Badge))
        ctx.effect(() => disposeSlot, 'agents-md-every-turn: composer dock')
      },
    }
  },
})
