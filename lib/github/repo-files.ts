import { RequestError } from '@octokit/request-error'
import { getOctokit, resolveRepo } from './app-client'
import { withRateLimitRetry } from './rate-limit'
import { conditionalGet } from './conditional'
import { DEPLOY_COMMIT_PREFIX, DEPLOY_MANIFEST_PATH } from './deploy-commit'
import type { BrandJson } from '@/types/brand-json'

// How many blobs to upload at once when pushing a deliverable. Kept low so a
// ~300-file content push doesn't trip GitHub's secondary rate limit; each call
// also retries on a throttle. Mirrors the template seeder.
const PUSH_BLOB_CONCURRENCY = 4

export const DRAFT_BRANCH = 'draft'
export const MAIN_BRANCH = 'main'

export type TreeEntry = {
  path: string
  sha: string
  type: 'blob' | 'tree'
  size?: number
}

export type BinaryBlob = {
  path: string
  content: Buffer
  sha: string
  size: number
}

// Image file extensions surfaced in the asset/media UI. SVG is listed so
// existing ones render, but uploads of SVG are rejected upstream (no magic
// bytes to validate; stored-XSS risk).
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|svg)$/i

export type FileBlob = {
  path: string
  content: string
  sha: string
}

export class FileNotFoundError extends Error {
  constructor(path: string) {
    super(`File not found: ${path}`)
    this.name = 'FileNotFoundError'
  }
}

export class StaleShaError extends Error {
  constructor(
    public path: string,
    public currentSha: string,
    public currentContent: string
  ) {
    super(`File changed remotely: ${path}`)
    this.name = 'StaleShaError'
  }
}

export class AssetExistsError extends Error {
  constructor(public path: string) {
    super(`Asset already exists: ${path}`)
    this.name = 'AssetExistsError'
  }
}

function isRequestError(err: unknown): err is RequestError {
  return err instanceof RequestError
}

// Branch-existence memo per (repo, branch). A branch, once created, is never
// deleted by this app, so a short in-process TTL skips a getRef on nearly every
// editor request without risking much if someone deletes it by hand.
const BRANCH_EXISTS_TTL_MS = 5 * 60_000
const branchExists = new Map<string, number>()

function isRefAlreadyExists(err: unknown): boolean {
  return isRequestError(err) && err.status === 422 && /already exists/i.test(err.message)
}

async function ensureBranch(
  slug: string,
  branch: string,
  fromBranch: string
): Promise<void> {
  const octokit = getOctokit()
  const { owner, repo } = resolveRepo(slug)
  const key = `${owner}/${repo}:${branch}`
  const until = branchExists.get(key)
  if (until !== undefined && until > Date.now()) return
  try {
    await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` })
    branchExists.set(key, Date.now() + BRANCH_EXISTS_TTL_MS)
    return
  } catch (err) {
    if (!isRequestError(err) || err.status !== 404) throw err
  }
  const base = await octokit.git.getRef({ owner, repo, ref: `heads/${fromBranch}` })
  try {
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha: base.data.object.sha,
    })
  } catch (err) {
    // Two requests raced to create the branch — the other one won, which is
    // exactly the outcome we wanted.
    if (!isRefAlreadyExists(err)) throw err
  }
  branchExists.set(key, Date.now() + BRANCH_EXISTS_TTL_MS)
}

// Test hook: forget memoized branch existence.
export function __resetBranchMemoForTests(): void {
  branchExists.clear()
}

// Ensure the long-lived draft branch exists, branching from main if missing.
export async function ensureDraftBranch(slug: string): Promise<void> {
  await ensureBranch(slug, DRAFT_BRANCH, MAIN_BRANCH)
}

// GitHub rejects a ref update whose new commit isn't a descendant of the current
// tip: "Update is not a fast forward". Every commit helper here is a
// read-modify-write — read the branch tip, build a tree + commit on it, update
// the ref — so any concurrent writer that lands between the read and the update
// causes this. It is a race, not a real conflict: retrying re-reads the new tip
// and rebuilds the commit on top of it.
//
// It must NEVER be "fixed" with force:true, which would silently discard the
// other writer's commit. (Seen in production: a library article draft lost to
// "Update is not a fast forward" and left permanently errored.)
function isNonFastForward(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  if (/not a fast forward/i.test(msg)) return true
  const status = (err as { status?: number } | null)?.status
  return status === 422 && /reference|ref/i.test(msg)
}

async function withRefRaceRetry<T>(label: string, attempt: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown
  for (let i = 1; i <= attempts; i++) {
    try {
      return await attempt()
    } catch (err) {
      if (!isNonFastForward(err) || i === attempts) throw err
      lastErr = err
      // Small jittered backoff so two racing writers don't lock-step retry.
      const delay = 250 * i + Math.floor(Math.random() * 200)
      console.warn(`[github] ${label}: ref moved under us (attempt ${i}/${attempts}) — rebuilding on the new tip in ${delay}ms`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw lastErr
}

// Blob sha of `path` as of a specific commit (not a moving branch), or null when
// absent. Used to validate optimistic locks against the exact base tree a commit
// is being built on, so the check and the ref update can't be separated by a
// concurrent writer (the non-fast-forward retry re-validates on the new tip).
async function blobShaAt(slug: string, path: string, commitSha: string): Promise<string | null> {
  return currentSha(slug, path, commitSha)
}

type TreeWrite = { path: string; sha: string | null }

// Build one commit on `branch` from a set of tree writes (sha: null = delete),
// re-reading the tip on every attempt so a concurrent commit is rebased onto
// rather than clobbered. `validate` runs against each attempt's base commit —
// throw from it (StaleShaError etc.) to abort before anything is committed.
async function commitTreeWrites(
  slug: string,
  branch: string,
  label: string,
  writes: TreeWrite[],
  message: string,
  options: { authorName?: string; authorEmail?: string },
  validate?: (baseCommitSha: string) => Promise<void>
): Promise<string> {
  const octokit = getOctokit()
  const { owner, repo } = resolveRepo(slug)
  return withRefRaceRetry(label, async () => {
    const ref = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` })
    const baseCommitSha = ref.data.object.sha
    const baseCommit = await octokit.git.getCommit({ owner, repo, commit_sha: baseCommitSha })
    if (validate) await validate(baseCommitSha)

    // Explicit literal types for mode/type — Octokit's overloaded createTree
    // signature defeats `Parameters<...>['tree']` index access.
    const tree: { path: string; mode: '100644'; type: 'blob'; sha: string | null }[] = writes.map(
      (w) => ({ path: w.path, mode: '100644', type: 'blob', sha: w.sha })
    )
    const newTree = await withRateLimitRetry(() =>
      octokit.git.createTree({ owner, repo, base_tree: baseCommit.data.tree.sha, tree })
    )
    const commit = await withRateLimitRetry(() =>
      octokit.git.createCommit({
        owner,
        repo,
        message,
        tree: newTree.data.sha,
        parents: [baseCommitSha],
        ...(options.authorName && options.authorEmail
          ? { author: { name: options.authorName, email: options.authorEmail } }
          : {}),
      })
    )
    await withRateLimitRetry(() =>
      octokit.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit.data.sha })
    )
    return commit.data.sha
  })
}

// Throw StaleShaError when `path`'s blob at `baseCommitSha` isn't `expected`
// (null = must be absent). Includes the current text when asked, for conflict UIs.
async function assertBlobSha(
  slug: string,
  path: string,
  expected: string | null,
  baseCommitSha: string,
  withContent: boolean
): Promise<void> {
  const current = await blobShaAt(slug, path, baseCommitSha)
  if (current === expected) return
  let content = ''
  if (withContent && current !== null) {
    try {
      content = (await readFile(slug, path, baseCommitSha)).content
    } catch {
      // Content is a UI nicety — the sha mismatch is what matters.
    }
  }
  throw new StaleShaError(path, current ?? '', content)
}

