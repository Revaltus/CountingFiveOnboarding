import { NextResponse } from 'next/server'
import { internalError } from '@/lib/api/errors'
import { DEFAULT_COMMIT_AUTHOR } from '@/lib/github/commit-identity'
import { resolveEditContext } from '../_helpers'
import { safePath } from '../_path'
import { readJsonBody } from '@/app/api/_json'
import { createServerClient } from '@/lib/supabase/server'
import { checkChatSpendLimit } from '@/lib/ai/chat-spend-limit'
import { loadNoGoPhrases } from '@/lib/content/no-go-phrases'
import { readDraftTemplateVersion } from '@/lib/design/capabilities-read'
import { contentPathToUrl } from '@/lib/editor/content-paths'
import { isVerbatimPage } from '@/lib/content/verbatim-guard'
import { proposalErrors, proposeRestructure, type RestructureProposeResponse } from '@/lib/content/restructure-page'
import { reviewContentEdit } from '@/lib/content/content-edit-review'
import { diffLines } from '@/lib/design/design-md-adopt'
import {
  DRAFT_BRANCH,
  FileNotFoundError,
  StaleShaError,
  ensureDraftBranch,
  listPathCommitMessages,
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
}

interface AcceptBody {
  action: 'accept'
  path?: string
  proposed?: string
  expectedSha?: string
}

type RestructureBody = ProposeBody | AcceptBody

// POST { path } — propose a restructure (writes nothing).
// POST { action: 'accept', path, proposed, expectedSha } — commit it to draft.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now()
  const { id } = await params
  const ctx = await resolveEditContext(id)
  if (ctx instanceof NextResponse) return ctx

  const body = await readJsonBody<RestructureBody>(req)
  if (body instanceof NextResponse) return body
  const path = body.path ? safePath(body.path) : null
  if (!path || !PAGE_MD_RE.test(path)) {
    return NextResponse.json({ error: 'Open a page to restructure it' }, { status: 400 })
  }
  const url = contentPathToUrl(path)
  if (!url) return NextResponse.json({ error: 'Open a page to restructure it' }, { status: 400 })

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
    const [current, templateVersion, noGo] = await Promise.all([
      readFile(ctx.githubRepo, path, DRAFT_BRANCH),
      readDraftTemplateVersion(ctx.githubRepo),
      loadNoGoPhrases(),
    ])
    const noGoPhrases = noGo.map((p) => p.phrase)

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
        `Restructure ${path.split('/').pop()} via AI${ctx.adminEmail ? ` (${ctx.adminEmail})` : ''}`,
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

    // Hand edits ("via admin" saves) are worth a warning before a whole-page
    // rewrite. Best-effort: an unreadable history just skips the notice.
    const handEdited = listPathCommitMessages(ctx.githubRepo, path, DRAFT_BRANCH)
      .then((msgs) => msgs.some((m) => /\bvia admin\b/i.test(m)))
      .catch(() => false)

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
      handEdited: await handEdited,
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
