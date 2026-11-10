import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer'
import { AUDIENCES } from '@/lib/visibility/audiences'
import type { CheckStatus, VisibilityNarrative, VisibilityResult } from '@/lib/visibility/types'
import { PDF_AUDIENCE_COLORS, PDF_COLORS } from './palette'

const s = StyleSheet.create({
  page: { padding: 48, backgroundColor: PDF_COLORS.page, fontSize: 11, color: PDF_COLORS.body },
  eyebrow: { fontSize: 9, color: PDF_COLORS.teal, letterSpacing: 1, marginBottom: 6 },
  title: { fontSize: 26, fontWeight: 'bold', color: PDF_COLORS.ink, marginBottom: 6 },
  subtitle: { fontSize: 12, color: PDF_COLORS.muted, marginBottom: 28 },
  overallRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 24 },
  overallScore: { fontSize: 40, fontWeight: 'bold', color: PDF_COLORS.ink, marginRight: 12 },
  overallLabel: { fontSize: 11, color: PDF_COLORS.muted },
  audRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottom: `1pt solid ${PDF_COLORS.rule}` },
  badge: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  badgeText: { fontSize: 10, color: PDF_COLORS.page, fontWeight: 'bold' },
  audName: { flexGrow: 1 },
  audLabel: { fontSize: 12, fontWeight: 'bold', color: PDF_COLORS.ink },
  audQuestion: { fontSize: 9, color: PDF_COLORS.muted },
  audScore: { fontSize: 14, fontWeight: 'bold', color: PDF_COLORS.ink },
  h2: { fontSize: 18, fontWeight: 'bold', color: PDF_COLORS.ink, marginBottom: 4 },
  question: { fontSize: 11, color: PDF_COLORS.muted, marginBottom: 14 },
  h3: { fontSize: 11, fontWeight: 'bold', color: PDF_COLORS.teal, marginTop: 12, marginBottom: 6 },
  para: { lineHeight: 1.5 },
  bullet: { flexDirection: 'row', marginBottom: 4 },
  bulletDot: { width: 12 },
  bulletText: { flex: 1, lineHeight: 1.4 },
  checkRow: { flexDirection: 'row', paddingVertical: 3, borderBottom: `0.5pt solid ${PDF_COLORS.rule}` },
  checkStatus: { width: 64, fontSize: 9, fontWeight: 'bold' },
  checkLabel: { flex: 1, fontSize: 9 },
  checkDetail: { fontSize: 8, color: PDF_COLORS.muted },
  footer: { position: 'absolute', bottom: 28, left: 48, right: 48, fontSize: 8, color: PDF_COLORS.faint, textAlign: 'center' },
})

const STATUS_LABEL: Record<CheckStatus, string> = { pass: 'Strong', partial: 'Partial', fail: 'Opportunity', na: 'Not measured' }
const STATUS_COLOR: Record<CheckStatus, string> = { pass: PDF_COLORS.teal, partial: PDF_COLORS.muted, fail: PDF_COLORS.ink, na: PDF_COLORS.faint }

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

function Bullets({ items }: { items: string[] }) {
  return (
    <>
      {items.map((t, i) => (
        <View key={i} style={s.bullet}>
          <Text style={s.bulletDot}>•</Text>
          <Text style={s.bulletText}>{t}</Text>
        </View>
      ))}
    </>
  )
}

function Footer({ firmName }: { firmName: string }) {
  return (
    <Text style={s.footer} fixed render={({ pageNumber, totalPages }) => `${firmName} · Visibility Report · ${pageNumber} / ${totalPages}`} />
  )
}

export function VisibilityPdf({ result, narrative, firmName }: { result: VisibilityResult; narrative: VisibilityNarrative; firmName: string }) {
  return (
    <Document title={`Visibility Report — ${firmName}`}>
      <Page size="LETTER" style={s.page}>
        <Text style={s.eyebrow}>REVALTUS · VISIBILITY REPORT</Text>
        <Text style={s.title}>{firmName}</Text>
        <Text style={s.subtitle}>{result.domain} · {fmtDate(result.auditedAt)}</Text>
        <View style={s.overallRow}>
          <Text style={s.overallScore}>{result.overallScore ?? '—'}</Text>
          <Text style={s.overallLabel}>Overall visibility{result.overallGrade ? ` · Grade ${result.overallGrade}` : ''}</Text>
        </View>
        {AUDIENCES.map((a) => {
          const sc = result.audienceScores[a.key]
          return (
            <View key={a.key} style={s.audRow}>
              <View style={[s.badge, { backgroundColor: PDF_AUDIENCE_COLORS[a.key] }]}>
                <Text style={s.badgeText}>{a.n}</Text>
              </View>
              <View style={s.audName}>
                <Text style={s.audLabel}>{a.label}</Text>
                <Text style={s.audQuestion}>{a.question}</Text>
              </View>
              <Text style={s.audScore}>{sc.score ?? '—'}{sc.grade ? ` ${sc.grade}` : ''}</Text>
            </View>
          )
        })}
        <Text style={s.h3}>Overview</Text>
        <Text style={s.para}>{narrative.overview}</Text>
        <Footer firmName={firmName} />
      </Page>
      {AUDIENCES.map((a) => {
        const sc = result.audienceScores[a.key]
        const sec = narrative.audiences[a.key]
        const checks = result.checks.filter((c) => c.audience === a.key)
        return (
          <Page key={a.key} size="LETTER" style={s.page}>
            <View style={[s.badge, { backgroundColor: PDF_AUDIENCE_COLORS[a.key], marginBottom: 8 }]}>
              <Text style={s.badgeText}>{a.n}</Text>
            </View>
            <Text style={s.h2}>{a.label} · {sc.score ?? '—'}{sc.grade ? ` (${sc.grade})` : ''}</Text>
            <Text style={s.question}>{a.question}</Text>
            {sec.wins.length > 0 && (
              <>
                <Text style={s.h3}>What&apos;s working</Text>
                <Bullets items={sec.wins} />
              </>
            )}
            {sec.opportunities.length > 0 && (
              <>
                <Text style={s.h3}>Next opportunities</Text>
                <Bullets items={sec.opportunities} />
              </>
            )}
            <Text style={s.h3}>What we checked</Text>
            {checks.map((c) => (
              <View key={c.id} style={s.checkRow} wrap={false}>
                <Text style={[s.checkStatus, { color: STATUS_COLOR[c.status] }]}>{STATUS_LABEL[c.status]}</Text>
                <View style={s.checkLabel}>
                  <Text>{c.label}</Text>
                  <Text style={s.checkDetail}>{c.detail}</Text>
                </View>
              </View>
            ))}
            <Footer firmName={firmName} />
          </Page>
        )
      })}
    </Document>
  )
}
