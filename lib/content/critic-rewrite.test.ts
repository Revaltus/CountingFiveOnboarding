import { afterEach, describe, expect, it, vi } from 'vitest'
import { criticTimeoutFor, CRITIC_CALL_CAP_MS } from './draft-critic'
import {
  rewritePageForCritic,
  type GeneratedResult,
  type PageGenContext,
  type CriticRewriteDeps,
} from './content-generator'
import { RESERVE_MS } from './generation-budget'

type Filter = [op: string, column: string, value: unknown]
type Recorded = { table: string; values: Record<string, unknown>; filters: Filter[] }

// Minimal chainable Supabase stand-in: `.single()` reads return the configured
// row per table; an `.update(...).eq(...).select()` resolves to `updateRows`.
function makeSupabase(rows: Record<string, unknown>, updateRows: Array<{ id: string }> = [{ id: 'page-1' }]) {
  const updates: Recorded[] = []
  const from = (table: string) => {
    const state: { values: Record<string, unknown> | null; filters: Filter[] } = { values: null, filters: [] }
    const api = {
      select: () => api,
      update: (values: Record<string, unknown>) => {
        state.values = values
        return api
      },
      eq: (column: string, value: unknown) => {
        state.filters.push(['eq', column, value])
        return api
      },
      is: (column: string, value: unknown) => {
        state.filters.push(['is', column, value])
        return api
      },
      single: async () => ({ data: rows[table] ?? null, error: null }),
      then: (resolve: (v: { data: unknown; error: null }) => unknown) => {
        if (state.values) {
          updates.push({ table, values: state.values, filters: state.filters })
          return Promise.resolve(resolve({ data: updateRows, error: null }))
        }
        return Promise.resolve(resolve({ data: rows[table] ?? null, error: null }))
      },
    }
    return api
  }
  return { supabase: { from } as unknown as NonNullable<CriticRewriteDeps['supabase']>, updates }
}

const completePage = {
  id: 'page-1',
  generation_status: 'complete',
  generation_started_at: '2026-09-25T10:00:00.000Z',
  admin_approved_content: false,
  generation_attempts: 1,
}
const outline = {
  id: 'outline-1',
  page_url: '/services/tax',
  page_title: 'Tax',
  sections: [{ heading: 'Intro', word_count: 200 }],
  target_keyword: 'tax',
  admin_approved: true,
  cta: null,
  angle: null,
}
const ctx: PageGenContext = {
  sessionId: 'session-1',
  websiteUrl: 'https://example.com',
  schema: {},
  palette: null,
  sitemapUrls: [],
  researchByUrl: new Map(),
}
const loadContext = async () => ctx

function goodResult(overrides: Partial<GeneratedResult> = {}): GeneratedResult {
  return {
    content: 'A better page body.',
    metadata: {
      meta_title: 't', meta_description: 'd', target_keyword: 'tax', secondary_keywords: [],
      url_slug: 'tax', canonical_url: 'https://example.com/services/tax', answer_block: 'a',
      schema_markup_type: 'Service', eeat_signals: [], internal_links: [], faq_block: [], faq_heading: null,
      llm_citation_note: '', hero_block: '', hero_variant: null, hero_image: null,
      hero_image_alt: null, hero_subhead: null, hero_image_query: null,
    },
    ...overrides,
  }
}

const args = {
  contentJobId: 'job-1',
  outlineId: 'outline-1',
  pageId: 'page-1',
  revisionGuidance: 'fix it',
  deadlineAt: Date.now() + 300_000,
}

