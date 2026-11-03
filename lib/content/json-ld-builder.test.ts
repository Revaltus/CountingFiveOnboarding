import { describe, expect, it } from 'vitest'
import { buildJsonLdForPage } from './json-ld-builder'
import type { Database } from '@/types/database'
import type { SessionSchema } from '@/types/session-schema'

type GeneratedPage = Database['public']['Tables']['generated_pages']['Row']

function makePage(overrides: Partial<GeneratedPage>): GeneratedPage {
  return {
    admin_approved_content: true,
    answer_block: null,
    canonical_url: null,
    client_approved_content: false,
    content_job_id: 'job-1',
    content_markdown: '## Overview\n\nBody.',
    created_at: '2026-01-01T00:00:00Z',
    critic_review: null,
    eeat_signals: null,
    faq_block: null,
    faq_heading: null,
    generation_attempts: 0,
    generation_error: null,
    generation_started_at: null,
    generation_status: 'complete',
    hero_block: 'page-header',
    hero_image: null,
    hero_image_alt: null,
    hero_image_query: null,
    hero_subhead: null,
    hero_variant: null,
    id: 'page-1',
    internal_links: null,
    llm_citation_note: null,
    meta_description: null,
    meta_title: null,
    needs_client_review: false,
    page_title: 'Home',
    page_url: '/',
    qa_attempts: 0,
    qa_review: null,
    qa_started_at: null,
    qa_status: null,
    schema_markup_type: null,
    secondary_keywords: null,
    target_keyword: null,
    url_slug: null,
    word_count_actual: null,
    word_count_target: null,
    ...overrides,
  }
}

// buildJsonLdForPage returns joined <script> blocks. Pull the parsed objects out.
function parseNodes(scripts: string): Record<string, unknown>[] {
  const re = /<script type="application\/ld\+json">\n([\s\S]*?)\n<\/script>/g
  const out: Record<string, unknown>[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(scripts)) !== null) out.push(JSON.parse(m[1]))
  return out
}

const node = (scripts: string, type: string) =>
  parseNodes(scripts).find((n) => n['@type'] === type)

const nodes = (scripts: string, type: string) =>
  parseNodes(scripts).filter((n) => n['@type'] === type)

const baseLocation = {
  name: '', street: '1 Main St', line2: '', city: 'Bel Air', state: 'MD',
  zip: '21014', phone: '410-555-1212', fax: '', email: '', hours: {},
}

const inputs = (schema: SessionSchema) => ({
  schema,
  websiteUrl: 'https://firm.com',
  page: makePage({ page_url: '/', page_title: 'Home' }),
  sitemap: [{ url: '/', title: 'Home', status: 'existing' }],
})

describe('buildJsonLdForPage — local business enrichment', () => {
  it('emits openingHours, geo, priceRange, gbp sameAs and structured areaServed', () => {
    const scripts = buildJsonLdForPage(
      inputs({
        business: {
          name: 'Firm', priceRange: '$$',
          serviceAreas: [
            { city: 'Bel Air', county: 'Harford County', state: 'MD', primary: true },
            { county: 'Baltimore County', state: 'MD' },
          ],
        } as SessionSchema['business'],
        locations: [
          {
            ...baseLocation,
            openingHours: [{ dayOfWeek: ['Monday', 'Tuesday'], opens: '09:00', closes: '17:00' }],
            geo: { lat: 39.53, lng: -76.34 },
            gbpUrl: 'https://g.page/firm',
          },
        ],
      })
    )
    const biz = node(scripts, 'AccountingService') as Record<string, unknown>
    expect(biz).toBeTruthy()

    const areas = biz.areaServed as Array<{ '@type': string; name: string }>
    expect(areas).toEqual([
      { '@type': 'City', name: 'Bel Air, Harford County, MD' },
      { '@type': 'AdministrativeArea', name: 'Baltimore County, MD' },
    ])

    const hours = biz.openingHoursSpecification as Array<Record<string, unknown>>
    expect(hours[0]).toMatchObject({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: ['Monday', 'Tuesday'],
      opens: '09:00',
      closes: '17:00',
    })

    expect(biz.geo).toMatchObject({ '@type': 'GeoCoordinates', latitude: 39.53, longitude: -76.34 })
    expect(biz.priceRange).toBe('$$')
    expect(biz.sameAs).toEqual(['https://g.page/firm'])
  })

  it('falls back to free-text geographicScope when serviceAreas is absent', () => {
    const scripts = buildJsonLdForPage(
      inputs({
        business: { name: 'Firm', geographicScope: 'Central Maryland' } as SessionSchema['business'],
        locations: [baseLocation],
      })
    )
    const biz = node(scripts, 'AccountingService') as Record<string, unknown>
    expect(biz.areaServed).toBe('Central Maryland')
    expect(biz).not.toHaveProperty('openingHoursSpecification')
    expect(biz).not.toHaveProperty('geo')
  })
})

