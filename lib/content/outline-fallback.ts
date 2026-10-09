// Shared, client-safe (no server imports) so both the server-side outline
// generator and the client OutlineCard agree on the fallback marker. When
// outline generation fails to parse a real outline it writes a placeholder row;
// this sentinel lets the approval UI flag it so a placeholder can't be approved
// unnoticed.
export const OUTLINE_FALLBACK_PREFIX = '⚠ Needs review'

export const OUTLINE_FALLBACK_NOTE =
  `${OUTLINE_FALLBACK_PREFIX} — auto-generated placeholder (outline generation failed). Edit the sections before approving.`

// Build a review-flagged note that embeds the real thrown error so the operator
// sees WHY generation failed (previously swallowed into a generic string that
// isFallbackOutline didn't even recognize → the row showed as approvable
// "Pending" instead of "Needs review"). The prefix keeps it recognized.
export function buildOutlineFailureNote(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return `${OUTLINE_FALLBACK_PREFIX} — outline generation failed: ${msg.slice(0, 300)}. Edit the sections before approving.`
}

export function isFallbackOutline(adminNotes: string | null | undefined): boolean {
  return typeof adminNotes === 'string' && adminNotes.startsWith(OUTLINE_FALLBACK_PREFIX)
}

// The model sometimes declines a page (e.g. it judged the topic excluded) and
// returns a well-formed but empty outline: `sections: []` and a blank h1, with
// its reason in `notes`. Saved as-is, a blank h1 reads as "still generating"
// forever, which blocks approval and generation with no visible cause.
export function isRefusedOutline(parsed: { h1?: unknown; sections?: unknown }): boolean {
  const h1 = typeof parsed.h1 === 'string' ? parsed.h1.trim() : ''
  return !h1 || !Array.isArray(parsed.sections) || parsed.sections.length === 0
}

export function buildOutlineRefusalNote(modelNotes: unknown): string {
  const reason = typeof modelNotes === 'string' && modelNotes.trim()
    ? modelNotes.trim().slice(0, 600)
    : 'no reason given'
  return `${OUTLINE_FALLBACK_PREFIX} — the outline generator declined this page: ${reason} Edit the sections or regenerate before approving.`
}

// An outline may be approved only once it's a real plan: a non-blank h1, at
// least one section, and no "⚠ Needs review" note left on it (the operator
// clears the note after fixing the placeholder). Approving a placeholder sent
// "Overview / Add content here" to the writer and shipped a generic page.
export function isApprovableOutline(o: { h1?: unknown; sections?: unknown; admin_notes?: unknown }): boolean {
  const h1 = typeof o.h1 === 'string' ? o.h1.trim() : ''
  if (!h1) return false
  if (!Array.isArray(o.sections) || o.sections.length === 0) return false
  return !isFallbackOutline(typeof o.admin_notes === 'string' ? o.admin_notes : null)
}
