import { describe, expect, it } from 'vitest'
import { pluginSupportsInlineImages, postFromRepoFile } from './feed-builder'
import { isAllowedAssetPath, assetUrlFor } from './assets'
import { verifyBearer, generateSiteSecret, type WordpressSite } from './sites'

const OPTS = { siteKey: 'acmetax', origin: 'https://app.example.com' }

// Mirrors the current resource-draft-generator output: JSON-quoted scalars,
// JSON-quoted inline tags array, a bare hero filename, and a trailing inline
// "## SEO & AIO Metadata" section that must not leak into the post body.
const POST = [
  '---',
  'title: "The New KPIs of Business | Acme Tax"',
  'slug: the-new-kpis',
  'date: 2026-08-20',
  'content_type: blog',
  'author: "Jane Doe"',
  'excerpt: "What actually moves the needle."',
  'image: kpis-header.jpg',
  'image_alt: "A dashboard of business metrics"',
  'tags: ["cfo", "small business"]',
  'meta_title: "The New KPIs"',
  'meta_description: "A guide to modern KPIs."',
  'target_keyword: "business kpis"',
  'secondary_keywords: ["metrics", "dashboards"]',
  'canonical_url: /resources/the-new-kpis',
  'schema_markup: "BlogPosting"',
  'answer_block: "KPIs are..."',
  '---',
  '',
  '## Why KPIs',
  '',
  'Year-round clarity for **growing** firms. See [our services](https://acme.tax/services).',
  '',
  '- First point',
  '- Second point',
  '',
  '## SEO & AIO Metadata',
  '',
  'meta_title: The New KPIs',
  'meta_description: A guide to modern KPIs.',
  '',
].join('\n')

describe('postFromRepoFile', () => {
  it('maps every field from a real-shaped post', () => {
    const post = postFromRepoFile('content/posts/the-new-kpis.md', POST, OPTS)
    expect(post).not.toBeNull()
    if (!post) return
    expect(post.slug).toBe('the-new-kpis')
    expect(post.title).toBe('The New KPIs of Business | Acme Tax')
    expect(post.excerpt).toBe('What actually moves the needle.')
    expect(post.author).toBe('Jane Doe')
    expect(post.content_type).toBe('blog')
    expect(post.canonical_url).toBe('/resources/the-new-kpis')
    expect(post.meta_title).toBe('The New KPIs')
    expect(post.meta_description).toBe('A guide to modern KPIs.')
  })

  it('parses JSON-quoted tags (which land in fields, not arrayFields)', () => {
    const post = postFromRepoFile('content/posts/the-new-kpis.md', POST, OPTS)
    expect(post?.tags).toEqual(['cfo', 'small business'])
  })

  it('normalizes a date-only value to GMT midnight', () => {
    const post = postFromRepoFile('content/posts/the-new-kpis.md', POST, OPTS)
    expect(post?.date_gmt).toBe('2026-08-20 00:00:00')
  })

  it('converts body to HTML and strips the SEO section', () => {
    const post = postFromRepoFile('content/posts/the-new-kpis.md', POST, OPTS)
    expect(post?.html).toContain('<h2>Why KPIs</h2>')
    expect(post?.html).toContain('<strong>growing</strong>')
    expect(post?.html).toContain('<a href="https://acme.tax/services">our services</a>')
    expect(post?.html).toContain('<ul>')
    // The SEO metadata section and its raw key lines must not appear.
    expect(post?.html).not.toContain('SEO &amp; AIO Metadata')
    expect(post?.html).not.toContain('A guide to modern KPIs')
  })

  it('converts a markdown table into a real HTML table', () => {
    const withTable = POST.replace('- Second point\n', '- Second point\n\n| Factor | Leasing |\n|---|---|\n| Cost | Lower |\n')
    const post = postFromRepoFile('content/posts/the-new-kpis.md', withTable, OPTS)
    expect(post?.html).toContain('<table class="rv-table">')
    expect(post?.html).toContain('<td>Lower</td>')
    expect(post?.html).not.toContain('|---|')
  })

  it('emits an authenticated proxy URL for a bare hero filename', () => {
    const post = postFromRepoFile('content/posts/the-new-kpis.md', POST, OPTS)
    expect(post?.hero_image).toEqual({
      url: 'https://app.example.com/api/wp-feed/acmetax/asset?path=public%2Fcontent-assets%2Fkpis-header.jpg',
      requires_auth: true,
      alt: 'A dashboard of business metrics',
      filename: 'kpis-header.jpg',
      sha: null,
    })
    expect(post?.inline_images).toEqual([])
  })

  it('carries the repo blob sha on the hero so an in-place replace changes it', () => {
    const shas = new Map([['kpis-header.jpg', 'abc123']])
    const post = postFromRepoFile('content/posts/the-new-kpis.md', POST, { ...OPTS, assetShas: shas })
    expect(post?.hero_image?.sha).toBe('abc123')
  })

  describe('body images', () => {
    const withBody = POST.replace(
      '- Second point\n',
      '- Second point\n\n![Team reviewing books](books.jpg)\n\n![Again](books.jpg)\n\n![Ext](https://images.pexels.com/e.jpg)\n\n![Gone](missing.jpg)\n'
    )
    const shas = new Map([
      ['kpis-header.jpg', 'h1'],
      ['books.jpg', 'b1'],
    ])

    it('rewrites local images to tagged proxy URLs and lists them once', () => {
      const post = postFromRepoFile('content/posts/x.md', withBody, {
        ...OPTS,
        assetShas: shas,
        inlineImages: true,
      })
      const proxy = 'https://app.example.com/api/wp-feed/acmetax/asset?path=public%2Fcontent-assets%2Fbooks.jpg'
      expect(post?.html).toContain(
        `<figure><img src="${proxy}" alt="Team reviewing books" data-rv-ref="books.jpg"></figure>`
      )
      expect(post?.html).toContain('<figure><img src="https://images.pexels.com/e.jpg" alt="Ext"></figure>')
      expect(post?.html).not.toContain('missing.jpg')
      expect(post?.inline_images).toEqual([
        { url: proxy, requires_auth: true, alt: 'Team reviewing books', filename: 'books.jpg', sha: 'b1' },
      ])
    })

    it('omits local body images for plugins that cannot rewrite them', () => {
      const post = postFromRepoFile('content/posts/x.md', withBody, { ...OPTS, assetShas: shas })
      expect(post?.html).not.toContain('books.jpg')
      expect(post?.html).not.toContain('api/wp-feed')
      expect(post?.inline_images).toEqual([])
    })
  })

  it('passes an absolute hero URL through without auth', () => {
    const withUrl = POST.replace('image: kpis-header.jpg', 'image: https://images.pexels.com/x.jpg')
    const post = postFromRepoFile('content/posts/x.md', withUrl, OPTS)
    expect(post?.hero_image?.requires_auth).toBe(false)
    expect(post?.hero_image?.url).toBe('https://images.pexels.com/x.jpg')
  })

  it('returns null hero when there is no image', () => {
    const noImg = POST.replace('image: kpis-header.jpg\n', '').replace(
      'image_alt: "A dashboard of business metrics"\n',
      ''
    )
    const post = postFromRepoFile('content/posts/x.md', noImg, OPTS)
    expect(post?.hero_image).toBeNull()
  })

  it('falls back to the filename slug + derived canonical when frontmatter has none', () => {
    const noSlug = POST.replace('slug: the-new-kpis\n', '').replace(
      'canonical_url: /resources/the-new-kpis\n',
      ''
    )
    const post = postFromRepoFile('content/posts/from-filename.md', noSlug, OPTS)
    expect(post?.slug).toBe('from-filename')
    expect(post?.canonical_url).toBe('/resources/from-filename')
  })

  it('skips a post flagged draft in frontmatter', () => {
    const draft = POST.replace('content_type: blog', 'content_type: blog\ndraft: true')
    expect(postFromRepoFile('content/posts/x.md', draft, OPTS)).toBeNull()
  })
})

