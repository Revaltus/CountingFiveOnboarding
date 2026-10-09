import { anthropic } from '@ai-sdk/anthropic'
import { checkTokenBudget } from './truncate-to-token-budget'
import { recordTokenUsage } from './token-usage'
import { generateJson } from './json-generation'
import { arr, str } from './schema-coerce'
import { FAST_MODEL, FAST_PROVIDER_OPTIONS } from './generation-tuning'

const KEYWORD_MODEL = FAST_MODEL

type KeywordResult = {
  targetKeyword: string
  secondaryKeywords: string[]
  competitorRefs: Array<{ url: string; title: string }>
}

export async function runKeywordResearch(
  pageTitle: string,
  pageUrl: string,
  firmContext: { name: string; location: string; services: string[]; niches: string[] },
  ctx: { contentJobId: string; sessionId: string },
  // Page-intent focus (from resolvePageIntent): the specific niche/service this
  // page is about + any keywords already captured for it. Steers the Haiku model
  // toward audience-specific terms ("healthcare CPA tax planning") instead of
  // generic firm-wide ones ("CPA near me"). Optional — omitted for generic pages.
  focus?: { label: string; keywords: string[] }
): Promise<KeywordResult> {
  // arr(): niche/service keywords can be stored as a bare string in a dirty MBP.
  const focusKeywords = arr(focus?.keywords).map(k => str(k).trim()).filter(Boolean)
  const focusBlock = focus?.label
    ? `\nTHIS PAGE IS ABOUT: ${focus.label}. Prioritize search terms a ${focus.label} client would actually type — the specific audience, not generic firm-wide terms.${focusKeywords.length ? ` Build on these known keywords: ${focusKeywords.join(', ')}.` : ''}`
    : ''

  // Step 1: Claude keyword generation (fast tier, thinking off).
  const parsed = (await generateJson({
    model: anthropic(KEYWORD_MODEL),
    providerOptions: FAST_PROVIDER_OPTIONS,
    system: 'You are an SEO keyword researcher for CPA firms. Return JSON only, no prose.',
    prompt: `Generate search keywords for this CPA firm page.

FIRM: ${firmContext.name} in ${firmContext.location}
SERVICES: ${firmContext.services.join(', ')}
NICHES: ${firmContext.niches.join(', ')}

PAGE: ${pageTitle} (${pageUrl})${focusBlock}

Generate realistic CPA-firm search terms a potential client in ${firmContext.location} would use.
Prioritize local intent and service specificity over volume.

Return JSON: { "primary": "keyword phrase", "secondary": ["kw1", "kw2", "kw3"] }`,
    firstBudget: 500,
    retryBudget: 900,
    label: 'keyword-research',
    onAttempt: async (usage) => {
      checkTokenBudget('keyword-research', pageUrl, usage?.inputTokens, 800)
      await recordTokenUsage({
        task: 'content',
        contentJobId: ctx.contentJobId,
        sessionId: ctx.sessionId,
        stage: 'keyword',
        pageUrl,
        model: KEYWORD_MODEL,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
      })
    },
  })) as { primary?: unknown; secondary?: unknown } | null

  let primary = `${pageTitle.toLowerCase()} ${firmContext.location.toLowerCase()}`
  let secondary: string[] = []
  if (parsed) {
    if (typeof parsed.primary === 'string' && parsed.primary.trim()) primary = parsed.primary.trim()
    if (Array.isArray(parsed.secondary)) {
      secondary = parsed.secondary.filter((s): s is string => typeof s === 'string')
    }
  }

  // Step 2: Serper validation (if API key is available)
  const competitorRefs: Array<{ url: string; title: string }> = []

  if (process.env.SERPER_API_KEY) {
    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        // A hung Serper call used to stall the whole research page (and its
        // batch) until the function was killed.
        signal: AbortSignal.timeout(15_000),
        headers: {
          'X-API-KEY': process.env.SERPER_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          q: primary,
          gl: 'us',
          num: 3,
        }),
      })

      if (res.ok) {
        const data = await res.json()
        const organic = data.organic ?? []
        for (const result of organic.slice(0, 3)) {
          competitorRefs.push({
            url: result.link ?? '',
            title: result.title ?? '',
          })
        }
      }
    } catch (err) {
      console.warn('[keyword-research] Serper call failed:', err)
    }
  }

  return { targetKeyword: primary, secondaryKeywords: secondary, competitorRefs }
}
