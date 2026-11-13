/**
 * Deterministic "must-preserve" anchors for a compaction span.
 *
 * `compaction-basic` already asks the summarizer to keep goals, constraints,
 * paths and pending work. A small flash model still drops them occasionally,
 * so this module extracts the load-bearing facts mechanically. `augment.js`
 * appends the result to the produced summary block, so survival does not
 * depend on the model obeying an instruction.
 * Nothing here calls a model; the output is bounded and deterministic.
 */

const DEFAULT_BUDGET_TOKENS = 1500
const MIN_BUDGET_TOKENS = 200
const MAX_BUDGET_TOKENS = 6000

const REQUIREMENT = /(必须|务必|不要|不能|禁止|记住|约定|以后|每次|永远|只能|一定要|记得|别忘|硬性|要求是|must\b|never\b|always\b|do not\b|don't\b|required\b)/i
const OPEN_WORK = /(待办|下一步|还没|未完成|待定|回头|稍后|剩下|继续做|todo\b|next step|pending\b|follow[- ]up)/i
const PATH_POSIX = /(?:^|[\s"'`(:=])((?:~|\.{1,2})?\/[A-Za-z0-9._~/-]{2,160})/g
const PATH_FILE = /\b([A-Za-z0-9_.-]+\.(?:ts|tsx|js|mjs|cjs|json|ya?ml|md|py|sh|toml|lock|txt))\b/g
const ERROR_CODE = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,4})\b/g
const URL_RE = /\bhttps?:\/\/[^\s"'`)]{4,160}/g
const INLINE_CODE = /`([^`\n]{2,120})`/g

/** Concatenate the text blocks of one projected message. */
export function messageText(message) {
  if (message === null || typeof message !== 'object') return ''
  const { content } = message
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

function isHumanUser(message) {
  if (message?.role !== 'user') return false
  const source = message.source
  if (source && typeof source === 'object' && typeof source.callId === 'string') return false
  // Only the human's own messages count. Injected user-role traffic
  // (`runtime-context`, `system-prompt`, skills, action cards, checkpoints)
  // reads as user text but is not something the user typed, and treating it
  // as the "first user message" buries the real request under timestamps and
  // workspace instructions.
  if (source && typeof source === 'object' && typeof source.kind === 'string' && source.kind !== 'user') {
    return false
  }
  return true
}

function isCheckpoint(message) {
  return message?.role === 'user' && message?.source?.kind === 'compact-checkpoint'
}

function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function pushUnique(target, seen, value, max) {
  const text = clip(value, max)
  if (text === '' || seen.has(text)) return
  seen.add(text)
  target.push(text)
}

function requirementLines(text, out, seen) {
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.length < 4 || line.length > 400) continue
    if (!REQUIREMENT.test(line)) continue
    pushUnique(out, seen, line.replace(/^[-*]\s+/, ''), 280)
  }
}

function openWorkLines(text, out, seen) {
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.length < 4 || line.length > 400) continue
    if (!OPEN_WORK.test(line)) continue
    pushUnique(out, seen, line.replace(/^[-*]\s+/, ''), 280)
  }
}

function artifacts(text, out, seen) {
  for (const re of [PATH_POSIX, PATH_FILE, ERROR_CODE, URL_RE]) {
    re.lastIndex = 0
    for (const match of text.matchAll(re)) {
      const value = (match[1] ?? match[0]).trim()
      if (value.length < 3) continue
      if (/^[\d./-]+$/.test(value)) continue
      pushUnique(out, seen, value.replace(/[.,;:]+$/, ''), 160)
    }
  }
  INLINE_CODE.lastIndex = 0
  for (const match of text.matchAll(INLINE_CODE)) {
    const value = match[1].trim()
    if (value.length < 4) continue
    pushUnique(out, seen, `\`${value}\``, 160)
  }
}

function priorCheckpointLines(text, out, seen) {
  const match = /<compacted-summary>([\s\S]*?)<\/compacted-summary>/.exec(text)
  if (match === null) return
  const wanted = /^##\s+(Primary Request|Pending Jobs|Critical Context|Next Step)/i
  let active = false
  for (const raw of match[1].split('\n')) {
    const line = raw.trim()
    if (/^##\s+/.test(line)) {
      active = wanted.test(line)
      continue
    }
    if (!active || !/^[-*]\s+/.test(line)) continue
    if (/^[-*]\s+\(none\)$/i.test(line)) continue
    pushUnique(out, seen, line.replace(/^[-*]\s+/, ''), 260)
  }

  // Carry forward the previous checkpoint's own anchor appendix, so exact
  // identifiers survive any number of successive compactions.
  const anchorStart = match[1].indexOf('[MUST-PRESERVE ANCHORS]')
  if (anchorStart < 0) return
  for (const raw of match[1].slice(anchorStart).split('\n')) {
    const line = raw.trim()
    if (!/^[-*]\s+/.test(line)) continue
    if (/^[-*]\s+\(none\)$/i.test(line)) continue
    pushUnique(out, seen, line.replace(/^[-*]\s+/, ''), 260)
  }
}

function render(title, items) {
  if (items.length === 0) return ''
  return `### ${title}\n${items.map((item) => `- ${item}`).join('\n')}`
}

/**
 * Build the anchor block for one summarization input.
 *
 * @param messages - replayed messages handed to `summarize()`.
 * @param options - `{ enabled, budgetTokens }`.
 * @returns markdown text, or `''` when there is nothing worth anchoring.
 */
export function buildAnchors(messages, options = {}) {
  if (options.enabled === false) return ''
  if (!Array.isArray(messages) || messages.length === 0) return ''

  const requested = Number(options.budgetTokens)
  const budgetTokens = Number.isFinite(requested)
    ? Math.min(MAX_BUDGET_TOKENS, Math.max(MIN_BUDGET_TOKENS, Math.floor(requested)))
    : DEFAULT_BUDGET_TOKENS
  const maxChars = Math.floor(budgetTokens * 3)

  const original = []
  const requirements = []
  const openWork = []
  const paths = []
  const prior = []
  const seenOriginal = new Set()
  const seenRequirements = new Set()
  const seenOpen = new Set()
  const seenPaths = new Set()
  const seenPrior = new Set()

  for (const message of messages) {
    const text = messageText(message)
    if (text === '') continue

    if (isCheckpoint(message)) {
      priorCheckpointLines(text, prior, seenPrior)
      // The checkpoint's original-request section is already carried above.
      continue
    }

    if (!isHumanUser(message)) continue
    if (original.length === 0) pushUnique(original, seenOriginal, text, 1800)
    requirementLines(text, requirements, seenRequirements)
    openWorkLines(text, openWork, seenOpen)
    artifacts(text, paths, seenPaths)
  }

  const sections = [
    render('Original task (first user message, verbatim)', original.slice(0, 1)),
    render('User requirements and constraints (verbatim lines)', requirements.slice(0, 24)),
    render('Open work', openWork.slice(0, 12)),
    render('Paths, commands and error codes', paths.slice(0, 24)),
    render('Carried from the previous checkpoint', prior.slice(0, 16)),
  ].filter((section) => section !== '')

  if (sections.length === 0) return ''

  const header = [
    '[MUST-PRESERVE ANCHORS]',
    'Mechanically extracted from the compacted span and carried over verbatim;',
    'exact identifiers and quoted user wording are kept as-is.',
    '',
  ].join('\n')

  let body = `${header}${sections.join('\n\n')}`
  if (body.length > maxChars) body = `${body.slice(0, maxChars - 1)}…`
  return body
}
