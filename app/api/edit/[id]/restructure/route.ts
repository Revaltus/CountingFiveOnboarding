import { NextResponse } from 'next/server'
import { internalError } from '@/lib/api/errors'
import { DEFAULT_COMMIT_AUTHOR } from '@/lib/github/commit-identity'
import { resolveEditContext, type EditContext } from '../_helpers'
import { safePath } from '../_path'
import { readJsonBody } from '@/app/api/_json'
import { isSiteOwner } from '@/lib/auth/access'
import { createServerClient } from '@/lib/supabase/server'
import { checkChatSpendLimit } from '@/lib/ai/chat-spend-limit'
import { loadNoGoPhrases } from '@/lib/content/no-go-phrases'
import { readDraftTemplateVersion } from '@/lib/design/capabilities-read'
import { contentPathToUrl } from '@/lib/editor/content-paths'
import { isVerbatimPage } from '@/lib/content/verbatim-guard'
import {
  RESTRUCTURE_COMMIT_PREFIX,
  proposalErrors,
  proposeRestructure,
  restructureStatus,
  type RestructureProposeResponse,
  type RestructureStatus,
} from '@/lib/content/restructure-page'
import { reviewContentEdit } from '@/lib/content/content-edit-review'
import { diffLines } from '@/lib/design/design-md-adopt'
import {
  DRAFT_BRANCH,
  FileNotFoundError,
  StaleShaError,
  ensureDraftBranch,
  listPathCommits,
  readFile,
  writeFile,
} from '@/lib/github/repo-files'
import type { SessionSchema } from '@/types/session-schema'

export const runtime = 'nodejs'
// One high-quality rewrite of a whole page plus a possible corrective retry.
export const maxDuration = 300

const PAGE_MD_RE = /^content\/(?:drafts\/)?pages\/[^/]+\.md$/
const DEADLINE_MS = 280_000

interface ProposeBody {
  action?: 'propose'
  path?: string
  // Admin-only: restructure a page that was already restructured.
  override?: boolean
}

interface AcceptBody {
  action: 'accept'
  path?: string
  proposed?: string
  expectedSha?: string
  override?: boolean
}

type RestructureBody = ProposeBody | AcceptBody

type PageTarget = { ctx: EditContext; path: string; url: string }

// Gate + path validation shared by GET and POST. A whole-page AI rewrite has
// the same boundary as the per-page AI editor (chat route): staff admins and
// Site Owners only, not managers/editors.
async function resolveTarget(id: string, rawPath: string | null | undefined): Promise<PageTarget | NextResponse> {
  const ctx = await resolveEditContext(id)
  if (ctx instanceof NextResponse) return ctx
  if (!(ctx.user.isAdmin || isSiteOwner(ctx.user))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const path = rawPath ? safePath(rawPath) : null
  const url = path && PAGE_MD_RE.test(path) ? contentPathToUrl(path) : null
  if (!path || !url) return NextResponse.json({ error: 'Open a page to restructure it' }, { status: 400 })
  return { ctx, path, url }
}

function alreadyRestructured(s: RestructureStatus): NextResponse {
  return NextResponse.json(
    {
      error: `This page was already restructured${s.at ? ` on ${s.at.slice(0, 10)}` : ''}. An admin can run it again.`,
      restructured: true,
    },
    { status: 409 },
  )
}

// GET ?path= — has this page already been restructured? (drives the button)
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const target = await resolveTarget(id, new URL(req.url).searchParams.get('path'))
  if (target instanceof NextResponse) return target
  try {
    const status = restructureStatus(await listPathCommits(target.ctx.githubRepo, target.path, DRAFT_BRANCH))
    return NextResponse.json(status)
  } catch (err) {
    return internalError('edit:restructure:status', err, "Couldn't check the page's history")
  }
}