// Upload blobs once (bounded concurrency, rate-limit aware), returning path→sha.
// Done BEFORE any ref-race retry loop so a retry never re-uploads.
async function createBlobs(
  slug: string,
  entries: { path: string; content: string | Buffer }[]
): Promise<TreeWrite[]> {
  const octokit = getOctokit()
  const { owner, repo } = resolveRepo(slug)
  const out: TreeWrite[] = []
  for (let i = 0; i < entries.length; i += PUSH_BLOB_CONCURRENCY) {
    const batch = entries.slice(i, i + PUSH_BLOB_CONCURRENCY)
    const created = await Promise.all(
      batch.map(async (e) => {
        const buf = typeof e.content === 'string' ? Buffer.from(e.content, 'utf-8') : e.content
        const blob = await withRateLimitRetry(() =>
          octokit.git.createBlob({ owner, repo, content: buf.toString('base64'), encoding: 'base64' })
        )
        return { path: e.path, sha: blob.data.sha }
      })
    )
    out.push(...created)
  }
  return out
}

// Above this many guarded entries, pushEntriesToBranch validates against one
// recursive tree read of the base commit rather than a getContent per path.
const GUARD_TREE_THRESHOLD = 8

export type PushEntry = {
  path: string
  content: string | Buffer
  /** Optimistic lock: the blob sha the caller read this file at. `null` means
   *  "must not exist yet". Omit for an unguarded overwrite. Validated against
   *  the base tree of every commit attempt → StaleShaError on mismatch. */
  expectedBlobSha?: string | null
}

// Overlay a set of files onto a branch in one atomic commit via the Git Data
// API. base_tree is the branch's current tree, so files NOT in `entries` are
// preserved (the client repo's app code stays put; only the deliverable's
// content/ + public/ paths are added or updated). base64 blobs handle text and
// binary (images) uniformly.
export async function pushEntriesToBranch(
  slug: string,
  branch: string,
  entries: PushEntry[],
  message: string,
  options: { authorName?: string; authorEmail?: string } = {}
): Promise<{ commitSha: string; fileCount: number }> {
  const writes = await createBlobs(slug, entries)
  const guarded = entries.filter((e) => e.expectedBlobSha !== undefined)
  const commitSha = await commitTreeWrites(
    slug,
    branch,
    `pushEntriesToBranch ${slug}#${branch}`,
    writes,
    message,
    options,
    guarded.length === 0
      ? undefined
      : async (base) => {
          // A re-deployed package guards hundreds of entries: read the base
          // tree once instead of one getContent per path. The per-path check
          // still runs for a mismatch, so the error carries the current text.
          if (guarded.length > GUARD_TREE_THRESHOLD) {
            const shas = new Map((await listTreeAtCommit(slug, base)).map((t) => [t.path, t.sha]))
            for (const e of guarded) {
              if ((shas.get(e.path) ?? null) === (e.expectedBlobSha ?? null)) continue
              await assertBlobSha(slug, e.path, e.expectedBlobSha ?? null, base, true)
            }
            return
          }
          for (const e of guarded) {
            await assertBlobSha(slug, e.path, e.expectedBlobSha ?? null, base, true)
          }
        }
  )
  return { commitSha, fileCount: writes.length }
}

// Commit several text files to a branch in ONE atomic commit, with optional
// per-file optimistic locking. Used by the theme editor, where a single change
// touches 2–3 coupled files (brand.json + regenerated theme.css, or design.json
// + theme.css) that must never land half-applied. Each file may carry an
// expectedSha; if the blob sha in the commit's base tree differs (a concurrent
// edit), we throw StaleShaError before committing anything — re-checked on every
// ref-race retry. `expectedSha: null` means the file must NOT exist yet (a
// concurrent creation → StaleShaError). Returns the new commit sha plus each
// written path's new blob sha so a caller can advance its working shas.
export async function writeFiles(
  slug: string,
  files: { path: string; content: string; expectedSha?: string | null }[],
  branch: string,
  message: string,
  options: { authorName?: string; authorEmail?: string } = {}
): Promise<{ commitSha: string; blobs: Record<string, string> }> {
  if (files.length === 0) throw new Error('writeFiles called with no files')
  const writes = await createBlobs(slug, files)
  const blobs: Record<string, string> = {}
  for (const w of writes) if (w.sha) blobs[w.path] = w.sha
  const commitSha = await commitTreeWrites(
    slug,
    branch,
    `writeFiles ${slug}#${branch}`,
    writes,
    message,
    options,
    async (base) => {
      for (const f of files) {
        if (f.expectedSha === undefined) continue
        await assertBlobSha(slug, f.path, f.expectedSha, base, true)
      }
    }
  )
  return { commitSha, blobs }
}

// Full recursive tree per (repo, branch), memoized by the branch's commit sha so
// an unchanged branch skips the getCommit + getTree calls entirely. Bounded by
// the number of distinct repos/branches touched by a warm instance.
const treeCache = new Map<string, { sha: string; entries: TreeEntry[] }>()

export async function listTree(
  slug: string,
  branch: string,
  prefix?: string
): Promise<TreeEntry[]> {
  const octokit = getOctokit()
  const { owner, repo } = resolveRepo(slug)
  // Conditional getRef: a 304 (branch tip unchanged) is free against the rate
  // limit, and either way we get the current commit sha back.
  const ref = await conditionalGet(`ref:${owner}/${repo}:${branch}`, (headers) =>
    octokit.git.getRef({ owner, repo, ref: `heads/${branch}`, headers })
  )
  const commitSha = ref.object.sha
  const cacheKey = `${owner}/${repo}:${branch}`
  const cached = treeCache.get(cacheKey)

  let entries: TreeEntry[]
  if (cached && cached.sha === commitSha) {
    entries = cached.entries
  } else {
    const commit = await conditionalGet(`commit-obj:${owner}/${repo}:${commitSha}`, (headers) =>
      octokit.git.getCommit({ owner, repo, commit_sha: commitSha, headers }),
      { immutable: true }
    )
    const tree = await conditionalGet(`tree:${owner}/${repo}:${commit.tree.sha}`, (headers) =>
      octokit.git.getTree({ owner, repo, tree_sha: commit.tree.sha, recursive: 'true', headers }),
      { immutable: true }
    )
    const filtered = tree.tree.filter(
      (n): n is { path: string; sha: string; type: 'blob' | 'tree'; size?: number } =>
        typeof n.path === 'string' &&
        typeof n.sha === 'string' &&
        (n.type === 'blob' || n.type === 'tree')
    )
    entries = filtered.map((n) => ({ path: n.path, sha: n.sha, type: n.type, size: n.size }))
    treeCache.set(cacheKey, { sha: commitSha, entries })
  }

  return prefix ? entries.filter((n) => n.path.startsWith(prefix)) : entries.slice()
}

// List image blobs under the asset roots (public/content-assets, public/og-images).
export async function listAssets(
  slug: string,
  branch: string
): Promise<TreeEntry[]> {
  const all = await listTree(slug, branch)
  return all.filter(
    (n) =>
      n.type === 'blob' &&
      (n.path.startsWith('public/content-assets/') ||
        n.path.startsWith('public/og-images/')) &&
      IMAGE_EXT_RE.test(n.path)
  )
}

// Read a binary blob (image) by path. Resolves the blob sha via getContent,
// then pulls full bytes via the git blobs API so files >1MB aren't truncated
// the way getContent's inline `content` would be.
export async function readBinaryFile(
  slug: string,
  path: string,
  branch: string
): Promise<BinaryBlob> {
  const octokit = getOctokit()
  const { owner, repo } = resolveRepo(slug)
  try {
    const meta = await octokit.repos.getContent({ owner, repo, path, ref: branch })
    if (Array.isArray(meta.data) || meta.data.type !== 'file') {
      throw new Error(`Path is not a file: ${path}`)
    }
    const sha = meta.data.sha
    const blob = await octokit.git.getBlob({ owner, repo, file_sha: sha })
    const content = Buffer.from(blob.data.content, blob.data.encoding as BufferEncoding)
    return { path, content, sha, size: content.byteLength }
  } catch (err) {
    if (isRequestError(err) && err.status === 404) {
      throw new FileNotFoundError(path)
    }
    throw err
  }
}

// Blobs are content-addressed, so a (repo, sha) -> bytes entry never goes stale.
// A bounded LRU (by total bytes, small blobs only) lets repeat readers — the
// WordPress feed re-reading every post on each poll, the design snapshot, the
// document export — skip getBlob entirely, sparing the shared App quota.
const BLOB_CACHE_MAX_BYTES = 32 * 1024 * 1024
const BLOB_CACHE_MAX_ENTRY_BYTES = 1024 * 1024
const blobCache = new Map<string, Buffer>()
let blobCacheBytes = 0

