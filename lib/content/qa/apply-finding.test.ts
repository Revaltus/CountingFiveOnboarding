import { describe, it, expect } from 'vitest'
import { applyOneFinding, applyOpenAutoFindings } from './apply-finding'
import type { QaReview } from '@/types/qa-review'

const fields = { body: 'We have served Austin since 1998.\n', metaTitle: 't', metaDescription: 'd' }
const review: QaReview = {
  mode: 'on', ran_at: 't', judge: null, passed: false, scores: { accuracy: 7, copy: 10, seo: 10, structure: 10 },
  findings: [{ id: 'f1', agent: 'accuracy', severity: 'high', kind: 'unsupported_claim', quote: 'since 1998', message: 'm',
    patch: { target: 'body', find: 'We have served Austin since 1998.', replace: 'We serve Austin.' }, safety: 'flag', status: 'open' }],
}

describe('applyOneFinding', () => {
  it('applies a flagged patch on request and rescores', () => {
    const r = applyOneFinding(fields, review, 'f1', 'apply', [])
    if (!r.ok) throw new Error(r.error)
    expect(r.fields.body).toBe('We serve Austin.\n')
    expect(r.review.findings[0].status).toBe('accepted')
    expect(r.review.scores.accuracy).toBe(10)
    expect(r.review.passed).toBe(true)
    expect(r.review.rev).toBe(1)
  })
  it('dismisses without touching content', () => {
    const r = applyOneFinding(fields, review, 'f1', 'dismiss', [])
    if (!r.ok) throw new Error(r.error)
    expect(r.fields).toEqual(fields)
    expect(r.review.findings[0].status).toBe('dismissed')
    expect(r.review.rev).toBe(1)
  })
  it('bumps an existing rev rather than resetting it', () => {
    const r = applyOneFinding(fields, { ...review, rev: 3 }, 'f1', 'dismiss', [])
    if (!r.ok) throw new Error(r.error)
    expect(r.review.rev).toBe(4)
  })
  it('errors when the target text has changed', () => {
    const r = applyOneFinding({ ...fields, body: 'Edited by a human.\n' }, review, 'f1', 'apply', [])
    expect(r.ok).toBe(false)
  })
  it('errors on an unknown or already-handled finding', () => {
    expect(applyOneFinding(fields, review, 'nope', 'apply', []).ok).toBe(false)
  })
  it('refuses a body patch that touches protected verbatim text', () => {
    const r = applyOneFinding(fields, review, 'f1', 'apply', [fields.body])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/word-for-word/)
  })
  it('refuses a patch that only partly overlaps a protected span', () => {
    const r = applyOneFinding(fields, review, 'f1', 'apply', ['since 1998.'])
    expect(r.ok).toBe(false)
  })
  it('still applies a meta patch on a fully protected (verbatim) page', () => {
    const meta: QaReview = { ...review, findings: [{ ...review.findings[0], id: 'm1', patch: { target: 'meta_title', find: 't', replace: 'Better title' } }] }
    const r = applyOneFinding(fields, meta, 'm1', 'apply', [fields.body])
    if (!r.ok) throw new Error(r.error)
    expect(r.fields.metaTitle).toBe('Better title')
    expect(r.fields.body).toBe(fields.body)
  })
})

describe('applyOpenAutoFindings', () => {
  const body = 'Intro line here.\n\nWe help clients a lot.\n\nJane Doe bio text stays.\n'
  const base: QaReview = {
    mode: 'shadow', ran_at: 't', judge: null, passed: false, scores: { accuracy: 10, copy: 7, seo: 10, structure: 10 },
    rev: 2,
    findings: [
      { id: 'a1', agent: 'copy', severity: 'low', kind: 'generic_phrasing', quote: '', message: 'm', safety: 'auto', status: 'open',
        patch: { target: 'body', find: 'We help clients a lot.', replace: 'We file returns for 400 households.' } },
      { id: 'a2', agent: 'copy', severity: 'low', kind: 'voice', quote: '', message: 'm', safety: 'auto', status: 'open',
        patch: { target: 'body', find: 'Jane Doe bio text stays.', replace: 'Rewritten bio.' } },
      { id: 'a3', agent: 'seo', severity: 'low', kind: 'meta_description', quote: '', message: 'm', safety: 'auto', status: 'open',
        patch: { target: 'meta_description', find: 'd', replace: 'A better description.' } },
      { id: 'f1', agent: 'accuracy', severity: 'high', kind: 'unsupported_claim', quote: '', message: 'm', safety: 'flag', status: 'open',
        patch: { target: 'body', find: 'Intro line here.', replace: 'Changed.' } },
      { id: 'd1', agent: 'copy', severity: 'low', kind: 'typo', quote: '', message: 'm', safety: 'auto', status: 'dismissed',
        patch: { target: 'body', find: 'Intro', replace: 'Opening' } },
      { id: 'n1', agent: 'copy', severity: 'low', kind: 'long_paragraph', quote: '', message: 'm', safety: 'auto', status: 'open' },
    ],
  }
  const r = applyOpenAutoFindings({ body, metaTitle: 't', metaDescription: 'd' }, base, ['Jane Doe bio text stays.'])
  const byId = Object.fromEntries(r.review.findings.map(f => [f.id, f]))

  it('applies open auto fixes to body and meta', () => {
    expect(r.fields.body).toContain('We file returns for 400 households.')
    expect(r.fields.metaDescription).toBe('A better description.')
    expect(byId.a1.status).toBe('accepted')
    expect(byId.a3.status).toBe('accepted')
    expect(r.applied.map(f => f.id).sort()).toEqual(['a1', 'a3'])
  })
  it('never touches protected text — that finding becomes an open flag', () => {
    expect(r.fields.body).toContain('Jane Doe bio text stays.')
    expect(byId.a2).toMatchObject({ status: 'open', safety: 'flag' })
    expect(r.failed.map(f => f.id)).toEqual(['a2'])
  })
  it('leaves flags, dismissed findings and fix-less findings alone', () => {
    expect(r.fields.body).toContain('Intro line here.')
    expect(byId.f1.status).toBe('open')
    expect(byId.d1.status).toBe('dismissed')
    expect(byId.n1).toEqual(base.findings[5])
  })
  it('bumps rev once and rescores', () => {
    expect(r.review.rev).toBe(3)
    expect(r.review.scores.copy).toBeGreaterThanOrEqual(base.scores.copy)
  })
  it('is a no-op when nothing is open + auto', () => {
    const onlyFlag: QaReview = { ...base, findings: [base.findings[3]] }
    const none = applyOpenAutoFindings({ body, metaTitle: 't', metaDescription: 'd' }, onlyFlag, [])
    expect(none.review).toBe(onlyFlag)
    expect(none.applied).toEqual([])
    expect(none.fields.body).toBe(body)
  })
})
