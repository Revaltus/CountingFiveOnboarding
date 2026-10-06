// ---------------------------------------------------------------------------
// Seed a client site repo from counting-five-client-template.
//
// Git objects are not shared across repositories, so seeding an already-created
// repo means re-creating every template blob in the target and committing them.
// This is a one-time, ~2-calls-per-file operation (177 files today), so it runs
// from its OWN admin route with a generous maxDuration — never inline on the
// package-assembly path, which is already near its Vercel budget.
//
// Idempotent: if the target already carries the template (marker file present),
// seeding is skipped and existing files are left untouched — the deliverable's
// content/ + public/ paths are overlaid later by the normal push.
//
// Server-only: authenticates as the GitHub App installation.
// ---------------------------------------------------------------------------
import { RequestError } from '@octokit/request-error'
import { getOctokit, resolveRepo } from './app-client'
import { DRAFT_BRANCH, ensureDraftBranch, MAIN_BRANCH, syncMainIntoDraft } from './repo-files'
import { sleep, withRateLimitRetry } from './rate-limit'

// Presence of this file on the target's main branch means the repo has already
// been seeded (created from the template, or seeded by a prior run).
const SEED_MARKER_PATH = 'package.json'

// How many template blobs to copy at once. Kept low: GitHub imposes a
// SECONDARY rate limit on bursts of content-creating requests, and copying a
// 177-file template is exactly such a burst. Low concurrency + retry (below) is
// GitHub's documented remedy — serialize writes and honor retry-after.
const BLOB_COPY_CONCURRENCY = 3

// Git tree blob modes we preserve verbatim; anything else is coerced to a
// regular file. (Submodules / directory entries are filtered out before here.)
type BlobMode = '100644' | '100755' | '120000'
function normalizeMode(mode: string | undefined): BlobMode {
  return mode === '100755' || mode === '120000' ? mode : '100644'
}

function isRequestError(err: unknown): err is RequestError {
  return err instanceof RequestError
}

// Right after the first commit lands in an empty repo, GitHub's Git Data API
// keeps answering 409 "Git Repository is empty" for a moment. Seen in prod: the
// bootstrap commit succeeded and the next createBlob 409'd, stranding the repo
// with one file. Retry only that exact error, briefly.
const EMPTY_REPO_RETRY_DELAYS_MS = [500, 1000, 2000, 3000, 4000]

function isEmptyRepoError(err: unknown): boolean {
  return isRequestError(err) && err.status === 409 && /repository is empty/i.test(err.message)
}

async function withEmptyRepoRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (!isEmptyRepoError(err) || attempt >= EMPTY_REPO_RETRY_DELAYS_MS.length) throw err
      await sleep(EMPTY_REPO_RETRY_DELAYS_MS[attempt])
    }
  }
}

// A draft branch cut before the template landed (e.g. library articles drafted
// against the bootstrap-only main) lacks every template file. Assembling onto it
// and publishing would add/add-conflict with the seeded main, so pull main in.
async function bringDraftUpToMain(slug: string): Promise<void> {
  await ensureDraftBranch(slug)
  const sync = await syncMainIntoDraft(slug)
  if (!sync.synced) {
    throw new Error(
      `Template seeded, but the draft branch conflicts with it. Use "Reset draft to live" and retry. (${sync.reason})`
    )
  }
}

// Template-only files that must never reach a client repo.
// content/.template-default marks the template's OWN placeholder content: its
// presence gates template-only tests (they assert the template defaults) in
// counting-five-client-template. Seeded into a client repo it would make those
// tests run against real client content and fail the site's CI.
const TEMPLATE_ONLY_PATHS: ReadonlySet<string> = new Set(['content/.template-default'])

export function isTemplateOnlyPath(path: string): boolean {
  return TEMPLATE_ONLY_PATHS.has(path)
}

export function resolveTemplateSlug(): string {
  // Fully-qualified default: the target repo slug may carry an explicit owner
  // that differs from GITHUB_ORG, so don't rely on the bare-name owner default.
  return process.env.GITHUB_TEMPLATE_REPO?.trim() || 'Revaltus/CountingFiveTemplate'
}

export type SeedResult =
  | { seeded: false; skipped: 'already-seeded'; fileCount: 0 }
  | { seeded: true; fileCount: number; commitSha: string; skippedWorkflowFiles: number }

