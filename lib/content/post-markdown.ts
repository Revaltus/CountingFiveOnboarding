import type { ContentType } from './content-types'
import { stripGeneratorNotesFromBody } from './strip-generator-notes'

// The frontmatter fields buildPostMarkdown serializes. Both the LLM resource
// draft (DraftFrontmatter is structurally a superset) and the verbatim article
// import produce this shape, so the on-disk contract stays identical.
export interface PostFrontmatter {
  title: string
  excerpt: string
  meta_title: string
  meta_description: string
  target_keyword: string
  secondary_keywords: string[]
  answer_block: string
  schema_markup: string
  tags: string[]
  image_alt: string | null
}

export function escapeFrontmatterValue(value: string): string {
  // Collapse newlines, then emit a YAML double-quoted scalar. Free-text fields
  // (title, excerpt, meta_description…) routinely contain a colon-space
  // ("City, ST: summary") which breaks unquoted YAML. JSON strings are valid
  // YAML double-quoted scalars, so JSON.stringify makes every value safe.
  return JSON.stringify(value.replace(/\n/g, ' ').trim())
}

// Serialize a post to markdown with frontmatter. The single writer of the
// content/posts/*.md frontmatter contract — shared by the resource-draft
// generator and the verbatim article importer.
export function buildPostMarkdown(args: {
  fm: PostFrontmatter
  body: string
  slug: string
  date: string
  contentType: ContentType
  author: string | null
  canonicalUrl: string
  heroImage: string | null
  // Blog category ids (content/categories.json). Omitted/empty → no line.
  categories?: string[]
}): string {
  const { fm } = args
  const lines = [
    '---',
    `title: ${escapeFrontmatterValue(fm.title)}`,
    `slug: ${args.slug}`,
    `date: ${args.date}`,
    `content_type: ${args.contentType}`,
    ...(args.author ? [`author: ${escapeFrontmatterValue(args.author)}`] : []),
    `excerpt: ${escapeFrontmatterValue(fm.excerpt)}`,
    ...(args.heroImage ? [`image: ${args.heroImage}`] : []),
    ...(args.heroImage && fm.image_alt ? [`image_alt: ${escapeFrontmatterValue(fm.image_alt)}`] : []),
    `tags: [${fm.tags.map((t) => escapeFrontmatterValue(t)).join(', ')}]`,
    ...(args.categories?.length ? [`categories: [${args.categories.join(', ')}]`] : []),
    `meta_title: ${escapeFrontmatterValue(fm.meta_title)}`,
    `meta_description: ${escapeFrontmatterValue(fm.meta_description)}`,
    `target_keyword: ${escapeFrontmatterValue(fm.target_keyword)}`,
    `secondary_keywords: [${fm.secondary_keywords.map((k) => escapeFrontmatterValue(k)).join(', ')}]`,
    `canonical_url: ${args.canonicalUrl}`,
    `schema_markup: ${escapeFrontmatterValue(fm.schema_markup)}`,
    `answer_block: ${escapeFrontmatterValue(fm.answer_block)}`,
    '---',
    '',
  ]
  // Posts render their body verbatim (no trailer trim in the template), so
  // generator notes must never reach it — strip any the model echoed.
  return lines.join('\n') + stripGeneratorNotesFromBody(args.body).body.trim() + '\n'
}
