import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { createServerClient } from '@/lib/supabase/server'
import { getCurrentUser, getAccessibleSessionIds } from '@/lib/auth/access'
import BlogCategoriesEditor from '@/components/editor/BlogCategoriesEditor'
import type { SessionSchema } from '@/types/session-schema'

export default async function BlogCategoriesPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const user = await getCurrentUser()
  if (!user) redirect('/admin/login')
  // Managers, editors and Site Owners may manage categories on their own site
  // (the API routes gate with requireSessionAccess); no publish/owner checks.
  if (!user.isAdmin) {
    const allowed = await getAccessibleSessionIds(user)
    if (!allowed?.includes(id)) notFound()
  }

  const supabase = createServerClient()
  const { data: session } = await supabase
    .from('sessions')
    .select('id, website_url, schema_data')
    .eq('id', id)
    .single()
  if (!session) notFound()

  const firmName = (session.schema_data as SessionSchema | null)?.business?.name

  return (
    <main className="p-8 max-w-[900px] mx-auto">
      <div className="mb-8">
        <Link
          href={`/admin/content/${id}/edit`}
          className="text-sm font-body text-text-muted hover:text-brand-cyan transition-colors"
        >
          &larr; Back to content editor
        </Link>
        <div className="mt-4">
          <h1 className="text-2xl font-heading font-bold text-brand-navy">Blog categories</h1>
          <p className="text-text-secondary font-body text-sm mt-1">
            {firmName ?? session.website_url} · organize blog posts into categories
          </p>
        </div>
      </div>

      <BlogCategoriesEditor sessionId={id} />
    </main>
  )
}
