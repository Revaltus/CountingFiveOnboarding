import type { CheckResult } from '@/lib/visibility/types'
import { STATUS_CLS, STATUS_LABEL } from './audience-styles'

export function CheckList({ checks }: { checks: CheckResult[] }) {
  return (
    <ul className="divide-y divide-border-default">
      {checks.map((c) => (
        <li key={c.id} className="flex items-start gap-3 py-2">
          <span className={`mt-0.5 shrink-0 rounded-badge px-2 py-0.5 text-[11px] font-heading font-semibold ${STATUS_CLS[c.status]}`}>
            {STATUS_LABEL[c.status]}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-body text-text-primary">{c.label}</p>
            <p className="text-xs font-body text-text-secondary break-words">
              {c.detail}
              {c.evidenceUrl && (
                <>
                  {' '}
                  <a href={c.evidenceUrl} target="_blank" rel="noopener noreferrer" className="text-brand-cyan hover:underline">
                    View page
                  </a>
                </>
              )}
            </p>
          </div>
        </li>
      ))}
    </ul>
  )
}
