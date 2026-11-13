import test from 'node:test'
import assert from 'node:assert/strict'

import { patchPresetConfig, ENGINE, AUGMENT } from '../patch.js'
import { normalizeOptions } from '../index.js'

const opts = normalizeOptions({ thresholdRatio: 0.7, retainRatio: 0.15 })

function preset() {
  return {
    id: 'standard',
    order: 1,
    plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona' },
      {
        id: 'compaction',
        name: 'cordis:group',
        group: true,
        isolate: { compaction: true, toolResultPruner: true },
        config: [
          { id: 'compaction-basic', name: ENGINE },
          { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        ],
      },
    ],
  }
}

test('tunes the nested engine row and mounts the anchor wrapper beside it', () => {
  const patched = patchPresetConfig(preset(), opts)
  assert.notEqual(patched, null)

  const group = patched.plugins.find((row) => row.id === 'compaction')
  const engineIndex = group.config.findIndex((row) => row.name === ENGINE)
  const engine = group.config[engineIndex]

  assert.notEqual(engine.disabled, true)
  assert.equal(engine.config.auto, true)
  assert.equal(engine.config.thresholdRatio, 0.7)
  assert.equal(engine.config.retainRatio, 0.15)
  assert.equal(group.config[engineIndex + 1].name, AUGMENT)
  assert.equal(group.config[engineIndex + 1].config.anchors.enabled, true)
})

test('re-enables a row disabled by another overlay', () => {
  const input = preset()
  const engine = input.plugins.find((row) => row.id === 'compaction').config[0]
  engine.disabled = true
  engine.config = { auto: false }

  const patched = patchPresetConfig(input, opts)
  const tuned = patched.plugins.find((row) => row.id === 'compaction').config[0]
  assert.equal(tuned.disabled, false)
  assert.equal(tuned.config.auto, true)
  assert.equal(tuned.config.thresholdRatio, 0.7)
})

test('is idempotent', () => {
  const first = patchPresetConfig(preset(), opts)
  const second = patchPresetConfig(first, opts)
  assert.equal(second, null)
})

test('leaves non-preset configs alone', () => {
  assert.equal(patchPresetConfig({}, opts), null)
  assert.equal(patchPresetConfig({ plugins: [{ id: 'x', name: 'y' }] }, opts), null)
  assert.equal(patchPresetConfig(undefined, opts), null)
})

test('keeps forwarded stock knobs', () => {
  const withModel = normalizeOptions({
    thresholdRatio: 0.7,
    summarizationModel: 'glm-5.3-flash',
    summarizationProvider: 'ai-hub',
  })
  const patched = patchPresetConfig(preset(), withModel)
  const engine = patched.plugins.find((row) => row.id === 'compaction').config[0]
  assert.equal(engine.config.summarizationModel, 'glm-5.3-flash')
  assert.equal(engine.config.summarizationProvider, 'ai-hub')
})

test('falls back on invalid ratios', () => {
  const normalized = normalizeOptions({ thresholdRatio: 2, retainRatio: 5 })
  assert.equal(normalized.thresholdRatio, 0.7)
  assert.ok(normalized.retainRatio < normalized.thresholdRatio)
})