function blobCacheGet(key: string): Buffer | undefined {
  const hit = blobCache.get(key)
  if (!hit) return undefined
  blobCache.delete(key)
  blobCache.set(key, hit)
  return hit
}

function blobCacheSet(key: string, buf: Buffer): void {
  if (buf.length > BLOB_CACHE_MAX_ENTRY_BYTES || blobCache.has(key)) return
  blobCache.set(key, buf)
  blobCacheBytes += buf.length
  while (blobCacheBytes > BLOB_CACHE_MAX_BYTES) {
    const oldest = blobCache.keys().next().value
    if (oldest === undefined) break
    blobCacheBytes -= blobCache.get(oldest)?.length ?? 0
    blobCache.delete(oldest)
  }
}

// Read a blob's bytes directly by its sha (one getBlob call, or none when
// cached). A caller that already has the sha from a tree listing skips the
// getContent lookup entirely. Returns a copy, so callers may mutate freely.
export async function readBlobBySha(slug: string, sha: string): Promise<Buffer> {
  const octokit = getOctokit()
  const { owner, repo } = resolveRepo(slug)
  const key = `${owner}/${repo}:${sha}`
  const cached = blobCacheGet(key)
  if (cached) return Buffer.from(cached)
  try {
    const blob = await withRateLimitRetry(() => octokit.git.getBlob({ owner, repo, file_sha: sha }))
    const buf = Buffer.from(blob.data.content, blob.data.encoding as BufferEncoding)
    blobCacheSet(key, Buffer.from(buf))
    return buf
  } catch (err) {
    if (isRequestError(err) && (err.status === 404 || err.status === 422)) {
      throw new FileNotFoundError(sha)
    }
    throw err
  }
}

const TEXT_BLOB_READ_CONCURRENCY = 4

// Bulk-read text files by the blob shas a listTree() already returned: one
// getBlob per file (vs getContent's path lookup), all through ONE bounded pool
// of 4 so a large site stays under GitHub's secondary limit. Order preserved.
export async function readTextBlobs(
  slug: string,
  entries: { path: string; sha: string }[]
): Promise<{ path: string; content: string }[]> {
  return mapWithConcurrency(entries, TEXT_BLOB_READ_CONCURRENCY, async (e) => ({
    path: e.path,
    content: (await readBlobBySha(slug, e.sha)).toString('utf-8'),
  }))
}

// Current blob sha of a file, or null if it doesn't exist. Used to enforce
// optimistic locking on binary writes without decoding the bytes.
async function currentSha(
  slug: string,
  path: string,
  branch: string
): Promise<string | null> {
  const octokit = getOctokit()
  const { owner, repo } = resolveRepo(slug)
  try {
    const res = await octokit.repos.getContent({ owner, repo, path, ref: branch })
    if (Array.isArray(res.data) || res.data.type !== 'file') return null
    return res.data.sha
  } catch (err) {
    if (isRequestError(err) && err.status === 404) return null
    throw err
  }
}

// Write binary content (already a Buffer) to the branch. `mode: 'create'`
// requires the path to be absent; `mode: 'replace'` requires expectedSha to
// match the current blob. StaleShaError (empty content) signals a lost race.
export async function writeBinaryFile(
  slug: string,
  path: string,
  content: Buffer,
  branch: string,
  message: string,
  options: {
    mode: 'create' | 'replace'
    expectedSha?: string
    authorName?: string
    authorEmail?: string
  }
): Promise<{ commitSha: string; blobSha: string }> {
  const octokit = getOctokit()
  const { owner, repo } = resolveRepo(slug)

  const existing = await currentSha(slug, path, branch)
  if (options.mode === 'create' && existing !== null) {
    throw new AssetExistsError(path)
  }
  if (options.mode === 'replace') {
    if (existing === null) throw new FileNotFoundError(path)
    if (options.expectedSha && existing !== options.expectedSha) {
      throw new StaleShaError(path, existing, '')
    }
  }

  const payload: Parameters<typeof octokit.repos.createOrUpdateFileContents>[0] = {
    owner,
    repo,
    path,
    message,
    content: content.toString('base64'),
    branch,
  }
  if (existing) payload.sha = existing
  if (options.authorName && options.authorEmail) {
    payload.author = { name: options.authorName, email: options.authorEmail }
  }

  const res = await octokit.repos.createOrUpdateFileContents(payload)
  return {
    commitSha: res.data.commit.sha ?? '',
    blobSha: res.data.content?.sha ?? '',
  }
}

// writeBinaryFile's create/replace semantics, plus text files that must land in
// the SAME commit (e.g. brand.json's logo.tone when the logo image is replaced).
// Every file is guarded against its base-tree blob sha, so a concurrent edit to
// either raises StaleShaError and nothing is committed.
export async function writeBinaryFileWithCompanions(
  slug: string,
  path: string,
  content: Buffer,
  branch: string,
  message: string,
  options: {
    mode: 'create' | 'replace'
    expectedSha?: string
    authorName?: string
    authorEmail?: string
    companions: { path: string; content: string; expectedSha: string | null }[]
  }
): Promise<{ commitSha: string; blobSha: string }> {
  const existing = await currentSha(slug, path, branch)
  if (options.mode === 'create' && existing !== null) throw new AssetExistsError(path)
  if (options.mode === 'replace') {
    if (existing === null) throw new FileNotFoundError(path)
    if (options.expectedSha && existing !== options.expectedSha) {
      throw new StaleShaError(path, existing, '')
    }
  }
  const entries: PushEntry[] = [
    { path, content, expectedBlobSha: existing },
    ...options.companions.map((c) => ({ path: c.path, content: c.content, expectedBlobSha: c.expectedSha })),
  ]
  const writes = await createBlobs(slug, entries)
  const commitSha = await commitTreeWrites(
    slug,
    branch,
    `writeBinaryFileWithCompanions ${slug}#${branch}`,
    writes,
    message,
    { authorName: options.authorName, authorEmail: options.authorEmail },
    async (base) => {
      for (const e of entries) await assertBlobSha(slug, e.path, e.expectedBlobSha ?? null, base, true)
    }
  )
  return { commitSha, blobSha: writes.find((w) => w.path === path)?.sha ?? '' }
}

// Delete a file from the branch. expectedSha guards against deleting a blob
// that changed since the caller last listed it.
export async function deleteFile(
  slug: string,
  path: string,
  branch: string,
  expectedSha: string,
  message: string,
  options: { authorName?: string; authorEmail?: string } = {}
): Promise<{ commitSha: string }> {
  const octokit = getOctokit()
  const { owner, repo } = resolveRepo(slug)
  const existing = await currentSha(slug, path, branch)
  if (existing === null) throw new FileNotFoundError(path)
  if (existing !== expectedSha) throw new StaleShaError(path, existing, '')

  const res = await octokit.repos.deleteFile({
    owner,
    repo,
    path,
    message,
    sha: expectedSha,
    branch,
    ...(options.authorName && options.authorEmail
      ? { author: { name: options.authorName, email: options.authorEmail } }
      : {}),
  })
  return { commitSha: res.data.commit.sha ?? '' }
}

// Atomically move a file (add at toPath + delete fromPath) in a single commit
// via the Git Data API, reusing the existing blob sha (no re-upload). Used to
// "draft"/"restore" a content page by relocating it between content/pages|posts
// and content/drafts/. expectedSha guards against a move racing a concurrent
// edit; the target must not already exist so a move never clobbers a file.
export async function moveFile(
  slug: string,
  fromPath: string,
  toPath: string,
  branch: string,
  expectedSha: string,
  message: string,
  options: {
    authorName?: string
    authorEmail?: string
    /** Text files committed in the same commit, each sha-guarded (null = must not exist). */
    companions?: { path: string; content: string; expectedSha: string | null }[]
  } = {}
): Promise<{ commitSha: string }> {
  const companions = options.companions ?? []
  const companionWrites = companions.length > 0 ? await createBlobs(slug, companions) : []
  // sha: null marks a deletion in the tree; the new entry reuses the moved
  // blob's sha (== expectedSha, verified below) so no blob upload is needed.
  // The checks run against each attempt's base commit, so a concurrent edit
  // landing between the check and the ref update is caught on the retry.
  const commitSha = await commitTreeWrites(
    slug,
    branch,
    `moveFile ${slug}#${branch}`,
    [
      { path: toPath, sha: expectedSha },
      { path: fromPath, sha: null },
      ...companionWrites,
    ],
    message,
    { authorName: options.authorName, authorEmail: options.authorEmail },
    async (base) => {
      const existing = await blobShaAt(slug, fromPath, base)
      if (existing === null) throw new FileNotFoundError(fromPath)
      if (existing !== expectedSha) throw new StaleShaError(fromPath, existing, '')
      if ((await blobShaAt(slug, toPath, base)) !== null) {
        throw new AssetExistsError(toPath)
      }
      for (const c of companions) await assertBlobSha(slug, c.path, c.expectedSha, base, true)
    }
  )
  return { commitSha }
}