describe('buildJsonLdForPage — team Person nodes (E-E-A-T)', () => {
  const teamSchema: SessionSchema = {
    business: { name: 'Firm' } as SessionSchema['business'],
    team: [
      {
        name: 'Jane Doe',
        title: 'Managing Partner',
        certifications: ['CPA', 'PFS'],
        bio: 'Twenty years of tax experience.',
        specializations: ['Tax planning'],
        expertise: ['Estate planning', 'Tax planning'],
        education: 'University of Maryland',
      },
      {
        name: 'John Roe',
        title: '',
        certifications: [],
        bio: '',
        specializations: [],
      },
    ],
  }

  it('emits a Person node per team member on an about/team page', () => {
    const scripts = buildJsonLdForPage({
      schema: teamSchema,
      websiteUrl: 'https://firm.com',
      page: makePage({ page_url: '/about', page_title: 'About' }),
      sitemap: [{ url: '/about', title: 'About', status: 'existing' }],
    })
    const people = nodes(scripts, 'Person')
    expect(people).toHaveLength(2)

    const jane = people.find((p) => p.name === 'Jane Doe') as Record<string, unknown>
    expect(jane.jobTitle).toBe('Managing Partner')
    expect(jane.description).toBe('Twenty years of tax experience.')
    expect(jane.worksFor).toEqual({
      '@type': 'Organization',
      name: 'Firm',
      url: 'https://firm.com',
    })
    expect(jane.hasCredential).toEqual([
      { '@type': 'EducationalOccupationalCredential', credentialCategory: 'CPA' },
      { '@type': 'EducationalOccupationalCredential', credentialCategory: 'PFS' },
    ])
    // specializations + expertise fold into knowsAbout, deduped.
    expect(jane.knowsAbout).toEqual(['Tax planning', 'Estate planning'])
    expect(jane.alumniOf).toEqual({
      '@type': 'EducationalOrganization',
      name: 'University of Maryland',
    })

    // Empty-source fields are omitted entirely.
    const john = people.find((p) => p.name === 'John Roe') as Record<string, unknown>
    expect(john).not.toHaveProperty('jobTitle')
    expect(john).not.toHaveProperty('description')
    expect(john).not.toHaveProperty('hasCredential')
    expect(john).not.toHaveProperty('knowsAbout')
    expect(john).not.toHaveProperty('alumniOf')
  })

  it('does not emit Person nodes on a non-team page', () => {
    const scripts = buildJsonLdForPage({
      schema: teamSchema,
      websiteUrl: 'https://firm.com',
      page: makePage({ page_url: '/services', page_title: 'Services' }),
      sitemap: [{ url: '/services', title: 'Services', status: 'existing' }],
    })
    expect(nodes(scripts, 'Person')).toHaveLength(0)
  })

  it('emits no Person nodes when the team is empty', () => {
    const scripts = buildJsonLdForPage({
      schema: { business: { name: 'Firm' } as SessionSchema['business'], team: [] },
      websiteUrl: 'https://firm.com',
      page: makePage({ page_url: '/team', page_title: 'Team' }),
      sitemap: [{ url: '/team', title: 'Team', status: 'existing' }],
    })
    expect(nodes(scripts, 'Person')).toHaveLength(0)
  })
})

describe('buildJsonLdForPage with dirty schema shapes', () => {
  it('survives serviceAreas stored as a string and falls back to geographicScope', () => {
    // Berg: "p.map is not a function" on Assemble & push to draft. The string's
    // truthy .length passed the `if (areas.length)` guard, then .map threw.
    const schema = {
      business: {
        name: 'Berg Advisors',
        serviceAreas: 'Nationwide, International',
        geographicScope: 'Virtual firm serving clients nationwide',
      },
      locations: [{ name: 'Main', city: 'Newtown Square', state: 'PA', street: '18 Campus Blvd' }],
    } as unknown as SessionSchema

    const out = buildJsonLdForPage({
      schema,
      websiteUrl: 'https://www.bergpartners.com',
      page: makePage({ page_url: '/', page_title: 'Home' }),
      sitemap: [{ url: '/', title: 'Home', status: 'update' }],
    })
    expect(out).toContain('Virtual firm serving clients nationwide')
    expect(out).not.toContain('"areaServed":"Nationwide, International"')
  })

  it('survives null holes in locations', () => {
    const schema = {
      business: { name: 'Berg Advisors' },
      locations: [null, { name: 'Main', city: 'Newtown Square', state: 'PA' }],
    } as unknown as SessionSchema
    const out = buildJsonLdForPage({
      schema,
      websiteUrl: 'https://www.bergpartners.com',
      page: makePage({ page_url: '/', page_title: 'Home' }),
      sitemap: [{ url: '/', title: 'Home', status: 'update' }],
    })
    expect(out).toContain('Newtown Square')
  })
})

describe('buildJsonLdForPage — Organization node', () => {
  it('emits no logo (the template layout carries the real brand.json logo), never the old /logo.png', () => {
    const scripts = buildJsonLdForPage(inputs({ business: { name: 'Firm' } } as SessionSchema))
    const org = node(scripts, 'Organization') as Record<string, unknown>
    expect(org).toMatchObject({ name: 'Firm', url: 'https://firm.com' })
    expect(org.logo).toBeUndefined()
    expect(scripts).not.toContain('/logo.png')
  })
})
