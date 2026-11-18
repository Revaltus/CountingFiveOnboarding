// ---------------------------------------------------------------------------
// Self-hosted update channel for the revaltus-blog-sync WordPress plugin.
//
// The plugin asks GET /api/wp-feed/<site>/plugin (bearer-authenticated, same
// secret as the feed) for the latest release, and WordPress shows its normal
// "new version available" notice. The release is whatever is committed in
// wordpress-plugin/: the version comes from the main file's header, the rest
// from readme.txt, and the package is the committed zip.
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises'
import path from 'node:path'

const PLUGIN_DIR = path.join(process.cwd(), 'wordpress-plugin')
export const PLUGIN_ZIP_PATH = path.join(PLUGIN_DIR, 'revaltus-blog-sync.zip')
const MAIN_FILE_PATH = path.join(PLUGIN_DIR, 'revaltus-blog-sync', 'revaltus-blog-sync.php')
const README_PATH = path.join(PLUGIN_DIR, 'revaltus-blog-sync', 'readme.txt')

export type ChangelogEntry = { version: string; notes: string[] }

export type PluginRelease = {
  version: string
  requires: string | null
  tested: string | null
  requires_php: string | null
  changelog: ChangelogEntry[]
}

export interface PluginInfoResponse extends PluginRelease {
  slug: 'revaltus-blog-sync'
  name: string
  download_url: string
}

function headerValue(text: string, label: string): string | null {
  const re = new RegExp(`^[ \\t/*#@]*${label}:[ \\t]*(.+?)[ \\t]*$`, 'mi')
  return text.match(re)?.[1] ?? null
}

// `= 1.3.0 =` headings with `* ` notes; continuation lines join the note above.
export function parseChangelog(readme: string): ChangelogEntry[] {
  const start = readme.search(/^==\s*Changelog\s*==\s*$/m)
  if (start === -1) return []
  const section = readme.slice(start).split('\n').slice(1)
  const entries: ChangelogEntry[] = []
  for (const raw of section) {
    const line = raw.trimEnd()
    if (/^==[^=]/.test(line)) break
    const heading = line.match(/^=\s*([^=]+?)\s*=$/)
    if (heading) {
      entries.push({ version: heading[1], notes: [] })
      continue
    }
    const current = entries[entries.length - 1]
    if (!current || line.trim() === '') continue
    const bullet = line.match(/^\*\s+(.*)$/)
    if (bullet) current.notes.push(bullet[1].trim())
    else if (current.notes.length > 0) {
      current.notes[current.notes.length - 1] += ' ' + line.trim()
    }
  }
  return entries
}

export function parseRelease(mainFile: string, readme: string): PluginRelease {
  const version = headerValue(mainFile, 'Version')
  if (!version) throw new Error('Plugin main file has no Version header')
  return {
    version,
    requires: headerValue(readme, 'Requires at least'),
    tested: headerValue(readme, 'Tested up to'),
    requires_php: headerValue(readme, 'Requires PHP'),
    changelog: parseChangelog(readme).slice(0, 5),
  }
}

export async function readPluginRelease(): Promise<PluginRelease> {
  const [mainFile, readme] = await Promise.all([
    readFile(MAIN_FILE_PATH, 'utf8'),
    readFile(README_PATH, 'utf8'),
  ])
  return parseRelease(mainFile, readme)
}

export function pluginDownloadUrl(origin: string, siteKey: string): string {
  return `${origin}/api/wp-feed/${encodeURIComponent(siteKey)}/plugin/download`
}