describe('rewritePageForCritic', () => {
  it('keeps the original complete page when the rewrite throws (e.g. a timeout)', async () => {
    const { supabase, updates } = makeSupabase({ generated_pages: completePage, page_outlines: outline })
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    const res = await rewritePageForCritic(args, {
      supabase,
      loadContext,
      generate: async () => { throw timeout },
    })
    expect(res.status).toBe('error')
    // No write at all: status stays 'complete', body stays the approved copy.
    expect(updates).toHaveLength(0)
  })

  it('keeps the original page when the rewrite comes back degraded (raw JSON never replaces it)', async () => {
    const { supabase, updates } = makeSupabase({ generated_pages: completePage, page_outlines: outline })
    const res = await rewritePageForCritic(args, {
      supabase,
      loadContext,
      generate: async () => goodResult({ content: '{"content": "trunc', degraded: true }),
    })
    expect(res.status).toBe('error')
    expect(updates).toHaveLength(0)
  })

  it('writes a clean rewrite fenced on the snapshot, without touching generation_status', async () => {
    const { supabase, updates } = makeSupabase({ generated_pages: completePage, page_outlines: outline })
    const res = await rewritePageForCritic(args, { supabase, loadContext, generate: async () => goodResult() })
    expect(res.status).toBe('complete')
    expect(updates).toHaveLength(1)
    const [u] = updates
    expect(u.table).toBe('generated_pages')
    expect(u.values.content_markdown).toBe('A better page body.')
    expect(u.values).not.toHaveProperty('generation_status')
    expect(u.filters).toEqual(
      expect.arrayContaining([
        ['eq', 'id', 'page-1'],
        ['eq', 'generation_status', 'complete'],
        ['eq', 'admin_approved_content', false],
        ['eq', 'generation_started_at', completePage.generation_started_at],
      ])
    )
  })

  it('reports skipped when the page changed during the rewrite (fence matched nothing)', async () => {
    const { supabase } = makeSupabase({ generated_pages: completePage, page_outlines: outline }, [])
    const res = await rewritePageForCritic(args, { supabase, loadContext, generate: async () => goodResult() })
    expect(res.status).toBe('skipped')
  })

  it('does not rewrite a page that is no longer complete, or was approved meanwhile', async () => {
    const generate = vi.fn(async () => goodResult())
    for (const page of [
      { ...completePage, generation_status: 'running' },
      { ...completePage, admin_approved_content: true },
    ]) {
      const { supabase, updates } = makeSupabase({ generated_pages: page, page_outlines: outline })
      const res = await rewritePageForCritic(args, { supabase, loadContext, generate })
      expect(res.status).toBe('skipped')
      expect(updates).toHaveLength(0)
    }
    expect(generate).not.toHaveBeenCalled()
  })
})

describe('rewritePageForCritic — QA re-queue (I5)', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('re-queues QA in the same fenced write and schedules a trigger after it lands', async () => {
    vi.stubEnv('CONTENT_QA_MODE', 'shadow')
    const { supabase, updates } = makeSupabase({ generated_pages: completePage, page_outlines: outline })
    const scheduleQa = vi.fn()
    const res = await rewritePageForCritic(args, { supabase, loadContext, generate: async () => goodResult(), scheduleQa })
    expect(res.status).toBe('complete')
    expect(updates).toHaveLength(1)
    expect(updates[0].values).toMatchObject({ qa_status: 'queued', qa_review: null, qa_attempts: 0 })
    expect(scheduleQa).toHaveBeenCalledWith('job-1', 'page-1')
  })

  it('clears QA (null status) and schedules nothing when QA is off', async () => {
    vi.stubEnv('CONTENT_QA_MODE', 'off')
    const { supabase, updates } = makeSupabase({ generated_pages: completePage, page_outlines: outline })
    const scheduleQa = vi.fn()
    await rewritePageForCritic(args, { supabase, loadContext, generate: async () => goodResult(), scheduleQa })
    expect(updates[0].values).toMatchObject({ qa_status: null, qa_review: null, qa_attempts: 0 })
    expect(scheduleQa).not.toHaveBeenCalled()
  })

  it('does not schedule QA when the fenced write matched nothing', async () => {
    vi.stubEnv('CONTENT_QA_MODE', 'shadow')
    const { supabase } = makeSupabase({ generated_pages: completePage, page_outlines: outline }, [])
    const scheduleQa = vi.fn()
    expect((await rewritePageForCritic(args, { supabase, loadContext, generate: async () => goodResult(), scheduleQa })).status).toBe('skipped')
    expect(scheduleQa).not.toHaveBeenCalled()
  })
})

describe('criticTimeoutFor', () => {
  const now = 1_000_000
  it('caps the critic call at the normal ceiling when plenty of time is left', () => {
    expect(criticTimeoutFor(now + 400_000, now)).toBe(CRITIC_CALL_CAP_MS)
  })

  it('clips the call to end before the function is killed (deadline + reserve)', () => {
    // Page finished right at its work deadline: only the reserve is left.
    const t = criticTimeoutFor(now, now)
    expect(t).not.toBeNull()
    expect(t as number).toBeLessThan(RESERVE_MS)
  })

  it('skips the critic when too little invocation time is left', () => {
    expect(criticTimeoutFor(now - RESERVE_MS, now)).toBeNull()
  })
})
