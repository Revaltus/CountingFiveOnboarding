import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseChangelog, parseRelease, PLUGIN_ZIP_PATH, readPluginRelease } from './plugin-release'

const README = [
  '=== Revaltus Blog Sync ===',
  'Requires at least: 5.8',
  'Tested up to: 6.6',
  'Requires PHP: 7.4',
  '',
  '== Changelog ==',
  '',
  '= 1.3.0 =',
  '* Body images sync;',
  '  replaced images are detected.',
  '* Second note.',
  '',
  '= 1.2.0 =',
  '* Older.',
  '',
  '== Something else ==',
  '* not a note',
].join('\n')

describe('parseChangelog', () => {
  it('groups notes by version and joins wrapped lines', () => {
    expect(parseChangelog(README)).toEqual([
      { version: '1.3.0', notes: ['Body images sync; replaced images are detected.', 'Second note.'] },
      { version: '1.2.0', notes: ['Older.'] },
    ])
  })
})

describe('parseRelease', () => {
  it('reads the version from the main file and requirements from the readme', () => {
    const main = '<?php\n/**\n * Plugin Name: X\n * Version:     1.3.0\n */'
    expect(parseRelease(main, README)).toMatchObject({
      version: '1.3.0',
      requires: '5.8',
      tested: '6.6',
      requires_php: '7.4',
    })
  })

  it('throws without a Version header', () => {
    expect(() => parseRelease('<?php', README)).toThrow()
  })
})

describe('committed plugin release', () => {
  it('has matching versions in the header, constant, readme and changelog', async () => {
    const release = await readPluginRelease()
    const main = readFileSync(path.join(process.cwd(), 'wordpress-plugin/revaltus-blog-sync/revaltus-blog-sync.php'), 'utf8')
    const readme = readFileSync(path.join(process.cwd(), 'wordpress-plugin/revaltus-blog-sync/readme.txt'), 'utf8')
    expect(main).toContain(`define( 'RV_BLOG_SYNC_VERSION', '${release.version}' );`)
    expect(readme).toMatch(new RegExp(`^Stable tag: ${release.version.replace(/\./g, '\\.')}$`, 'm'))
    expect(release.changelog[0]?.version).toBe(release.version)
  })

  // The update package is the committed zip — it must be rebuilt with every release.
  it('ships a zip whose main file matches the source', () => {
    let zipped: string
    try {
      zipped = execFileSync('unzip', ['-p', PLUGIN_ZIP_PATH, 'revaltus-blog-sync/revaltus-blog-sync.php'], {
        encoding: 'utf8',
      })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return // no unzip binary here
      throw err
    }
    const source = readFileSync(path.join(process.cwd(), 'wordpress-plugin/revaltus-blog-sync/revaltus-blog-sync.php'), 'utf8')
    expect(zipped).toBe(source)
  })
})