export async function readFile(
  slug: string,
  path: string,
  branch: string
): Promise<FileBlob> {
  const octokit = getOctokit()
  const { owner, repo } = resolveRepo(slug)
  try {
    const res = await octokit.repos.getContent({ owner, repo, path, ref: branch })
    const data = res.data
    if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') {
      throw new Error(`Path is not a file: ${path}`)
    }
    const content = Buffer.from(data.content, data.encoding as BufferEncoding).toString('utf-8')
    return { path, content, sha: data.sha }
  } catch (err) {
    if (isRequestError(err) && err.status === 404) {
      throw new FileNotFoundError(path)
    }
    throw err
  }
}

// readFile through the ETag layer (lib/github/conditional.ts): an unchanged
// file revalidates with a free 304. For small, hot, rarely-changing reads (the
// template marker on every editor open / chat turn). Same errors as readFile.
export async function readFileConditional(
  slug: string,
  path: string,
  branch: string
): Promise<FileBlob> {
  const octokit = getOctokit()
  const { owner, repo } = resolveRepo(slug)
  try {
    const data = await conditionalGet(`content:${owner}/${repo}:${branch}:${path}`, (headers) =>
      octokit.repos.getContent({ owner, repo, path, ref: branch, headers })
    )
    if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') {
      throw new Error(`Path is not a file: ${path}`)
    }
    const content = Buffer.from(data.content, data.encoding as BufferEncoding).toString('utf-8')
    return { path, content, sha: data.sha }
  } catch (err) {
    if (isRequestError(err) && err.status === 404) {
      throw new FileNotFoundError(path)
    }
    throw err
  }
}

const WRITE_FILE_ATTEMPTS = 3

