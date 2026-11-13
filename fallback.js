/**
 * Safety valve for the `caopaziCompactReady` gate.
 *
 * Preset rows inject `caopaziCompactReady`, so the overlay in index.js must
 * publish that service before any preset resolves its plugin list. If this
 * plugin ever fails to load or throws during apply, the presets would wait
 * forever and session creation would look bricked. This row waits a few
 * seconds and releases the gate itself, leaving the stock 80% compaction in
 * place. It never patches anything.
 */

import { trace } from './debug.js'

export const name = 'caopazi-compact-fallback'
// Start the timer only once the base services exist, so a slow boot cannot
// release the gate before the overlay has had a chance to apply.
export const inject = ['commands', 'tokenMeter', 'llm']

export function apply(ctx) {
  const timer = setTimeout(() => {
    try {
      if (ctx.get('caopaziCompactReady') !== undefined) return
      ctx.reflect?.provide?.('caopaziCompactReady', Object.freeze({ owner: 'caopazi-compact', fallback: true }))
      trace('fallback-fired')
      ctx.logger?.warn?.('caopazi-compact: primary overlay did not publish caopaziCompactReady; presets released by the fallback row (stock compaction stays active)')
    } catch (error) {
      ctx.logger?.error?.(`caopazi-compact: fallback could not release caopaziCompactReady: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, 15000)
  timer.unref?.()
  ctx.effect(() => () => clearTimeout(timer), 'caopazi-compact fallback timer')
}
