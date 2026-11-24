import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Test fixtures own these homes. Restore directory write permissions before teardown.
export function makeSkillFixtureWritable(home) {
  function visit(path) {
    chmodSync(path, 0o700)
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(join(path, entry.name))
    }
  }
  for (const entry of existsSync(home) ? readdirSync(home, { withFileTypes: true }) : []) {
    if (entry.isDirectory() && (entry.name === 'skills' || entry.name.startsWith('skills.pre-import-'))) {
      visit(join(home, entry.name))
    }
  }
}