// POST { path, override? } — propose a restructure (writes nothing).
// POST { action: 'accept', path, proposed, expectedSha, override? } — commit it to draft.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now()
  const { id } = await params
  const body = await readJsonBody<RestructureBody>(req)
  if (body instanceof NextResponse) return body
  const target = await resolveTarget(id, body.path)
  if (target instanceof NextResponse) return target
  const { ctx, path, url } = target
  if (body.override && !ctx.user.isAdmin) {
    return NextResponse.json({ error: 'Only an admin can restructure a page again.' }, { status: 403 })
  }

  const supabase = createServerClient()
  const { data: session, error: sessionErr } = await supabase
    .from('sessions')
    .select('schema_data')
    .eq('id', ctx.sessionId)
    .single()
  if (sessionErr || !session) return internalError('edit:restructure', sessionErr, "Couldn't load the site")
  const schema = (session.schema_data ?? {}) as SessionSchema
  if (isVerbatimPage(schema, url)) {
    return NextResponse.json(
      { error: "This page is the client's own wording, kept word-for-word at their request, so it can't be restructured." },
      { status: 422 },
    )
  }

  try {
    await ensureDraftBranch(ctx.githubRepo)
    const [current, templateVersion, noGo, commits] = await Promise.all([
      readFile(ctx.githubRepo, path, DRAFT_BRANCH),
      readDraftTemplateVersion(ctx.githubRepo),
      loadNoGoPhrases(),
      listPathCommits(ctx.githubRepo, path, DRAFT_BRANCH),
    ])
    const noGoPhrases = noGo.map((p) => p.phrase)
    // One restructure per page (the approved shape stays put); admins may override.
    const status = restructureStatus(commits)
    if (status.restructured && !body.override) return alreadyRestructured(status)

    if (body.action === 'accept') {
      const { proposed, expectedSha } = body
      if (typeof proposed !== 'string' || typeof expectedSha !== 'string') {
        return NextResponse.json({ error: 'proposed and expectedSha required' }, { status: 400 })
      }
      if (current.sha !== expectedSha) {
        return NextResponse.json(
          { error: 'This page changed since the proposal was made. Close and restructure again.' },
          { status: 409 },
        )
      }
      // Same gates the proposal passed, re-run on what the client sent back.
      const errors = proposalErrors(current.content, proposed, { templateVersion, noGoPhrases })
      if (errors.length) return NextResponse.json({ error: errors[0] }, { status: 422 })
      const result = await writeFile(
        ctx.githubRepo,
        path,
        proposed,
        DRAFT_BRANCH,
        `${RESTRUCTURE_COMMIT_PREFIX}${path.split('/').pop()} via AI${ctx.adminEmail ? ` (${ctx.adminEmail})` : ''}`,
        {
          expectedSha,
          authorName: ctx.adminName ?? DEFAULT_COMMIT_AUTHOR.name,
          authorEmail: ctx.adminEmail ?? DEFAULT_COMMIT_AUTHOR.email,
        },
      )
      reviewContentEdit(ctx.sessionId, path, proposed)
      return NextResponse.json(result)
    }

    const overLimit = await checkChatSpendLimit(supabase, ctx.user)
    if (overLimit) return overLimit

    const outcome = await proposeRestructure({
      file: current.content,
      path,
      url,
      schema,
      noGoPhrases,
      templateVersion,
      sessionId: ctx.sessionId,
      userId: ctx.user.id,
      deadlineAt: startedAt + DEADLINE_MS,
    })
    if (!outcome.ok) {
      return NextResponse.json(
        {
          error:
            outcome.reason === 'invalid'
              ? `The AI's proposal didn't pass the page checks: ${outcome.details[0]}`
              : "The AI couldn't produce a proposal. Try again.",
        },
        { status: outcome.reason === 'invalid' ? 422 : 502 },
      )
    }
    const p = outcome.proposal
    const response: RestructureProposeResponse = {
      current: current.content,
      currentSha: current.sha,
      proposed: p.proposed,
      metrics: { before: p.before, after: p.after },
      violationsBefore: p.violationsBefore,
      violationsAfter: p.violationsAfter,
      diff: diffLines(current.content, p.proposed),
      // Hand edits ("via admin" saves) are worth a warning before a whole-page rewrite.
      handEdited: commits.some((c) => /\bvia admin\b/i.test(c.message)),
      coverage: p.coverage,
      budget: p.budget,
    }
    return NextResponse.json(response)
  } catch (err) {
    if (err instanceof FileNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 })
    if (err instanceof StaleShaError) {
      return NextResponse.json(
        { error: 'This page changed since the proposal was made. Close and restructure again.' },
        { status: 409 },
      )
    }
    return internalError('edit:restructure', err, "Couldn't restructure the page")
  }
}
