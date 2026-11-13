/**
 * caopazi-compact — keep the native compaction engine, change its policy.
 *
 * Two jobs:
 *  1. At preset config-resolution time, tune the stock `compaction-basic` row
 *     (70% threshold, 15% verbatim tail) and mount the anchor wrapper beside
 *     it. The engine itself is never replaced, so `ctx.compaction` remains the
 *     single provider and `/compact` keeps working.
 *  2. Register `/compact-status` so the threshold and the last reduction are
 *     visible without a new panel.
 *
 * This module deliberately imports nothing from `@deepseek-ai/*`: profile
 * plugins cannot resolve core packages from the profile tree, and only ctx
 * services are needed here.
 */

import { patchPresetConfig, ENGINE } from './patch.js'
import { trace } from './debug.js'

export const name = 'caopazi-compact'
export const inject = ['commands', 'tokenMeter', 'llm']

const DEFAULTS = Object.freeze({
  thresholdRatio: 0.7,
  retainRatio: 0.15,
  headroomTokens: 65536,
  anchorBudgetTokens: 1500,
})

const ENGINE_KEYS = [
  'headroomTokens',
  'retainTokens',
  'maxTokens',
  'compactionRetries',
  'maxOverflowRetries',
  'summarizationProvider',
  'summarizationModel',
  'modelPolicies',
]

function ratio(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 && parsed < 1 ? parsed : fallback
}

/** Normalize untrusted plugin config; invalid values fall back to defaults. */
export function normalizeOptions(config = {}) {
  const thresholdRatio = ratio(config.thresholdRatio, DEFAULTS.thresholdRatio)
  let retainRatio = ratio(config.retainRatio, DEFAULTS.retainRatio)
  if (retainRatio >= thresholdRatio) retainRatio = Math.max(0.05, thresholdRatio / 4)

  const anchors = {
    enabled: true,
    budgetTokens: DEFAULTS.anchorBudgetTokens,
    ...(config.anchors !== null && typeof config.anchors === 'object' && !Array.isArray(config.anchors) ? config.anchors : {}),
  }
  const budget = Number(anchors.budgetTokens)
  anchors.budgetTokens = Number.isFinite(budget) && budget > 0 ? budget : DEFAULTS.anchorBudgetTokens

  const options = {
    thresholdRatio,
    retainRatio,
    anchors,
    takeover: config.takeover === true,
  }
  for (const key of ENGINE_KEYS) {
    if (config[key] !== undefined) options[key] = config[key]
  }
  return options
}