// True when the target repo already contains the template marker on `ref`.
// A missing marker, a missing branch, or an empty repo all read as "not
// seeded" so a freshly-created empty repo qualifies for seeding.
export async function isRepoSeeded(slug: string, ref: string = MAIN_BRANCH): Promise<boolean> {
  const octokit = getOctokit()
  const { owner, repo } = resolveRepo(slug)
  try {
    await octokit.repos.getContent({ owner, repo, path: SEED_MARKER_PATH, ref })
    return true
  } catch (err) {
    if (isRequestError(err) && (err.status === 404 || err.status === 409)) return false
    throw err
  }
}

export async function seedRepoFromTemplate(
  slug: string,
  options: { authorName?: string; authorEmail?: string } = {}
): Promise<SeedResult> {
  if (await isRepoSeeded(slug)) {
    // Self-heal a repo left with a template-less draft by an earlier failed seed.
    // Only then: a normal live client's draft already carries the template, and
    // merging main into it on every publish could surface unrelated conflicts.
    if (!(await isRepoSeeded(slug, DRAFT_BRANCH))) await bringDraftUpToMain(slug)
    return { seeded: false, skipped: 'already-seeded', fileCount: 0 }
  }

  const octokit = getOctokit()
  const target = resolveRepo(slug)
  const template = resolveRepo(resolveTemplateSlug())

  // Read the template's default-branch tree in one recursive call.
  const templateRepo = await octokit.repos.get({ owner: template.owner, repo: template.repo })
  const templateBranch = templateRepo.data.default_branch
  const templateRef = await octokit.git.getRef({
    owner: template.owner,
    repo: template.repo,
    ref: `heads/${templateBranch}`,
  })
  const templateCommit = await octokit.git.getCommit({
    owner: template.owner,
    repo: template.repo,
    commit_sha: templateRef.data.object.sha,
  })
  const templateTree = await octokit.git.getTree({
    owner: template.owner,
    repo: template.repo,
    tree_sha: templateCommit.data.tree.sha,
    recursive: 'true',
  })
  if (templateTree.data.truncated) {
    throw new Error('Template tree is too large to seed in one pass (GitHub truncated the listing)')
  }

  const allBlobs = templateTree.data.tree.filter(
    (n): n is { path: string; sha: string; type: 'blob'; mode?: string } =>
      n.type === 'blob' && typeof n.path === 'string' && typeof n.sha === 'string'
  )

  // Committing files under .github/workflows/ requires the GitHub App to hold
  // the "Workflows" permission; without it createTree/createCommit is refused
  // with 403 "Resource not accessible by integration" (blobs upload fine — the
  // tree is where the workflow paths get assigned). These are CI/Lighthouse dev
  // gates, irrelevant to a Vercel-deployed client site, so skip them and report
  // the count rather than failing the whole seed. Grant the App "Workflows:
  // Read & Write" and re-seed if you want them included.
  const isWorkflowPath = (p: string) => p.startsWith('.github/workflows/')
  const skippedWorkflowFiles = allBlobs.filter((b) => isWorkflowPath(b.path)).length
  const blobs = allBlobs.filter((b) => !isWorkflowPath(b.path) && !isTemplateOnlyPath(b.path))
  if (skippedWorkflowFiles > 0) {
    console.warn(`[seed-repo] Skipping ${skippedWorkflowFiles} .github/workflows file(s) — App lacks Workflows permission`)
  }

  if (blobs.length === 0) {
    throw new Error(`Template ${template.owner}/${template.repo} has no files to seed`)
  }

  // Fetch a template blob's bytes as normalized base64. getBlob returns
  // 'base64' (normal) or 'utf-8'; it returns 'none' for blobs >100MB, which
  // can't be round-tripped this way — guard so that surfaces as a clear,
  // file-named error instead of a cryptic "Unknown encoding" crash.
  const fetchTemplateBlobBase64 = async (sha: string, path: string): Promise<string> => {
    const blob = await withRateLimitRetry(() =>
      octokit.git.getBlob({ owner: template.owner, repo: template.repo, file_sha: sha })
    )
    if (blob.data.encoding !== 'base64' && blob.data.encoding !== 'utf-8') {
      throw new Error(`Cannot seed ${path}: unsupported blob encoding "${blob.data.encoding}"`)
    }
    return Buffer.from(blob.data.content, blob.data.encoding).toString('base64')
  }

  // The Git Data API (createBlob/createTree/createCommit) refuses to operate on
  // a repo with zero commits ("Git Repository is empty"). If main doesn't exist
  // yet, bootstrap it with a single initial commit via the Contents API — which
  // DOES work on an empty repo and creates the branch — then overlay the full
  // template on top. Bootstrapping with a NON-marker file keeps re-runs safe:
  // SEED_MARKER_PATH only lands in the final overlay commit, so a bootstrap that
  // fails before the overlay still reads as "not seeded" on the next attempt.
  let mainExists = true
  try {
    await octokit.git.getRef({ owner: target.owner, repo: target.repo, ref: `heads/${MAIN_BRANCH}` })
  } catch (err) {
    if (isRequestError(err) && (err.status === 404 || err.status === 409)) mainExists = false
    else throw err
  }

  if (!mainExists) {
    const bootstrap = blobs.find((b) => b.path !== SEED_MARKER_PATH) ?? blobs[0]
    const bootstrapContent = await fetchTemplateBlobBase64(bootstrap.sha, bootstrap.path)
    await withRateLimitRetry(() =>
      octokit.repos.createOrUpdateFileContents({
        owner: target.owner,
        repo: target.repo,
        path: bootstrap.path,
        message: 'Initialize repository',
        content: bootstrapContent,
        branch: MAIN_BRANCH,
        ...(options.authorName && options.authorEmail
          ? { author: { name: options.authorName, email: options.authorEmail } }
          : {}),
      })
    )
  }

  // main now exists (pre-existing or just bootstrapped) — read it for base_tree.
  const mainRef = await withEmptyRepoRetry(() =>
    octokit.git.getRef({ owner: target.owner, repo: target.repo, ref: `heads/${MAIN_BRANCH}` })
  )
  const mainCommit = await withEmptyRepoRetry(() => octokit.git.getCommit({
    owner: target.owner,
    repo: target.repo,
    commit_sha: mainRef.data.object.sha,
  }))

  // Re-create each template blob in the target and collect tree entries. Safe
  // now that the repo has at least one commit.
  const treeEntries: { path: string; mode: BlobMode; type: 'blob'; sha: string }[] = []
  for (let i = 0; i < blobs.length; i += BLOB_COPY_CONCURRENCY) {
    const batch = blobs.slice(i, i + BLOB_COPY_CONCURRENCY)
    const copied = await Promise.all(
      batch.map(async (b) => {
        const content = await fetchTemplateBlobBase64(b.sha, b.path)
        const created = await withEmptyRepoRetry(() =>
          withRateLimitRetry(() =>
            octokit.git.createBlob({
              owner: target.owner,
              repo: target.repo,
              content,
              encoding: 'base64',
            })
          )
        )
        return { path: b.path, mode: normalizeMode(b.mode), type: 'blob' as const, sha: created.data.sha }
      })
    )
    treeEntries.push(...copied)
  }

  const newTree = await withRateLimitRetry(() =>
    octokit.git.createTree({
      owner: target.owner,
      repo: target.repo,
      base_tree: mainCommit.data.tree.sha,
      tree: treeEntries,
    })
  )
  const commit = await withRateLimitRetry(() =>
    octokit.git.createCommit({
      owner: target.owner,
      repo: target.repo,
      message: `Seed site from ${template.owner}/${template.repo}`,
      tree: newTree.data.sha,
      parents: [mainRef.data.object.sha],
      ...(options.authorName && options.authorEmail
        ? { author: { name: options.authorName, email: options.authorEmail } }
        : {}),
    })
  )
  await withRateLimitRetry(() =>
    octokit.git.updateRef({
      owner: target.owner,
      repo: target.repo,
      ref: `heads/${MAIN_BRANCH}`,
      sha: commit.data.sha,
    })
  )

  // The editor and the assembly push both work off the draft branch — make sure
  // it exists and carries the template now that main does.
  await bringDraftUpToMain(slug)

  return { seeded: true, fileCount: treeEntries.length, commitSha: commit.data.sha, skippedWorkflowFiles }
}
