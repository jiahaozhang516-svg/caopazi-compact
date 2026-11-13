/**
 * Pure preset-patch helpers for caopazi-compact.
 *
 * The running compaction engine lives inside each agent preset's isolated
 * `compaction` group, where a profile patch cannot address rows by id. This
 * module rewrites the preset definition at config-resolution time instead:
 * it tunes the stock `compaction-basic` row and mounts the anchor wrapper as
 * its sibling in the same group.
 *
 * No engine code is replaced here; `compaction-basic` stays the single
 * `ctx.compaction` provider.
 */

export const ENGINE = '@deepseek-ai/dsh-compaction-basic'
export const AUGMENT = 'caopazi-compact/augment'
export const AUGMENT_ID = 'caopazi-compact-anchors'

/** Stock policy keys this plugin forwards unchanged to the engine row. */
const FORWARDED_KEYS = [
  'headroomTokens',
  'retainTokens',
  'maxTokens',
  'compactionRetries',
  'maxOverflowRetries',
  'summarizationProvider',
  'summarizationModel',
  'modelPolicies',
]

/** Build the engine row config: our policy plus any forwarded stock knobs. */
export function engineRowConfig(existing, opts) {
  const next = { ...(existing ?? {}) }
  next.auto = true
  next.thresholdRatio = opts.thresholdRatio
  next.retainRatio = opts.retainRatio
  for (const key of FORWARDED_KEYS) {
    if (opts[key] !== undefined) next[key] = opts[key]
  }
  return next
}

/** Build the anchor wrapper row mounted beside the engine. */
export function augmentRow(opts) {
  return {
    id: AUGMENT_ID,
    name: AUGMENT,
    config: { anchors: opts.anchors },
  }
}

function sameJson(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

function walk(rows, opts, state) {
  const hasAugment = rows.some((row) => row && row.name === AUGMENT)
  let changed = false
  const out = []

  for (const row of rows) {
    let next = row

    if (next && next.group === true && Array.isArray(next.config)) {
      const nested = walk(next.config, opts, state)
      if (nested !== next.config) {
        next = { ...next, config: nested }
        changed = true
      }
    }

    if (next && next.name === ENGINE) {
      state.found = true
      const desired = engineRowConfig(next.config, opts)
      if (next.disabled === true || !sameJson(next.config, desired)) {
        next = { ...next, disabled: false, config: desired }
        changed = true
      }
      out.push(next)
      if (!hasAugment) {
        out.push(augmentRow(opts))
        changed = true
      }
      continue
    }

    if (next && next.name === AUGMENT) {
      const desired = augmentRow(opts)
      if (!sameJson(next.config, desired.config)) {
        next = { ...next, config: desired.config }
        changed = true
      }
    }

    out.push(next)
  }

  return changed ? out : rows
}

/**
 * Rewrite one resolved preset config.
 *
 * @param config - resolved config of a candidate fiber.
 * @param opts - normalized plugin options.
 * @returns a patched shallow copy, or `null` when this fiber is not a preset
 *          carrying `compaction-basic`.
 */
export function patchPresetConfig(config, opts) {
  if (config === null || typeof config !== 'object') return null
  if (!Array.isArray(config.plugins)) return null

  const state = { found: false }
  const plugins = walk(config.plugins, opts, state)
  if (!state.found) return null
  if (plugins === config.plugins) return null
  return { ...config, plugins }
}
