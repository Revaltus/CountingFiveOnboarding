// ---------------------------------------------------------------------------
// Image handling for the WordPress blog-sync bridge.
//
// Client repos are private, so a post's hero image (a bare filename resolving to
// public/content-assets/<file>) is not publicly fetchable. Instead of leaking a
// repo URL, the feed emits an authenticated PROXY url; the WP plugin fetches it
// with the same bearer secret, and the proxy route streams the bytes through the
// GitHub App. WordPress never holds a GitHub token.
// ---------------------------------------------------------------------------

import {
  FileNotFoundError,
  listTree,
  MAIN_BRANCH,
  readBlobBySha,
  type BinaryBlob,
} from '@/lib/github/repo-files'

// A hero image should never be this large; guard so a bad path can't pin memory.
export const MAX_ASSET_BYTES = 15 * 1024 * 1024

export class AssetTooLargeError extends Error {
  constructor(public path: string, public size: number) {
    super(`Asset too large: ${path}`)
    this.name = 'AssetTooLargeError'
  }
}

export type HeroImage = {
  url: string
  requires_auth: boolean // true → WP plugin must send the bearer header to fetch
  alt: string | null
  filename: string
  // Git blob sha of the repo file (null for external URLs). Lets the plugin
  // detect an image replaced in place under the same filename.
  sha: string | null
}

// Only these repo roots may be proxied. Hero images live under content-assets.
const ASSET_ROOTS = ['public/content-assets/', 'public/og-images/']

// Build the proxy URL the WP plugin fetches for a bare hero-image filename.
export function assetUrlFor(origin: string, siteKey: string, filename: string): string {
  const path = `public/content-assets/${filename}`
  return `${origin}/api/wp-feed/${encodeURIComponent(siteKey)}/asset?path=${encodeURIComponent(path)}`
}

// Decode-then-normalize before the allowlist check (CLAUDE.md security rule 8):
// an encoded `..%2F` traversal escapes the root only after decoding. Returns the
// normalized safe path, or null if it fails to decode / escapes / is off-root.
export function isAllowedAssetPath(rawPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    return null
  }
  const normalized = decoded.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (normalized.includes('..')) return null
  if (!ASSET_ROOTS.some((root) => normalized.startsWith(root))) return null
  return normalized
}

// Read image bytes from the published branch through the GitHub App. The size
// comes from the (ETag-cached) tree listing, so an oversized blob is refused
// BEFORE it is downloaded and buffered — the limit actually bounds memory.
export async function readRepoAsset(githubRepo: string, path: string): Promise<BinaryBlob> {
  const dir = path.slice(0, path.lastIndexOf('/') + 1)
  const entry = (await listTree(githubRepo, MAIN_BRANCH, dir)).find(
    (e) => e.type === 'blob' && e.path === path
  )
  if (!entry) throw new FileNotFoundError(path)
  if (typeof entry.size === 'number' && entry.size > MAX_ASSET_BYTES) {
    throw new AssetTooLargeError(path, entry.size)
  }
  const content = await readBlobBySha(githubRepo, entry.sha)
  if (content.byteLength > MAX_ASSET_BYTES) throw new AssetTooLargeError(path, content.byteLength)
  return { path, content, sha: entry.sha, size: content.byteLength }
}
