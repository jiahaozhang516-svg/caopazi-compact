/**
 * Lightweight file-based diagnostics.
 *
 * The host logger is not persisted anywhere readable, so a failed automatic
 * compaction otherwise leaves no trace. Each compaction-critical event appends
 * one line to `$DSH_HOME/caopazi-compact-debug.log`; ordinary steps are not
 * logged, so the file stays small.
 */

import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const home = process.env.DSH_HOME ?? join(here, '../../../..')

export const DEBUG_FILE = join(home, 'caopazi-compact-debug.log')

export function trace(event, detail) {
  try {
    const payload = detail === undefined ? '' : ` ${JSON.stringify(detail)}`
    appendFileSync(DEBUG_FILE, `${new Date().toISOString()} ${event}${payload}\n`)
  } catch {
    // diagnostics must never break the turn
  }
}
