import type { SessionSchema } from '@/types/session-schema'
import { isResolved, normPath } from '@/lib/onboarding/directives'
import { verbatimBios } from './verbatim-bios'

function verbatimPageDirective(schema: SessionSchema, pageUrl: string) {
  const key = normPath(pageUrl)
  return (schema.operator_directives ?? []).find(
    (d) => isResolved(d) && d.kind === 'bring_page' && d.verbatim && d.sourceUrl && normPath(d.sourceUrl) === key,
  )
}

// A page brought over word-for-word at the client's request.
export function isVerbatimPage(schema: SessionSchema, pageUrl: string): boolean {
  return !!verbatimPageDirective(schema, pageUrl)
}

// System-prompt note for an AI editor working on a page that carries
// client-supplied verbatim text: a whole page brought over word-for-word, or
// team bios the client asked to keep exactly. Empty when neither applies.
// Formatting/SEO edits stay allowed; rewording needs the operator's explicit OK.
export function verbatimGuardNote(schema: SessionSchema, pageUrl: string | null, fileText: string): string {
  const lines: string[] = []
  if (pageUrl) {
    const page = verbatimPageDirective(schema, pageUrl)
    if (page) {
      lines.push(
        `This entire page is the client's own content, brought over word-for-word at their request ("${page.sourceText}"). Do not reword, shorten, summarize or "improve" its text, and keep every link.`,
      )
    }
  }
  const lowerFile = fileText.toLowerCase()
  const bios = [...verbatimBios(schema).keys()].filter((name) => lowerFile.includes(name))
  if (bios.length) {
    const names = (schema.team ?? []).filter((m) => m?.name && bios.includes(m.name.trim().toLowerCase())).map((m) => m.name)
    lines.push(`The bios of ${names.join(', ')} are the client's exact wording. Do not reword them.`)
  }
  if (!lines.length) return ''
  return [
    'VERBATIM CLIENT CONTENT (operator instruction from onboarding):',
    ...lines,
    'Formatting, layout, headings and SEO fields may still change. If the admin asks you to change that wording, first confirm they want to override the client-supplied text, then do it.',
  ].join('\n')
}

// System-prompt note for the Site Assistant (which deletes/moves pages): the
// pages that exist because of an operator instruction, so it flags the conflict
// before removing or relocating one.
export function operatorPagesNote(schema: SessionSchema): string {
  const pages = (schema.operator_directives ?? []).filter(
    (d) => isResolved(d) && d.kind === 'bring_page' && d.sourceUrl,
  )
  if (!pages.length) return ''
  return [
    'PAGES KEPT BY CLIENT INSTRUCTION (from onboarding) — before deleting or moving one, tell the operator it was kept at the client’s request and get explicit confirmation:',
    ...pages.map((d) => `- ${d.sourceUrl}${d.verbatim ? ' (verbatim client content)' : ''}: "${d.sourceText}"`),
  ].join('\n')
}
