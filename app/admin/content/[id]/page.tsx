import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { createServerClient } from '@/lib/supabase/server'
import { getCurrentUser, getAccessibleSessionIds, hasOnboardingAccess } from '@/lib/auth/access'
import PhaseStepper from '@/components/content/PhaseStepper'
import PackageDownloadBar from '@/components/content/PackageDownloadBar'
import GithubRepoConnector from '@/components/admin/GithubRepoConnector'
import type { DesignTokens } from '@/types/design-tokens'
import type { SessionSchema } from '@/types/session-schema'
import type { NavJson } from '@/types/nav-json'
import { isUuid } from '@/lib/design/input-validation'

export default async function ContentWorkflowPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ preview?: string | string[] }>
}) {
  const { id } = await params
  // ?preview=<generated_pages.id> (from the Content Quality dashboard) opens
  // that page's preview modal on load.
  const { preview } = await searchParams
  const initialPreviewPageId = typeof preview === 'string' && isUuid(preview) ? preview : null

  // The content workflow (palette → sitemap → research → outlines → generation)
  // is manager/admin-only; editors and Site Owners work in the draft editor.
  // Managers may only open clients assigned to them.
  const user = await getCurrentUser()
  if (!user) redirect('/admin/login')
  if (!hasOnboardingAccess(user)) notFound()
  if (!user.isAdmin) {
    const allowed = await getAccessibleSessionIds(user)
    if (!allowed?.includes(id)) notFound()
  }

  const supabase = createServerClient()

  // Independent loads in parallel. The logo + package listing are cheap and
  // only used if the session turns out to be approved.
  const [sessionRes, jobRes, logoRes, packageRes] = await Promise.all([
    supabase
      .from('sessions')
      .select('id, website_url, schema_data, status, approved_at')
      .eq('id', id)
      .single(),
    supabase
      .from('content_jobs')
      .select('*')
      .eq('session_id', id)
      .maybeSingle(),
    supabase
      .from('assets')
      .select('storage_path')
      .eq('session_id', id)
      .eq('asset_category', 'logo')
      .order('uploaded_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    // A persistent download bar shows at the top once a package has been
    // assembled. Detect what's in the session's package folder so we only offer
    // the plain-file buttons when those objects actually exist (packages built
    // before the plain-content feature won't have them until re-assembled).
    supabase.storage.from('session-assets').list(`content-packages/${id}`),
  ])

  const session = sessionRes.data
  if (!session || session.status !== 'approved') notFound()

  // Load or create content_job
  let contentJob = jobRes.data

  if (!contentJob) {
    const { data: newJob, error: insertErr } = await supabase
      .from('content_jobs')
      .upsert({ session_id: id }, { onConflict: 'session_id' })
      .select('*')
      .single()
    if (insertErr) {
      // Race condition — another request created it, re-fetch
      const { data: refetched } = await supabase
        .from('content_jobs')
        .select('*')
        .eq('session_id', id)
        .single()
      contentJob = refetched
    } else {
      contentJob = newJob
    }
  }

  const firmName = (session.schema_data as Record<string, Record<string, unknown>>)?.business?.name as string | undefined
  const currentPhase = contentJob?.phase ?? 1
  const contentJobId = contentJob?.id ?? ''

  // Cumulative API cost for this job (estimated at insert time per model rates).
  // Paged: PostgREST caps a response at 1000 rows and busy jobs exceed that.
  const usage = { cost: 0, tokens: 0, calls: 0, byStage: {} as Record<string, number> }
  if (contentJobId) {
    const PAGE = 1000
    for (let from = 0; ; from += PAGE) {
      const { data: rows, error: usageErr } = await supabase
        .from('token_usage')
        .select('id, stage, input_tokens, output_tokens, cost_usd')
        .eq('content_job_id', contentJobId)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1)
      if (usageErr || !rows) break
      for (const r of rows) {
        const cost = Number(r.cost_usd) || 0
        usage.cost += cost
        usage.tokens += (r.input_tokens || 0) + (r.output_tokens || 0)
        usage.calls += 1
        usage.byStage[r.stage] = (usage.byStage[r.stage] ?? 0) + cost
      }
      if (rows.length < PAGE) break
    }
  }
  const existingPalette = (contentJob?.palette ?? null) as import('@/types/palette').PaletteData | null
  const existingTokens = (contentJob?.design_tokens ?? null) as DesignTokens | null
  const brand = (session.schema_data as SessionSchema | null)?.brand
  const confirmedSitemap = (contentJob?.confirmed_sitemap ?? []) as Array<{ url: string; title: string; parent?: string; status?: string }>
  const confirmedPageCount = confirmedSitemap.length
  const navConfig = (contentJob?.nav_config ?? null) as NavJson | null

  // Current logo (if any) for the palette step's preview — signed since the
  // session-assets bucket is private.
  const logoAsset = logoRes.data
  let logoUrl: string | null = null
  if (logoAsset?.storage_path) {
    const { data: signed } = await supabase.storage
      .from('session-assets')
      .createSignedUrl(logoAsset.storage_path, 3600)
    logoUrl = signed?.signedUrl ?? null
  }

  const packageFileNames = new Set((packageRes.data ?? []).map((f) => f.name))
  const hasPackage = packageFileNames.has('content-package.zip')
  const hasPlainFiles =
    packageFileNames.has('content-plain.txt') && packageFileNames.has('content-plain.docx')

  return (
    <main className="p-8 max-w-[1200px] mx-auto">
      <div className="mb-8">
        <Link
          href="/admin/content"
          className="text-sm font-body text-text-muted hover:text-brand-cyan transition-colors"
        >
          &larr; Back to Content Hub
        </Link>

        <div className="mt-4">
          <h1 className="text-2xl font-heading font-bold text-brand-navy">
            {firmName ?? session.website_url}
          </h1>
          <p className="text-text-secondary font-body text-sm mt-1">
            {session.website_url}
            {session.approved_at && (
              <span className="ml-3 text-text-muted">
                Approved {new Date(session.approved_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
            )}
          </p>
          {usage.calls > 0 && (
            <p
              className="text-text-muted font-body text-xs mt-1"
              title={Object.entries(usage.byStage)
                .map(([stage, cost]) => `${stage}: $${cost.toFixed(2)}`)
                .join('  ·  ')}
            >
              Est. API cost: ${usage.cost.toFixed(2)} · {usage.tokens.toLocaleString()} tokens · {usage.calls} calls
            </p>
          )}
        </div>
      </div>

      {hasPackage && (
        <div className="mb-8 border border-border-default bg-surface-card shadow-subtle rounded-xl p-4 space-y-2">
          <h2 className="text-sm font-heading font-semibold text-brand-navy">Download deliverables</h2>
          <PackageDownloadBar contentJobId={contentJobId} showPlain={hasPlainFiles} />
          {!hasPlainFiles && (
            <p className="text-xs font-body text-text-muted">
              This package predates the plain-text files — re-assemble it in the Deliverables step to add the .txt and unstyled .docx.
            </p>
          )}
        </div>
      )}

      <div className="mb-8 flex items-center justify-between border border-border-default bg-surface-card shadow-subtle rounded-xl p-4">
        <div>
          <h2 className="text-sm font-heading font-semibold text-brand-navy">Pricing calculator</h2>
          <p className="text-xs font-body text-text-muted mt-0.5">
            Configure the interactive pricing estimate published to this client&rsquo;s site.
          </p>
        </div>
        <Link
          href={`/admin/content/${session.id}/pricing-calculator`}
          className="border border-brand-cyan text-brand-cyan font-heading font-semibold text-xs px-3.5 py-1.5 rounded-pill transition-colors hover:bg-brand-cyan/10"
        >
          Edit calculator
        </Link>
      </div>

      <div className="mb-8 flex items-center justify-between border border-border-default bg-surface-card shadow-subtle rounded-xl p-4">
        <div>
          <h2 className="text-sm font-heading font-semibold text-brand-navy">Plans page</h2>
          <p className="text-xs font-body text-text-muted mt-0.5">
            Configure the static plans/pricing page (tier cards) published to this client&rsquo;s site.
          </p>
        </div>
        <Link
          href={`/admin/content/${session.id}/plans`}
          className="border border-brand-cyan text-brand-cyan font-heading font-semibold text-xs px-3.5 py-1.5 rounded-pill transition-colors hover:bg-brand-cyan/10"
        >
          Edit plans
        </Link>
      </div>

      <div className="mb-8 flex items-center justify-between border border-border-default bg-surface-card shadow-subtle rounded-xl p-4">
        <div>
          <h2 className="text-sm font-heading font-semibold text-brand-navy">Contact &amp; scheduling</h2>
          <p className="text-xs font-body text-text-muted mt-0.5">
            Set the booking link behind the site&rsquo;s contact drawer (&ldquo;Book a call&rdquo;).
          </p>
        </div>
        <Link
          href={`/admin/content/${session.id}/contact-settings`}
          className="border border-brand-cyan text-brand-cyan font-heading font-semibold text-xs px-3.5 py-1.5 rounded-pill transition-colors hover:bg-brand-cyan/10"
        >
          Edit contact settings
        </Link>
      </div>

      <GithubRepoConnector
        contentJobId={contentJobId}
        initialRepo={contentJob?.github_repo ?? null}
        defaultOrg={process.env.GITHUB_ORG ?? null}
      />

      <PhaseStepper
        currentPhase={currentPhase}
        sessionId={session.id}
        contentJobId={contentJobId}
        githubRepo={contentJob?.github_repo ?? null}
        existingPalette={existingPalette}
        existingTokens={existingTokens}
        brand={brand}
        logoUrl={logoUrl}
        confirmedPageCount={confirmedPageCount}
        navConfig={navConfig}
        confirmedSitemap={confirmedSitemap}
        initialPreviewPageId={initialPreviewPageId}
      />
    </main>
  )
}