function group(value) {
  return String(Math.max(0, Math.floor(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function lastCompaction(session) {
  const end = Number(session.seq)
  if (!Number.isFinite(end)) return null
  const floor = Math.max(0, end - 20000)
  for (let seq = end - 1; seq >= floor; seq -= 1) {
    const event = session.eventAt(seq)
    if (event?.type === 'compaction/summary') {
      const data = event.data ?? {}
      return {
        seq,
        tokens: Number(data.shadowedTokenCount) || 0,
        count: Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : 0,
      }
    }
  }
  return null
}

async function statusText(ctx, invocation, opts, state) {
  const agent = invocation?.agent
  const session = agent?.session
  if (session === undefined) return 'No active session.'

  const header = session.requestHeader?.()
  if (header === undefined) {
    return 'This session has not routed a model request yet; context usage is not measurable.'
  }

  const target = header.config ?? {}
  const measurement = ctx.tokenMeter.measure(session)
  const used = Number(measurement?.totalTokens) || 0

  let window
  let defaultMaxTokens
  try {
    const info = await ctx.llm.resolveModelInfo(target.provider, target.model, invocation.signal)
    window = info?.context?.contextWindow
    defaultMaxTokens = info?.defaultMaxTokens
  } catch {
    window = undefined
  }

  const lines = [`Model: ${target.provider ?? '?'}/${target.model ?? '?'}`]
  if (Number.isFinite(window) && window > 0) {
    const percent = ((used / window) * 100).toFixed(1)
    lines.push(`Context: ${group(used)} / ${group(window)} tokens (${percent}%)`)
  } else {
    lines.push(`Context: ${group(used)} tokens (window size unavailable)`)
  }

  if (Number.isFinite(window) && window > 0) {
    const reserved = Number(header.config?.maxTokens) || Number(defaultMaxTokens) || 0
    const headroom = Number(opts.headroomTokens) || DEFAULTS.headroomTokens
    const byRatio = Math.floor(window * opts.thresholdRatio)
    const byBudget = window - reserved - headroom
    const threshold = byBudget > 0 ? Math.min(byRatio, byBudget) : byRatio
    const ratioLabel = `${Math.round(opts.thresholdRatio * 100)}%`
    lines.push(`Auto-compact at: ${ratioLabel} = ${group(threshold)} tokens`)
    if (used >= threshold) {
      lines.push('Status: over the threshold — the next step will compact.')
    } else {
      lines.push(`Remaining headroom: ${group(threshold - used)} tokens`)
    }
  }

  const last = lastCompaction(session)
  lines.push(
    last === null
      ? 'Last compaction: none in this session'
      : `Last compaction: seq ${last.seq}, ${group(last.count)} nodes, ~${group(last.tokens)} tokens shadowed`,
  )
  lines.push(`Anchors: ${opts.anchors.enabled === false ? 'off' : `on (${group(opts.anchors.budgetTokens)} tokens)`}`)
  lines.push(`Backend: ${ENGINE}`)
  lines.push(
    state.patchedPresets.size > 0
      ? `Preset overlay: applied (${[...state.patchedPresets].join(', ')})`
      : 'Preset overlay: NOT applied — check that caopazi-compact precedes @deepseek-ai/dsh-web-app in dsh.profile.bundles',
  )
  return lines.join('\n')
}

export function apply(ctx, config = {}) {
  const opts = normalizeOptions(config)
  trace('overlay-apply', { thresholdRatio: opts.thresholdRatio, retainRatio: opts.retainRatio })

  const biliActive = globalThis.__BILI_DSH_COMPACTION_VERDICT__ === 'active'
  const seen = new Set()
  const state = { patchedPresets: seen }
  if (biliActive && opts.takeover !== true) {
    ctx.logger?.warn?.('caopazi-compact: billion-context reports an active takeover; preset patch skipped (set takeover: true to override)')
  } else {
    ctx.on(
      'internal/config',
      (fiber, next) => {
        const resolved = next()
        const patched = patchPresetConfig(resolved, opts)
        if (patched === null) return resolved
        const preset = typeof resolved.id === 'string' ? resolved.id : 'preset'
        if (!seen.has(preset)) {
          seen.add(preset)
          trace('preset-patched', { preset, thresholdRatio: opts.thresholdRatio })
          ctx.logger?.info?.(`caopazi-compact: ${preset} -> compaction ${Math.round(opts.thresholdRatio * 100)}% + anchors`)
        }
        return patched
      },
      { global: true },
    )

    // Boot-time self-check: the hook is only useful if it runs before the
    // preset rows resolve. A silent no-op would look exactly like "70% never
    // triggers", so make the failure visible once.
    ctx.effect(() => {
      const timer = setTimeout(() => {
        if (seen.size === 0) {
          trace('self-check-failed')
          ctx.logger?.warn?.('caopazi-compact: loaded but no agent preset was patched; bundle order must put caopazi-compact before @deepseek-ai/dsh-web-app')
        }
      }, 15000)
      timer.unref?.()
      return () => clearTimeout(timer)
    }, 'caopazi-compact preset-overlay self-check')
  }

  // Publish the readiness gate AFTER the internal/config hook is registered.
  // Preset rows inject this service so they cannot resolve their plugin list
  // before the overlay exists. The fallback row releases them if this plugin
  // ever fails to apply, so a broken overlay cannot brick session creation.
  try {
    ctx.reflect?.provide?.('caopaziCompactReady', Object.freeze({ owner: 'caopazi-compact', ratio: opts.thresholdRatio }))
  } catch (error) {
    ctx.logger?.warn?.(`caopazi-compact: could not publish caopaziCompactReady (${error instanceof Error ? error.message : String(error)}); the fallback row will release presets`)
  }

  ctx.commands.register({
    name: 'compact-status',
    description: 'Show context usage, the auto-compaction threshold and the last reduction',
    async handler(invocation) {
      try {
        return { kind: 'success', text: await statusText(ctx, invocation, opts, state) }
      } catch (error) {
        return {
          kind: 'error',
          text: `compact-status failed: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  })
}
