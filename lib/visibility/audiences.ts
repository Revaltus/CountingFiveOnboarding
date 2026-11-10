import type { AudienceKey } from './types'

export interface AudienceMeta {
  key: AudienceKey
  n: 1 | 2 | 3 | 4 | 5
  label: string
  question: string
}

// Order and copy follow the Revaltus "comprehensive visibility audit" deck.
export const AUDIENCES: ReadonlyArray<AudienceMeta> = [
  { key: 'prospects', n: 1, label: 'Prospective clients', question: 'Can you help with what I need?' },
  { key: 'clients', n: 2, label: 'Existing clients', question: 'What else can you help me achieve?' },
  { key: 'talent', n: 3, label: 'Future talent & partners', question: 'Careers, partnerships + investment' },
  { key: 'search', n: 4, label: 'Google search', question: 'Where is this firm relevant?' },
  { key: 'ai', n: 5, label: 'AI discovery', question: 'How should this firm be understood?' },
]

export const AUDIENCE_KEYS: ReadonlyArray<AudienceKey> = AUDIENCES.map((a) => a.key)

export function audienceMeta(key: AudienceKey): AudienceMeta {
  const meta = AUDIENCES.find((a) => a.key === key)
  if (!meta) throw new Error(`Unknown audience: ${key}`)
  return meta
}
