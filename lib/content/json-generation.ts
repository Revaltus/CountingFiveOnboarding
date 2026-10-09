import { generateText, type ModelMessage } from 'ai'
import { extractJson } from './extract-json'
import { providerRejection } from '@/lib/ai/provider-rejection'
import { recordAiOutage } from '@/lib/ai/ai-service-status'

type GenTextOpts = Parameters<typeof generateText>[0]
type ProviderOptions = GenTextOpts['providerOptions']
type Usage = Awaited<ReturnType<typeof generateText>>['usage']

// Shared robust JSON generation. One model call with the SDK's built-in backoff
// (`maxRetries`), a tolerant parse via `extractJson` (survives ```fences/prose and
// walks back to the last balanced bracket), and a single larger-budget retry when
// the first parse fails — usually a truncated `length` finish where adaptive
// thinking ate the budget. Mirrors the self-heal already proven in the page-body,
// resource-draft, and blog-idea generators, factored so every generator shares it.
//
// The helper NEVER throws: a model error or an unparseable response both resolve
// to `null`, which callers treat as "use the deterministic fallback".
// An account-level provider rejection (usage limit reached, credits out, bad
// API key, permission denied — lib/ai/provider-rejection.ts) skips the retry:
// it would fail identically.
//
// Fast-tier (Haiku) callers pass FAST_PROVIDER_OPTIONS (thinking off); the
// heavier generation options are for Sonnet/Opus calls.
// Every caller is an async (non-interactive) generator running inside a function
// with a hard maxDuration; none of them previously passed a timeout of any kind.
const DEFAULT_JSON_CALL_TIMEOUT_MS = 120_000

// Exactly one of `prompt` (a plain string — every pre-Design-Studio caller) or
// `messages` (multi-part content: text + image parts, cache breakpoints, or a
// follow-up turn such as a repair request).
export type JsonPromptInput = { prompt: string; messages?: undefined } | { messages: ModelMessage[]; prompt?: undefined }

export type GenerateJsonOptions = JsonPromptInput & {
  model: GenTextOpts['model']
  system?: string
  firstBudget: number
  retryBudget?: number
  providerOptions?: ProviderOptions
  retryProviderOptions?: ProviderOptions
  label: string
  // Called once per attempt (only when the model call itself succeeded) so the
  // caller can record token usage / budget checks. Its own errors are swallowed
  // and never fail the attempt.
  onAttempt?: (usage: Usage, finishReason: string) => void | Promise<void>
  // Called once per attempt that FAILED (the model call threw — timeout abort,
  // provider error — or its text did not parse). finishReason is 'error' when
  // the call itself threw, else the call's finish reason (e.g. 'length').
  // Observation only: its own errors are swallowed.
  onAttemptFailed?: (info: { attempt: 1 | 2; finishReason: string; error: unknown }) => void
  // Called BEFORE each model call (1 = first, 2 = the larger-budget retry).
  // Returning false skips that call — a cost cap or an invocation deadline.
  // A throw counts as false. A skipped first attempt resolves to null.
  beforeAttempt?: (attempt: 1 | 2) => boolean | Promise<boolean>
  // Hard ceiling for each model call. Bounds the maxRetries backoff below too, so
  // a stalled provider can't consume the caller's whole function budget — without
  // it, the function is killed and whatever row the caller claimed is orphaned.
  timeoutMs?: number
}

export async function generateJson(opts: GenerateJsonOptions): Promise<unknown | null> {
  const allowed = async (attemptNo: 1 | 2): Promise<boolean> => {
    if (!opts.beforeAttempt) return true
    try {
      return (await opts.beforeAttempt(attemptNo)) === true
    } catch {
      return false
    }
  }

  const attempt = async (
    attemptNo: 1 | 2,
    maxOutputTokens: number,
    providerOptions: ProviderOptions
  ): Promise<{ ok: true; value: unknown } | { ok: false; finishReason: string; error?: unknown }> => {
    if (!(await allowed(attemptNo))) return { ok: false, finishReason: 'skipped' }
    let finishReason = 'error'
    try {
      const common = {
        model: opts.model,
        maxOutputTokens,
        // Ride out transient overload/rate-limit (529/429) via exponential backoff
        // instead of throwing out of the generator.
        maxRetries: 4,
        abortSignal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_JSON_CALL_TIMEOUT_MS),
        ...(opts.system ? { system: opts.system } : {}),
        ...(providerOptions ? { providerOptions } : {}),
      }
      const params: GenTextOpts =
        opts.messages !== undefined ? { ...common, messages: opts.messages } : { ...common, prompt: opts.prompt }
      const result = await generateText(params)
      finishReason = result.finishReason ?? 'unknown'
      if (opts.onAttempt) {
        try {
          await opts.onAttempt(result.usage, finishReason)
        } catch {
          // usage accounting must never fail the generation
        }
      }
      return { ok: true, value: extractJson(result.text) }
    } catch (error) {
      try {
        opts.onAttemptFailed?.({ attempt: attemptNo, finishReason, error })
      } catch {
        // observation must never fail the generation
      }
      return { ok: false, finishReason, error }
    }
  }

  // A provider rejection (usage limit, credits, …) on EITHER attempt is logged
  // by name and, for account-level outages, raises the admin-shell banner from
  // background generators too (fire-and-forget, never throws).
  const handleRejection = (r: typeof res, retrying: boolean): boolean => {
    const rejected = !r.ok && r.finishReason === 'error' ? providerRejection(r.error) : null
    if (!rejected) return false
    console.error(`[${opts.label}] the AI provider rejected the request (${rejected.kind})${retrying ? ' — not retrying' : ''}`)
    if (rejected.kind === 'credit' || rejected.kind === 'usage_limit') void recordAiOutage(rejected.kind, rejected.resetDate)
    return true
  }

  let res = await attempt(1, opts.firstBudget, opts.providerOptions)
  if (handleRejection(res, true)) return null
  if (!res.ok && res.finishReason !== 'skipped' && opts.retryBudget) {
    console.warn(`[${opts.label}] JSON parse failed (finish=${res.finishReason}) — retrying with larger budget`)
    res = await attempt(2, opts.retryBudget, opts.retryProviderOptions ?? opts.providerOptions)
    if (handleRejection(res, false)) return null
  }
  if (res.ok) return res.value
  if (res.finishReason !== 'skipped') {
    console.error(`[${opts.label}] Failed to parse model JSON after retry (finish=${res.finishReason})`)
  }
  return null
}
