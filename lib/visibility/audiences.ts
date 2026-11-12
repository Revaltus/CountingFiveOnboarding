import type { AudienceKey } from './types'

export interface AudienceMeta {
  key: AudienceKey
  n: 1 | 2 | 3 | 4 | 5
  label: string
  // The audience's one-line need, as worded in the Revaltus brochure.
  summary: string
  // What the site should deliver for this audience.
  focus: string
}

// Order and copy follow the Revaltus brochure ("One firm. Five audiences.").
export const AUDIENCES: ReadonlyArray<AudienceMeta> = [
  { key: 'prospects', n: 1, label: 'Prospective clients', summary: 'Explain your services, who you help, and how to begin.', focus: 'Services + a clear next step' },
  { key: 'niche', n: 2, label: 'Ideal niche clients', summary: 'Show knowledge of their industry, its challenges, and the work you can do.', focus: 'Industry knowledge + niche content' },
  { key: 'talent', n: 3, label: 'Future talent & partners', summary: 'Highlight your careers, partnerships, and future investments.', focus: 'People, culture + future direction' },
  { key: 'search', n: 4, label: 'Google search', summary: 'Make services, locations, and expertise easy to discover and interpret.', focus: 'Clear services + organized pages' },
  { key: 'ai', n: 5, label: 'AI discovery', summary: 'Provide clear context that connects your firm, niches, services, and experts.', focus: 'Direct answers + connected context' },
]

export const AUDIENCE_KEYS: ReadonlyArray<AudienceKey> = AUDIENCES.map((a) => a.key)

export function audienceMeta(key: AudienceKey): AudienceMeta {
  const meta = AUDIENCES.find((a) => a.key === key)
  if (!meta) throw new Error(`Unknown audience: ${key}`)
  return meta
}