describe('pluginSupportsInlineImages', () => {
  it('gates on 1.3.0', () => {
    expect(pluginSupportsInlineImages(null)).toBe(false)
    expect(pluginSupportsInlineImages('1.2.0')).toBe(false)
    expect(pluginSupportsInlineImages('1.3.0')).toBe(true)
    expect(pluginSupportsInlineImages('1.3')).toBe(true)
    expect(pluginSupportsInlineImages('1.10.0')).toBe(true)
    expect(pluginSupportsInlineImages('2.0.0')).toBe(true)
    expect(pluginSupportsInlineImages('junk')).toBe(false)
  })
})

describe('assetUrlFor + isAllowedAssetPath', () => {
  it('builds an encoded proxy URL', () => {
    expect(assetUrlFor('https://a.com', 'site', 'a b.jpg')).toBe(
      'https://a.com/api/wp-feed/site/asset?path=public%2Fcontent-assets%2Fa%20b.jpg'
    )
  })

  it('allows content-assets and og-images roots', () => {
    expect(isAllowedAssetPath('public/content-assets/x.jpg')).toBe('public/content-assets/x.jpg')
    expect(isAllowedAssetPath('public/og-images/x.png')).toBe('public/og-images/x.png')
  })

  it('rejects traversal, encoded traversal, and off-root paths', () => {
    expect(isAllowedAssetPath('public/content-assets/../../secret')).toBeNull()
    expect(isAllowedAssetPath('public%2Fcontent-assets%2F..%2F..%2Fsecret')).toBeNull()
    expect(isAllowedAssetPath('content/pages/home.md')).toBeNull()
    expect(isAllowedAssetPath('.env')).toBeNull()
  })
})

describe('verifyBearer (fail-closed)', () => {
  const site: WordpressSite = { key: 'live', github_repo: 'live-site', secret: 's3cret-token' }

  it('rejects when the stored secret is empty (never validates Bearer undefined)', () => {
    expect(verifyBearer('Bearer anything', { ...site, secret: '' })).toBe(false)
  })

  it('accepts the exact matching bearer', () => {
    expect(verifyBearer('Bearer s3cret-token', site)).toBe(true)
  })

  it('rejects a wrong or malformed header', () => {
    expect(verifyBearer('Bearer wrong', site)).toBe(false)
    expect(verifyBearer('s3cret-token', site)).toBe(false)
    expect(verifyBearer(null, site)).toBe(false)
  })
})

describe('generateSiteSecret', () => {
  it('produces a 48-char hex token', () => {
    const s = generateSiteSecret()
    expect(s).toMatch(/^[0-9a-f]{48}$/)
    expect(generateSiteSecret()).not.toBe(s)
  })
})

describe('categories in the feed', () => {
  const postWith = (ids: string) =>
    [
      '---',
      'title: T',
      'slug: t',
      'categories:',
      ...ids.split(',').map((i) => `  - ${i.trim()}`),
      '---',
      '',
      'Body',
      '',
    ].join('\n')

  it('keeps all ids when no known set is given', () => {
    const post = postFromRepoFile('content/posts/t.md', postWith('c-a, c-gone'), OPTS)
    expect(post?.categories).toEqual(['c-a', 'c-gone'])
  })

  it('filters ids to the known set', () => {
    const post = postFromRepoFile('content/posts/t.md', postWith('c-a, c-gone'), {
      ...OPTS,
      knownCategoryIds: new Set(['c-a', 'c-b']),
    })
    expect(post?.categories).toEqual(['c-a'])
  })
})
