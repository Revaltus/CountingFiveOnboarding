import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

// Haiku 5.5 thinks adaptively unless told not to, which slows every fast-tier
// helper and can eat a small maxOutputTokens cap before any answer is written.
// Every production file that calls FAST_MODEL must also pass the fast options.
const ROOT = join(__dirname, '..', '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(full)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : []
  })
}

describe('fast-tier provider options', () => {
  it('every file using FAST_MODEL also passes FAST_PROVIDER_OPTIONS / FAST_CHAT_PROVIDER_OPTIONS', () => {
    const offenders = [...sourceFiles(join(ROOT, 'lib')), ...sourceFiles(join(ROOT, 'app'))]
      .filter((f) => !f.endsWith('generation-tuning.ts'))
      .filter((f) => {
        const src = readFileSync(f, 'utf-8')
        return /\bFAST_MODEL\b/.test(src) && !/\bFAST_(CHAT_)?PROVIDER_OPTIONS\b/.test(src)
      })
    expect(offenders).toEqual([])
  })
})