// Write or create a file on the given branch. If expectedSha is supplied and
// does not match the file's current sha on the branch, throws StaleShaError
// with the remote content so the caller can present a conflict UI. The
// Contents API enforces `sha` atomically, so there is NO pre-read: a branch read
// right after the caller's own commit can still return the previous tip and
// would raise a spurious conflict. The file is read only after the API rejects
// the write — a 409 is either a real sha mismatch (→ StaleShaError) or the
// branch moving under a concurrent commit (→ retried with jitter).
export async function writeFile(
  slug: string,
  path: string,
  content: string,
  branch: string,
  message: string,
  options: { expectedSha?: string; authorName?: string; authorEmail?: string } = {}
): Promise<{ commitSha: string; blobSha: string }> {
  const octokit = getOctokit()
  const { owner, repo } = resolveRepo(slug)

  const readCurrentOrStale = async (): Promise<FileBlob> => {
    try {
      return await readFile(slug, path, branch)
    } catch (err) {
      // File was deleted remotely; treat as stale.
      if (err instanceof FileNotFoundError) throw new StaleShaError(path, '', '')
      throw err
    }
  }

  // An empty expectedSha can never match a real blob — report the conflict.
  if (options.expectedSha === '') {
    const existing = await readCurrentOrStale()
    throw new StaleShaError(path, existing.sha, existing.content)
  }

  const payload: Parameters<typeof octokit.repos.createOrUpdateFileContents>[0] = {
    owner,
    repo,
    path,
    message,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch,
  }
  if (options.expectedSha) payload.sha = options.expectedSha
  if (options.authorName && options.authorEmail) {
    payload.author = { name: options.authorName, email: options.authorEmail }
  }

  for (let attempt = 1; ; attempt++) {
    try {
      const res = await octokit.repos.createOrUpdateFileContents(payload)
      return {
        commitSha: res.data.commit.sha ?? '',
        blobSha: res.data.content?.sha ?? '',
      }
    } catch (err) {
      if (!isRequestError(err)) throw err
      const guarded = options.expectedSha !== undefined
      // 409 = sha mismatch or ref race; 404/422 on a guarded write = the file
      // is gone or the sha isn't its blob. Read now to tell them apart.
      if (guarded && (err.status === 409 || err.status === 404 || err.status === 422)) {
        const existing = await readCurrentOrStale()
        if (existing.sha !== options.expectedSha) {
          throw new StaleShaError(path, existing.sha, existing.content)
        }
      }
      if (err.status !== 409) throw err
      if (attempt >= WRITE_FILE_ATTEMPTS) throw err
      const delay = 250 * attempt + Math.floor(Math.random() * 250)
      console.warn(`[github] writeFile ${slug}:${path}: 409 (attempt ${attempt}/${WRITE_FILE_ATTEMPTS}) — retrying in ${delay}ms`)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
}

// Remove a stale static public/sitemap.xml if one exists on the branch. New
// packages no longer ship it — the template's dynamic src/app/sitemap.ts owns
// the sitemap and auto-includes every post — but already-packaged repos still
// carry a frozen copy that shadows the route. Idempotent: returns false when
// nothing was there. Never throws; callers treat failure as non-fatal.
export async function removeStaleStaticSitemap(
  slug: string,
  branch: string,
  options: { authorName?: string; authorEmail?: string } = {}
): Promise<boolean> {
  let existing: FileBlob
  try {
    existing = await readFile(slug, 'public/sitemap.xml', branch)
  } catch (err) {
    if (err instanceof FileNotFoundError) return false
    throw err
  }
  await deleteFile(
    slug,
    'public/sitemap.xml',
    branch,
    existing.sha,
    'Remove static sitemap.xml — dynamic app/sitemap.ts now owns it',
    options
  )
  return true
}

// Patch only the `siteUrl: '...'` line in the repo-root site.config.ts so the
// dynamic sitemap (and any other siteConfig consumer) emits the canonical
// host. Targeted regex replace preserves every other field (legalLinks, forms,
// booking). No-op when the file is missing, the field is absent, or the value
// already matches. Returns true only when a commit was made.
// A legitimate site URL never contains quotes or backslashes; refusing them
// prevents an admin-supplied website_url from breaking out of the string
// literal we write into the executable site.config.ts (code injection).
const SAFE_SITE_URL_RE = /^https?:\/\/[A-Za-z0-9.\-:/_?#=&%]+$/

export async function patchSiteConfigSiteUrl(
  slug: string,
  branch: string,
  siteUrl: string,
  options: { authorName?: string; authorEmail?: string } = {}
): Promise<boolean> {
  if (!SAFE_SITE_URL_RE.test(siteUrl)) {
    console.warn(`[repo-files] Refusing unsafe siteUrl, not patching site.config.ts: ${siteUrl}`)
    return false
  }
  let blob: FileBlob
  try {
    blob = await readFile(slug, 'site.config.ts', branch)
  } catch (err) {
    if (err instanceof FileNotFoundError) return false
    throw err
  }
  const next = blob.content.replace(
    /(\bsiteUrl\s*:\s*)(['"])[^'"]*\2/,
    (_m, prefix: string, quote: string) => `${prefix}${quote}${siteUrl}${quote}`
  )
  if (next === blob.content) return false
  await writeFile(slug, 'site.config.ts', next, branch, `Set siteUrl to ${siteUrl}`, {
    expectedSha: blob.sha,
    ...options,
  })
  return true
}

// Read the canonical siteUrl out of the repo's site.config.ts (the deployed
// host). Returns null when the file/field is absent. Used by the Theme Studio
// preview to fetch and re-skin the real live site. Mirrors the booking reader's
// anchored-regex approach.
export async function readSiteConfigSiteUrl(
  slug: string,
  branch: string
): Promise<string | null> {
  let blob: FileBlob
  try {
    blob = await readFile(slug, 'site.config.ts', branch)
  } catch (err) {
    if (err instanceof FileNotFoundError) return null
    throw err
  }
  const m = blob.content.match(/^\s*siteUrl\s*:\s*['"]([^'"]+)['"]/m)
  const url = m?.[1]?.trim()
  return url && SAFE_SITE_URL_RE.test(url) ? url : null
}

// Read the current booking config out of the repo's site.config.ts by regex.
// Returns null when the file/booking block is absent. Used to seed the admin
// editor for an already-published client (site.config is the source of truth).
const CALENDLY_ORIGIN = 'https://*.calendly.com'
const SAFE_BOOKING_URL_RE = /^https:\/\/[^\s'"]+$/

export async function readSiteConfigBooking(
  slug: string,
  branch: string
): Promise<{ provider: 'none' | 'calendly' | 'iframe'; url: string } | null> {
  let blob: FileBlob
  try {
    blob = await readFile(slug, 'site.config.ts', branch)
  } catch (err) {
    if (err instanceof FileNotFoundError) return null
    throw err
  }
  const block = blob.content.match(/booking\s*:\s*\{([\s\S]*?)\n\s*\}/)
  if (!block) return null
  // Anchor to line start so the block's comments (which mention
  // "provider: 'calendly'") are not read as the real config.
  const providerM = block[1].match(/^\s*provider\s*:\s*['"](none|calendly|iframe)['"]/m)
  const urlM = block[1].match(/^\s*url\s*:\s*['"]([^'"]*)['"]/m)
  return {
    provider: (providerM?.[1] as 'none' | 'calendly' | 'iframe') ?? 'none',
    url: urlM?.[1] ?? '',
  }
}

// Patch the booking provider/url inside the site.config.ts `booking: { … }`
// block, and (for calendly) ensure the CSP origin is present. Mirrors
// patchSiteConfigSiteUrl's regex-replace approach. Returns true when a write
// happened. A non-https url with a non-'none' provider is refused.
export async function patchSiteConfigBooking(
  slug: string,
  branch: string,
  booking: { provider: 'none' | 'calendly' | 'iframe'; url: string },
  options: { authorName?: string; authorEmail?: string } = {}
): Promise<boolean> {
  const provider = booking.provider
  const url = provider === 'none' ? '' : booking.url.trim()
  if (provider !== 'none' && !SAFE_BOOKING_URL_RE.test(url)) {
    console.warn(`[repo-files] Refusing unsafe booking url, not patching site.config.ts: ${url}`)
    return false
  }

  let blob: FileBlob
  try {
    blob = await readFile(slug, 'site.config.ts', branch)
  } catch (err) {
    if (err instanceof FileNotFoundError) return false
    throw err
  }

  // Anchor key matches to the start of a line (multiline) so the booking
  // block's own explanatory comments — which literally contain
  // "provider: 'calendly'" and a calendly URL — are never mistaken for the
  // real config lines.
  let next = blob.content.replace(/(booking\s*:\s*\{)([\s\S]*?)(\n\s*\})/, (whole, open: string, body: string, close: string) => {
    let b = body
    b = /^\s*provider\s*:/m.test(b)
      ? b.replace(/^(\s*provider\s*:\s*)(['"])[^'"]*\2/m, `$1'${provider}'`)
      : `${b.trimEnd()}\n    provider: '${provider}',`
    b = /^\s*url\s*:/m.test(b)
      ? b.replace(/^(\s*url\s*:\s*)(['"])[^'"]*\2/m, `$1'${url}'`)
      : `${b.trimEnd()}\n    url: '${url}',`
    return `${open}${b}${close}`
  })

  // Keep the Calendly CSP origin in sync with the provider choice.
  next = next.replace(/(extraOrigins\s*:\s*)\[([\s\S]*?)\]/, (whole, prefix: string, inner: string) => {
    const has = inner.includes(CALENDLY_ORIGIN)
    if (provider === 'calendly' && !has) {
      const sep = inner.trim() ? `${inner.replace(/\s*$/, '')} ` : ''
      return `${prefix}[${sep}'${CALENDLY_ORIGIN}']`
    }
    if (provider !== 'calendly' && has) {
      const cleaned = inner
        .replace(new RegExp(`['"]${CALENDLY_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*,?`), '')
        .replace(/,\s*\]/, ']')
        .trim()
      return `${prefix}[${cleaned}]`
    }
    return whole
  })

  if (next === blob.content) return false
  await writeFile(slug, 'site.config.ts', next, branch, `Set booking to ${provider}`, {
    expectedSha: blob.sha,
    ...options,
  })
  return true
}

// Firm contact (NAP) lives once in content/brand.json — every page, the footer,
// the contact drawer, and the on-page schema read it. Patch just the changed
// contact fields there (on draft) so "Publish to live" propagates the change
// everywhere at once. Shallow-merges the provided fields into `contact`,
// preserving all others. No-op (patched:false) when the file is absent (client
// not yet assembled) or the JSON can't be parsed — the caller then relies on
// the pending MBP suggestion, which propagates at the next package rebuild.
export async function patchBrandJsonContact(
  slug: string,
  branch: string,
  contact: Partial<BrandJson['contact']>,
  options: { authorName?: string; authorEmail?: string } = {}
): Promise<{ patched: boolean }> {
  const CONTACT_PATH = 'content/brand.json'
  let blob: FileBlob
  try {
    blob = await readFile(slug, CONTACT_PATH, branch)
  } catch (err) {
    if (err instanceof FileNotFoundError) return { patched: false }
    throw err
  }

  let parsed: BrandJson
  try {
    parsed = JSON.parse(blob.content) as BrandJson
  } catch {
    console.warn(`[repo-files] content/brand.json is not valid JSON on ${slug}@${branch}; skipping contact patch`)
    return { patched: false }
  }

  const next: BrandJson = { ...parsed, contact: { ...parsed.contact, ...contact } }
  const serialized = JSON.stringify(next, null, 2) + '\n'
  if (serialized === blob.content) return { patched: false }

  await writeFile(slug, CONTACT_PATH, serialized, branch, 'Update firm contact info', {
    expectedSha: blob.sha,
    ...options,
  })
  return { patched: true }
}

// Returns { merged: true } on fast-forward / clean merge,
// or { merged: false, prUrl } if a PR had to be opened due to conflict.
export type MergeResult =
  | { merged: true; mergeCommitSha: string }
  | { merged: false; prUrl: string }

// Return the URL of the open draft→main PR, creating it if none exists. Idempotent:
// GitHub rejects a second PR for the same head branch ("A pull request already
// exists for owner:draft"), so we look one up first and fall back to a lookup if a
// create races. Used when a publish hits a merge conflict the admin must resolve.
async function ensureDraftPr(
  octokit: ReturnType<typeof getOctokit>,
  owner: string,
  repo: string
): Promise<string> {
  const head = `${owner}:${DRAFT_BRANCH}`
  const existing = await octokit.pulls.list({
    owner,
    repo,
    base: MAIN_BRANCH,
    head,
    state: 'open',
  })
  if (existing.data.length > 0) return existing.data[0].html_url

  try {
    const pr = await octokit.pulls.create({
      owner,
      repo,
      head: DRAFT_BRANCH,
      base: MAIN_BRANCH,
      title: 'Publish draft to live (manual resolve required)',
      body:
        'Auto-publish detected a conflict between `draft` and `main`. ' +
        'Resolve the conflict in this PR and merge to deploy.',
    })
    return pr.data.html_url
  } catch (err) {
    // A PR was created between our list and create (or already existed) — GitHub
    // 422s with a custom "already exists" message. Re-fetch and return it.
    if (isRequestError(err) && err.status === 422) {
      const retry = await octokit.pulls.list({ owner, repo, base: MAIN_BRANCH, head, state: 'open' })
      if (retry.data.length > 0) return retry.data[0].html_url
    }
    throw err
  }
}

export async function mergeDraftToMain(slug: string): Promise<MergeResult> {
  const octokit = getOctokit()
  const { owner, repo } = resolveRepo(slug)

  // Check if there's anything to merge.
  const cmp = await octokit.repos.compareCommits({
    owner,
    repo,
    base: MAIN_BRANCH,
    head: DRAFT_BRANCH,
  })
  if (cmp.data.ahead_by === 0) {
    return { merged: true, mergeCommitSha: '' }
  }

  try {
    const res = await octokit.repos.merge({
      owner,
      repo,
      base: MAIN_BRANCH,
      head: DRAFT_BRANCH,
      commit_message: 'Publish draft to live',
    })
    return { merged: true, mergeCommitSha: res.data.sha }
  } catch (err) {
    if (!isRequestError(err) || err.status !== 409) throw err
    // Conflict — surface a PR (reusing an open one) for the admin to resolve.
    return { merged: false, prUrl: await ensureDraftPr(octokit, owner, repo) }
  }
}

// Force-update draft branch to point at main's HEAD, DISCARDING any draft-only
// commits. Only for the explicit admin "Reset draft to live" action (discard a
// draft that has drifted too far to merge). Never call this after a publish —
// use fastForwardDraftToMain, which can't lose an edit that landed on draft
// between the merge and the reset.
export async function resetDraftToMain(slug: string): Promise<void> {
  const octokit = getOctokit()
  const { owner, repo } = resolveRepo(slug)
  const main = await octokit.git.getRef({ owner, repo, ref: `heads/${MAIN_BRANCH}` })
  await octokit.git.updateRef({
    owner,
    repo,
    ref: `heads/${DRAFT_BRANCH}`,
    sha: main.data.object.sha,
    force: true,
  })
}

// After a successful publish (main now contains draft), move draft up to main's
// HEAD with a NON-forced update, so the next round of edits starts from the same
// base. If someone committed to draft after the merge, the fast-forward is
// rejected and draft is left as-is (it still contains everything published plus
// the new edit). Returns whether draft moved; never throws on the ff rejection.
export async function fastForwardDraftToMain(slug: string): Promise<boolean> {
  const octokit = getOctokit()
  const { owner, repo } = resolveRepo(slug)
  const main = await octokit.git.getRef({ owner, repo, ref: `heads/${MAIN_BRANCH}` })
  try {
    await octokit.git.updateRef({
      owner,
      repo,
      ref: `heads/${DRAFT_BRANCH}`,
      sha: main.data.object.sha,
      force: false,
    })
    return true
  } catch (err) {
    if (isNonFastForward(err)) {
      console.warn(`[github] fastForwardDraftToMain ${slug}: draft moved after publish — leaving it in place`)
      return false
    }
    throw err
  }
}

export type SyncResult =
  | { synced: true; alreadyCurrent: boolean; mergeCommitSha: string | null }
  | { synced: false; reason: string }

// "Keep draft current": merge commits that landed on main (e.g. direct dev
// pushes, a hand-merged PR) into the long-lived draft branch so a later publish
// merges cleanly instead of conflicting. Nothing on main to pull → alreadyCurrent;
// a clean merge → a new merge commit on draft (draft edits preserved). A content
// conflict can't be auto-resolved, so we report it rather than force anything —
// the admin resolves on GitHub or uses "Reset draft to live".
export async function syncMainIntoDraft(slug: string): Promise<SyncResult> {
  const octokit = getOctokit()
  const { owner, repo } = resolveRepo(slug)

  // base=draft, head=main: ahead_by = commits main has that draft lacks (how stale
  // draft is); behind_by = draft-only commits main lacks (genuine divergence).
  const cmp = await octokit.repos.compareCommits({
    owner,
    repo,
    base: DRAFT_BRANCH,
    head: MAIN_BRANCH,
  })
  if (cmp.data.ahead_by === 0) {
    return { synced: true, alreadyCurrent: true, mergeCommitSha: null }
  }

  // Draft has no commits of its own → main is strictly ahead, so fast-forward the
  // draft ref to main instead of merging. octokit.repos.merge ALWAYS writes a merge
  // commit (never fast-forwards), which would leave draft "1 ahead" of main by an
  // empty commit — surfacing a phantom "N to publish" badge with an empty diff.
  if (cmp.data.behind_by === 0) {
    const main = await octokit.git.getRef({ owner, repo, ref: `heads/${MAIN_BRANCH}` })
    await octokit.git.updateRef({
      owner,
      repo,
      ref: `heads/${DRAFT_BRANCH}`,
      sha: main.data.object.sha,
      force: false,
    })
    return { synced: true, alreadyCurrent: false, mergeCommitSha: null }
  }

  try {
    const res = await octokit.repos.merge({
      owner,
      repo,
      base: DRAFT_BRANCH,
      head: MAIN_BRANCH,
      commit_message: 'Update draft from live',
    })
    return { synced: true, alreadyCurrent: false, mergeCommitSha: res.data.sha ?? null }
  } catch (err) {
    if (isRequestError(err) && err.status === 409) {
      return {
        synced: false,
        reason:
          'Live has changes that conflict with the current draft. Resolve them on GitHub, ' +
          'or use "Reset draft to live" to discard the draft and start from the live site.',
      }
    }
    throw err
  }
}

export type RepoStatus = {
  draftAhead: number
  draftBehind: number
  lastCommitSha: string | null
  lastCommitMessage: string | null
  lastCommitAt: string | null
  /** Messages of every commit draft is ahead of main by (oldest → newest). Lets
   *  the deploy-status check find the deploy commit even when the publish
   *  pipeline has stacked follow-up commits on top of it. */
  aheadCommitMessages: string[]
  /** True when main's HEAD is a publish merge that revertLastPublish can undo. */
  canRevertPublish: boolean
}

const PUBLISH_MERGE_MESSAGE = 'Publish draft to live'

// main HEAD must be the merge commit our publish created — two parents and
// the exact publish message. Anything else (manual commits, GitHub-side
// merges) is not safe to force-revert blindly.
async function isPublishMergeHead(slug: string) {
  const octokit = getOctokit()
  const { owner, repo } = resolveRepo(slug)
  const head = await conditionalGet(`commit:${owner}/${repo}:${MAIN_BRANCH}`, (headers) =>
    octokit.repos.getCommit({ owner, repo, ref: MAIN_BRANCH, headers })
  )
  const isPublish =
    head.parents.length === 2 && head.commit.message.startsWith(PUBLISH_MERGE_MESSAGE)
  return { isPublish, parentSha: head.parents[0]?.sha ?? null, headSha: head.sha }
}

export async function getStatus(slug: string): Promise<RepoStatus> {
  const { owner, repo } = resolveRepo(slug)
  const octokit = getOctokit()
  const cmpData = await conditionalGet(
    `compare:${owner}/${repo}:${MAIN_BRANCH}...${DRAFT_BRANCH}`,
    (headers) =>
      octokit.repos.compareCommits({ owner, repo, base: MAIN_BRANCH, head: DRAFT_BRANCH, headers })
  )
  const cmp = { data: cmpData }
  const head = cmp.data.commits.at(-1)
  let canRevertPublish = false
  try {
    canRevertPublish = (await isPublishMergeHead(slug)).isPublish
  } catch {
    // Status must stay usable even if the HEAD lookup hiccups.
  }
  return {
    draftAhead: cmp.data.ahead_by,
    draftBehind: cmp.data.behind_by,
    lastCommitSha: head?.sha ?? null,
    lastCommitMessage: head?.commit.message ?? null,
    lastCommitAt: head?.commit.author?.date ?? null,
    aheadCommitMessages: cmp.data.commits.map((c) => c.commit.message),
    canRevertPublish,
  }
}

// The real draft branch tip sha — always present, independent of main. Use this
// (not getStatus().lastCommitSha, which is the tip of the commits draft is AHEAD
// of main by and is therefore null whenever draft is up to date with live) as the
// cache key for anything derived from draft history, so the cache still keys on a
// stable sha once a site has published and draft == main. Conditional getRef: a
// 304 (tip unchanged) is free against the rate limit.
export async function getDraftHeadSha(slug: string): Promise<string | null> {
  const octokit = getOctokit()
  const { owner, repo } = resolveRepo(slug)
  const ref = await conditionalGet(`ref:${owner}/${repo}:${DRAFT_BRANCH}`, (headers) =>
    octokit.git.getRef({ owner, repo, ref: `heads/${DRAFT_BRANCH}`, headers })
  )
  return ref.object.sha ?? null
}

// The newest "Deploy packaged content" commit reachable from draft, or null when
// the site has never had a package pushed. Every package writes the
// LLM-generated content/brand.md, so the path-filtered history is short and the
// deploy commits are in it. Publishing merges draft into main and a draft reset
// points draft at main, so the commit stays reachable either way.
export async function findLastDeployCommitSha(slug: string, maxPages = 3): Promise<string | null> {
  const octokit = getOctokit()
  const { owner, repo } = resolveRepo(slug)
  const perPage = 100
  for (let page = 1; page <= maxPages; page++) {
    const list = await withRateLimitRetry(() =>
      octokit.repos.listCommits({
        owner,
        repo,
        sha: DRAFT_BRANCH,
        path: 'content/brand.md',
        per_page: perPage,
        page,
      })
    )
    for (const c of list.data) {
      if ((c.commit.message ?? '').startsWith(DEPLOY_COMMIT_PREFIX)) return c.sha
    }
    if (list.data.length < perPage) break
  }
  return null
}

// Blob entries of the full tree at an (immutable) commit sha.
export async function listTreeAtCommit(slug: string, commitSha: string): Promise<TreeEntry[]> {
  const octokit = getOctokit()
  const { owner, repo } = resolveRepo(slug)
  const commit = await conditionalGet(`commit-obj:${owner}/${repo}:${commitSha}`, (headers) =>
    octokit.git.getCommit({ owner, repo, commit_sha: commitSha, headers }),
    { immutable: true }
  )
  const tree = await conditionalGet(`tree:${owner}/${repo}:${commit.tree.sha}`, (headers) =>
    octokit.git.getTree({ owner, repo, tree_sha: commit.tree.sha, recursive: 'true', headers }),
    { immutable: true }
  )
  return tree.tree
    .filter(
      (n): n is { path: string; sha: string; type: 'blob'; size?: number } =>
        typeof n.path === 'string' && typeof n.sha === 'string' && n.type === 'blob'
    )
    .map((n) => ({ path: n.path, sha: n.sha, type: n.type, size: n.size }))
}

export type RevertResult =
  | { reverted: true; revertedTo: string }
  | { reverted: false; reason: string }

// Undo the most recent publish: force main back to the merge commit's first
// parent (the pre-publish live state). Draft is left alone — it still holds
// the published content, so the admin can fix it there and publish again.
export async function revertLastPublish(slug: string): Promise<RevertResult> {
  const octokit = getOctokit()
  const { owner, repo } = resolveRepo(slug)
  const { isPublish, parentSha, headSha } = await isPublishMergeHead(slug)
  if (!isPublish || !parentSha) {
    return {
      reverted: false,
      reason: 'The live branch tip is not a publish merge — nothing safe to revert.',
    }
  }
  // The rollback is a forced ref update, which would silently discard anything
  // that reached main after the check above (another tab's Publish). Re-read
  // the live ref uncached right before forcing and abort if it moved, so the
  // check-then-force window is one round-trip instead of the whole request.
  const current = await octokit.git.getRef({ owner, repo, ref: `heads/${MAIN_BRANCH}` })
  if (current.data.object.sha !== headSha) {
    return {
      reverted: false,
      reason: 'The live site changed while rolling back (another publish landed). Reload and try again.',
    }
  }
  await octokit.git.updateRef({
    owner,
    repo,
    ref: `heads/${MAIN_BRANCH}`,
    sha: parentSha,
    force: true,
  })
  return { reverted: true, revertedTo: parentSha }
}

export type ChangedFile = {
  /** Path on the draft branch (the current name for a rename). */
  path: string
  /** Raw GitHub compare status: added | modified | removed | renamed | changed | copied. */
  status: string
  additions: number
  deletions: number
  /** Unified diff hunk text; null for binary blobs (images) or when GitHub omits it. */
  patch: string | null
  /** Blob sha of the file at the draft tip — the optimistic-lock token for revert. */
  blobSha: string
  /** True when no textual patch is available (image/asset). */
  isBinary: boolean
  /** Prior path when status is 'renamed'. */
  previousPath: string | null
  /** Author of the newest commit that touched this path on the draft branch. */
  author: { name: string; email: string } | null
  date: string | null
  message: string | null
}

// Per-commit changed-file list, keyed by commit sha. A commit is immutable, so
// an entry never goes stale; bounded LRU so a warm instance can't grow it
// forever. Shared by getDraftChanges and the edit-stats walkers.
type CommitFiles = CommitFileStat['files']
const COMMIT_FILES_CACHE_MAX = 2000
const commitFilesCache = new Map<string, CommitFiles>()

async function getCommitFiles(slug: string, sha: string): Promise<CommitFiles> {
  const { owner, repo } = resolveRepo(slug)
  const key = `${owner}/${repo}:${sha}`
  const hit = commitFilesCache.get(key)
  if (hit) {
    commitFilesCache.delete(key)
    commitFilesCache.set(key, hit)
    return hit
  }
  const octokit = getOctokit()
  const detail = await withRateLimitRetry(() => octokit.repos.getCommit({ owner, repo, ref: sha }))
  const files: CommitFiles = (detail.data.files ?? []).map((f) => ({
    path: f.filename,
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
    status: f.status ?? 'modified',
  }))
  commitFilesCache.set(key, files)
  while (commitFilesCache.size > COMMIT_FILES_CACHE_MAX) {
    const oldest = commitFilesCache.keys().next().value
    if (oldest === undefined) break
    commitFilesCache.delete(oldest)
  }
  return files
}

// Map over items with at most `limit` in flight, preserving order.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

const COMMIT_DETAIL_CONCURRENCY = 4

// List every file the draft branch changed relative to live (main) — the
// unpublished changes. compareCommits gives the per-file status + diff; we
// attribute each file to the newest draft commit that touched it (who last
// edited it, and when) by walking the ahead-commits newest-first. Per-commit
// file lists are fetched with bounded concurrency and cached by (immutable)
// commit sha, so repeat opens cost only the compare call.
export async function getDraftChanges(slug: string): Promise<{ files: ChangedFile[] }> {
  const octokit = getOctokit()
  const { owner, repo } = resolveRepo(slug)
  const cmp = await withRateLimitRetry(() =>
    octokit.repos.compareCommits({
      owner,
      repo,
      base: MAIN_BRANCH,
      head: DRAFT_BRANCH,
    })
  )

  // compareCommits.commits are oldest→newest; walk in reverse so the first
  // commit we see touching a path is the most recent editor (first write wins).
  const commits = cmp.data.commits ?? []
  const commitFiles = await mapWithConcurrency(commits, COMMIT_DETAIL_CONCURRENCY, (c) =>
    getCommitFiles(slug, c.sha)
  )
  const attribution = new Map<string, { author: { name: string; email: string }; date: string | null; message: string }>()
  for (let i = commits.length - 1; i >= 0; i--) {
    const c = commits[i]
    const info = {
      author: {
        name: c.commit.author?.name ?? c.commit.committer?.name ?? '',
        email: c.commit.author?.email ?? c.commit.committer?.email ?? '',
      },
      date: c.commit.author?.date ?? c.commit.committer?.date ?? null,
      message: c.commit.message,
    }
    for (const f of commitFiles[i]) {
      if (!attribution.has(f.path)) attribution.set(f.path, info)
    }
  }

  const files: ChangedFile[] = (cmp.data.files ?? [])
    .filter((f) => f.filename !== DEPLOY_MANIFEST_PATH)
    .map((f) => {
    const attr = attribution.get(f.filename) ?? null
    return {
      path: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch ?? null,
      blobSha: f.sha,
      isBinary: f.patch == null,
      previousPath: f.previous_filename ?? null,
      author: attr?.author ?? null,
      date: attr?.date ?? null,
      message: attr?.message ?? null,
    }
  })

  return { files }
}

export type CommitFileStat = {
  sha: string
  message: string
  authorName: string
  authorEmail: string
  date: string | null
  /** Number of parents — a merge (≥2) is a bulk publish, not a per-file edit. */
  parentCount: number
  files: { path: string; additions: number; deletions: number; status: string }[]
}

// Walk the draft branch's commit history newest-first (up to `cap`), returning
// each commit with the files it touched + per-file additions/deletions. This is
// the raw material for per-page edit-activity stats. Cost is one getCommit call
// per commit, so callers cache the aggregate by draft HEAD sha and only re-walk
// when HEAD moves. `truncated` is true when history exceeds `cap`.
// Recent commit messages that touched one path on a branch (newest first, one
// API call). Used for cheap per-page "has hand edits" checks.
export async function listPathCommitMessages(slug: string, path: string, branch: string, limit = 50): Promise<string[]> {
  const octokit = getOctokit()
  const { owner, repo } = resolveRepo(slug)
  const res = await octokit.repos.listCommits({ owner, repo, sha: branch, path, per_page: limit })
  return res.data.map((c) => c.commit.message)
}

export async function walkCommitFileStats(
  slug: string,
  cap = 500
): Promise<{ headSha: string | null; commits: CommitFileStat[]; truncated: boolean }> {
  const octokit = getOctokit()
  const { owner, repo } = resolveRepo(slug)
  const commits: CommitFileStat[] = []
  let headSha: string | null = null
  let truncated = false
  const perPage = 100

  for (let page = 1; ; page++) {
    const list = await withRateLimitRetry(() =>
      octokit.repos.listCommits({
        owner,
        repo,
        sha: DRAFT_BRANCH,
        per_page: perPage,
        page,
      })
    )
    if (list.data.length === 0) break
    for (const c of list.data) {
      if (headSha === null) headSha = c.sha
      if (commits.length >= cap) {
        truncated = true
        return { headSha, commits, truncated }
      }
      commits.push({
        sha: c.sha,
        message: c.commit.message ?? '',
        authorName: c.commit.author?.name ?? c.commit.committer?.name ?? '',
        authorEmail: c.commit.author?.email ?? c.commit.committer?.email ?? '',
        date: c.commit.author?.date ?? c.commit.committer?.date ?? null,
        parentCount: c.parents?.length ?? 0,
        files: await getCommitFiles(slug, c.sha),
      })
    }
    if (list.data.length < perPage) break
  }
  return { headSha, commits, truncated }
}

// Thrown by walkNewCommitFileStats when the incremental fold can't be trusted:
// the cached base is no longer an ancestor of draft (reset/force-push →
// 'diverged'/'behind'), or the compare response truncated its commit list.
// Callers fall back to a full walk.
export class IncrementalWalkUnavailableError extends Error {
  constructor(reason: string) {
    super(`Incremental edit-stats walk unavailable: ${reason}`)
    this.name = 'IncrementalWalkUnavailableError'
  }
}

// Incremental companion to walkCommitFileStats: return only the commits added to
// the draft branch since `sinceSha` (the last-cached HEAD), newest-last, each
// with its per-file additions/deletions. One compareCommits call + one getCommit
// per new commit — typically a handful, versus re-walking the whole history.
// Callers fold these into the cached aggregate. Throws
// IncrementalWalkUnavailableError (or a 404/422 RequestError when `sinceSha` is
// gone entirely) when the fold would be wrong; the caller then does a full walk.
export async function walkNewCommitFileStats(
  slug: string,
  sinceSha: string
): Promise<CommitFileStat[]> {
  const octokit = getOctokit()
  const { owner, repo } = resolveRepo(slug)
  const cmp = await withRateLimitRetry(() =>
    octokit.repos.compareCommits({ owner, repo, base: sinceSha, head: DRAFT_BRANCH })
  )
  const status = cmp.data.status
  if (status === 'identical') return []
  // compareCommits.commits are the commits reachable from head but not base,
  // ordered oldest→newest (base itself is excluded). Only a strict 'ahead'
  // comparison means "history since sinceSha"; 'diverged' would silently fold in
  // unrelated commits and double-count or miss the reset ones. The list is also
  // capped server-side (250), so a partial list must not be folded.
  const newCommits = cmp.data.commits ?? []
  if (status !== 'ahead') throw new IncrementalWalkUnavailableError(`compare status ${status}`)
  if (cmp.data.total_commits > newCommits.length) {
    throw new IncrementalWalkUnavailableError(
      `compare returned ${newCommits.length} of ${cmp.data.total_commits} commits`
    )
  }
  const files = await mapWithConcurrency(newCommits, COMMIT_DETAIL_CONCURRENCY, (c) =>
    getCommitFiles(slug, c.sha)
  )
  return newCommits.map((c, i) => ({
    sha: c.sha,
    message: c.commit.message ?? '',
    authorName: c.commit.author?.name ?? c.commit.committer?.name ?? '',
    authorEmail: c.commit.author?.email ?? c.commit.committer?.email ?? '',
    date: c.commit.author?.date ?? c.commit.committer?.date ?? null,
    parentCount: c.parents?.length ?? 0,
    files: files[i],
  }))
}

export type RevertFileResult = {
  reverted: true
  commitSha: string
  action: 'restored' | 'removed'
}

// Undo a single file's unpublished changes by making the draft copy match live
// (main), before anything is published. Three cases, all optimistically locked
// against the draft blob the caller last saw (expectedSha):
//   - file exists on main + draft  → restore live content onto draft (modified)
//   - file exists on main, not draft → re-create it on draft (was deleted)
//   - file absent on main            → delete it from draft (was newly added,
//                                       incl. the new-name side of a rename)
// The restore points draft's tree entry at MAIN'S BLOB SHA (Git Data API) —
// never a utf-8 decode/re-encode — so binary files (images) round-trip intact.
// A concurrent edit (draft sha moved) surfaces as StaleShaError → 409.
//
// A RENAME (compare reports one entry: `path` = new name, `previousPath` = old)
// must revert both sides together, or the undo deletes the page: pass
// `previousPath` and both paths are set to their live state in ONE commit —
// the new path removed (guarded at its draft sha), the old path restored to
// main's blob (guarded as absent / at its draft sha).
export async function revertFileToMain(
  slug: string,
  path: string,
  expectedSha: string,
  options: { authorName?: string; authorEmail?: string } = {},
  previousPath: string | null = null
): Promise<RevertFileResult> {
  const name = path.split('/').pop() ?? path
  const attribution = options.authorEmail ? ` (${options.authorEmail})` : ''

  if (previousPath && previousPath !== path) {
    const [liveNew, draftNew, liveOld, draftOld] = await Promise.all([
      currentSha(slug, path, MAIN_BRANCH),
      currentSha(slug, path, DRAFT_BRANCH),
      currentSha(slug, previousPath, MAIN_BRANCH),
      currentSha(slug, previousPath, DRAFT_BRANCH),
    ])
    if (draftNew !== null && expectedSha && draftNew !== expectedSha) {
      throw new StaleShaError(path, draftNew, '')
    }
    const writes: TreeWrite[] = []
    if (draftNew !== liveNew) writes.push({ path, sha: liveNew })
    if (draftOld !== liveOld) writes.push({ path: previousPath, sha: liveOld })
    if (writes.length === 0) return { reverted: true, commitSha: '', action: 'restored' }
    const oldName = previousPath.split('/').pop() ?? previousPath
    const commitSha = await commitTreeWrites(
      slug,
      DRAFT_BRANCH,
      `revertFileToMain ${slug}:${previousPath}→${path}`,
      writes,
      `Revert rename ${oldName} → ${name} to live via admin${attribution}`,
      { authorName: options.authorName, authorEmail: options.authorEmail },
      async (base) => {
        await assertBlobSha(slug, path, draftNew, base, false)
        await assertBlobSha(slug, previousPath, draftOld, base, false)
      }
    )
    return { reverted: true, commitSha, action: 'restored' }
  }

  const liveSha = await currentSha(slug, path, MAIN_BRANCH)
  const draftSha = await currentSha(slug, path, DRAFT_BRANCH)

  if (liveSha === null) {
    // Not on live → the draft added it → undo = remove it from draft.
    if (draftSha === null) return { reverted: true, commitSha: '', action: 'removed' }
    if (expectedSha && draftSha !== expectedSha) throw new StaleShaError(path, draftSha, '')
    const res = await deleteFile(
      slug,
      path,
      DRAFT_BRANCH,
      draftSha,
      `Revert (remove) ${name} via admin${attribution}`,
      { authorName: options.authorName, authorEmail: options.authorEmail }
    )
    return { reverted: true, commitSha: res.commitSha, action: 'removed' }
  }

  if (draftSha !== null && expectedSha && draftSha !== expectedSha) {
    throw new StaleShaError(path, draftSha, '')
  }
  if (draftSha === liveSha) return { reverted: true, commitSha: '', action: 'restored' }

  // Live has the file → point draft's entry at live's blob. Guard against the
  // draft state we just observed (present at draftSha, or absent) on every
  // attempt's base tree.
  const commitSha = await commitTreeWrites(
    slug,
    DRAFT_BRANCH,
    `revertFileToMain ${slug}:${path}`,
    [{ path, sha: liveSha }],
    `Revert ${name} to live via admin${attribution}`,
    { authorName: options.authorName, authorEmail: options.authorEmail },
    async (base) => {
      await assertBlobSha(slug, path, draftSha, base, false)
    }
  )
  return { reverted: true, commitSha, action: 'restored' }
}
