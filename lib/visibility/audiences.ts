import type { AudienceKey } from './types'

export interface AudienceMeta {
  key: AudienceKey
  n: 1 | 2 | 3 | 4 | 5
  label: string
  question: string
  // What the site should deliver for this audience ("Different audiences.
  // Different content." slide).
  focus: string
}

// Order and copy follow the Revaltus "comprehensive visibility audit" deck.
export const AUDIENCES: ReadonlyArray<AudienceMeta> = [
  { key: 'prospects', n: 1, label: 'Prospective clients', question: 'Can you help with what I need?', focus: 'Services + niche expertise' },
  { key: 'clients', n: 2, label: 'Existing clients', question: 'What else can you help me achieve?', focus: 'Advisory insight + new opportunities' },
  { key: 'talent', n: 3, label: 'Future talent & partners', question: 'Careers, partnerships + investment', focus: 'People, culture + future direction' },
  { key: 'search', n: 4, label: 'Google search', question: 'Where is this firm relevant?', focus: 'Clear services + organized pages' },
  { key: 'ai', n: 5, label: 'AI discovery', question: 'How should this firm be understood?', focus: 'Direct answers + connected context' },
]

export const AUDIENCE_KEYS: ReadonlyArray<AudienceKey> = AUDIENCES.map((a) => a.key)

export function audienceMeta(key: AudienceKey): AudienceMeta {
  const meta = AUDIENCES.find((a) => a.key === key)
  if (!meta) throw new Error(`Unknown audience: ${key}`)
  return meta
}
