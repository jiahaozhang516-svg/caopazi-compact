/**
 * Anchor wrapper for the stock compaction engine.
 *
 * Mounted as a sibling of `compaction-basic` inside each agent preset's
 * isolated `compaction` group. It does not replace the engine and does not
 * ask the summarizer to preserve anything extra: the model writes its normal
 * summary, then this wrapper appends the mechanically extracted anchor block
 * to the returned summary. The checkpoint therefore contains the anchors even
 * when the summarizer ignores them or treats them as noise.
 *
 * The wrapper does not modify the summarization input, so the provider's KV
 * cache and the stock prompt stay untouched.
 */

import { buildAnchors } from './anchors.js'
import { trace } from './debug.js'

export const name = 'caopazi-compact-anchors'
export const inject = ['compaction']

const PATCHED = Symbol.for('caopazi-compact.summarize-patched')

function log(ctx, level, message) {
  const logger = ctx?.logger
  if (logger && typeof logger[level] === 'function') logger[level](message)
}

/** Append one text block carrying the anchors; returns the original array when empty. */
export function appendAnchorsToSummary(summary, anchorText) {
  if (!Array.isArray(summary) || anchorText === '') return summary
  return [...summary, { type: 'text', text: `\n\n${anchorText}` }]
}

export function apply(ctx, config = {}) {
  const engine = ctx.compaction
  if (engine === undefined || typeof engine.summarize !== 'function') {
    log(ctx, 'warn', 'caopazi-compact: ctx.compaction has no summarize() hook; anchors disabled')
    return
  }
  if (engine[PATCHED] === true) return

  const anchors = config.anchors ?? {}
  trace('augment-apply', { enabled: anchors.enabled !== false })
  const original = engine.summarize.bind(engine)

  try {
    engine.summarize = async function summarizeWithAnchors(input, agent, signal) {
      trace('summarize-enter', { messages: Array.isArray(input?.messages) ? input.messages.length : null })
      const result = await original(input, agent, signal)
      trace('summary-returned', { blocks: Array.isArray(result?.summary) ? result.summary.length : null })
      try {
        const anchorText = buildAnchors(input?.messages, anchors)
        if (anchorText === '') return result
        const summary = appendAnchorsToSummary(result?.summary, anchorText)
        if (summary === result?.summary) return result
        trace('anchors-appended', { chars: anchorText.length })
        log(ctx, 'info', `caopazi-compact: appended ${anchorText.length} chars of anchors to the checkpoint`)
        return { ...result, summary }
      } catch (error) {
        trace('anchors-append-error', { message: error instanceof Error ? error.message : String(error) })
        log(ctx, 'warn', `caopazi-compact: anchor extraction failed (${error instanceof Error ? error.message : String(error)}); keeping the stock summary`)
        return result
      }
    }
    engine[PATCHED] = true
    trace('augment-patched')
  } catch (error) {
    trace('augment-failed', { message: error instanceof Error ? error.message : String(error) })
    log(ctx, 'warn', `caopazi-compact: cannot wrap summarize (${error instanceof Error ? error.message : String(error)}); anchors disabled`)
  }
}
