// "AI discovery" evidence: ask a web-search-enabled model the questions a buyer
// would ask and record whether the firm surfaces. Live domains only; every
// failure is non-fatal (a failed question is skipped, all failed → null).
import { anthropic } from '@ai-sdk/anthropic'
import { generateText, type Tool } from 'ai'
import { extractCacheUsage } from '@/lib/content/cache-control'
import { BACKGROUND_MEDIUM_PROVIDER_OPTIONS, PUBLISHED_CONTENT_MODEL } from '@/lib/content/generation-tuning'
import { recordTokenUsage, type TokenContext } from '@/lib/content/token-usage'
import { activeNiches } from '@/lib/content/active-niches'
import { activeServices } from '@/lib/content/active-services'
import type { SessionSchema } from '@/types/session-schema'
import { primaryCity } from './ranks'
import type { ProbeResult } from './types'

const PROBE_TIMEOUT_MS = 90_000
const SNIPPET_CHARS = 240

// @ai-sdk/anthropic pins a newer @ai-sdk/provider-utils than `ai` does, so the
// provider tool's schema type carries a different unique symbol. Runtime shape
// is a plain provider-tool descriptor either way; the cast only bridges the two
// copies of the type. Drop it once the ai / anthropic versions realign.
const webSearchTool = anthropic.tools.webSearch_20260209({ maxUses: 3 }) as unknown as Tool

export interface ProbeQuestion {
  question: string
  kind: ProbeResult['kind']
}

export function buildProbeQuestions(schema: SessionSchema, firmName: string): ProbeQuestion[] {
  const city = primaryCity(schema)
  const where = city ? ` in ${city}` : ''
  const out: ProbeQuestion[] = []
  const niche = activeNiches(schema)[0]?.name
  if (niche) out.push({ kind: 'discovery', question: `Which CPA or accounting firms${where} specialize in serving ${niche}?` })
  const service = activeServices(schema)[0]?.name
  if (service) out.push({ kind: 'discovery', question: `Who are the best firms for ${service}${where}?` })
  out.push({ kind: 'understanding', question: `What is ${firmName}${where} known for, and whom does it serve?` })
  return out
}

const LEGAL_SUFFIX = /\b(cpas?|llc|pllc|llp|p\.?c\.?|inc\.?|ltd\.?|co\.?|chartered|& associates|and associates)\b/g

const coreName = (name: string): string =>
  name
    .toLowerCase()
    .replace(LEGAL_SUFFIX, ' ')
    .replace(/[^a-z0-9&]+/g, ' ')
    .trim()

export function detectMention(answer: string, firmName: string, domain: string): boolean {
  const text = answer.toLowerCase()
  const bareDomain = domain.toLowerCase().replace(/^www\./, '')
  if (bareDomain && text.includes(bareDomain)) return true
  const core = coreName(firmName)
  if (core.length < 3) return false
  return text.replace(/[^a-z0-9&]+/g, ' ').includes(core)
}

function snippetFor(answer: string, firmName: string): string {
  const core = coreName(firmName)
  const sentences = answer.split(/(?<=[.!?])\s+/)
  const hit = core ? sentences.find((s) => s.toLowerCase().replace(/[^a-z0-9&]+/g, ' ').includes(core)) : undefined
  return (hit ?? answer).replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS)
}

const onDomain = (url: string, domain: string): boolean => {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
    const d = domain.toLowerCase().replace(/^www\./, '')
    return host === d || host.endsWith(`.${d}`)
  } catch {
    return false
  }
}

async function askOne(q: ProbeQuestion, firmName: string, domain: string, ctx: TokenContext): Promise<ProbeResult | null> {
  try {
    const res = await generateText({
      model: anthropic(PUBLISHED_CONTENT_MODEL),
      tools: { web_search: webSearchTool },
      prompt: `${q.question} Answer briefly in plain prose, naming specific firms and what they are known for.`,
      providerOptions: BACKGROUND_MEDIUM_PROVIDER_OPTIONS,
      maxOutputTokens: 4000,
      abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    await recordTokenUsage({
      ...ctx,
      model: PUBLISHED_CONTENT_MODEL,
      inputTokens: res.usage?.inputTokens,
      outputTokens: res.usage?.outputTokens,
      ...extractCacheUsage(res.usage),
    })
    const sources = (res.sources ?? []).flatMap((s) => (s.sourceType === 'url' ? [s.url] : []))
    const citedUrl = sources.find((u) => onDomain(u, domain)) ?? null
    const mentioned = q.kind === 'understanding' ? citedUrl !== null : detectMention(res.text, firmName, domain) || citedUrl !== null
    return { question: q.question, kind: q.kind, mentioned, snippet: snippetFor(res.text, firmName), citedUrl }
  } catch (err) {
    console.warn('[visibility] AI probe question failed (non-fatal):', err)
    return null
  }
}

export async function runAiProbe(input: {
  schema: SessionSchema
  firmName: string
  domain: string
  ctx: TokenContext
}): Promise<ProbeResult[] | null> {
  const questions = buildProbeQuestions(input.schema, input.firmName)
  const answers = await Promise.all(questions.map((q) => askOne(q, input.firmName, input.domain, input.ctx)))
  const ok = answers.filter((a): a is ProbeResult => a !== null)
  return ok.length ? ok : null
}
