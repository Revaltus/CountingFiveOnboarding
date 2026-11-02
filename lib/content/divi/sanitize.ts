// ---------------------------------------------------------------------------
// URL + attribute sanitizers for the Divi export bridge (see ./README.md).
//
// The exported HTML/shortcode is imported into WordPress and rendered on the
// public client site, so any URL that reaches an `href` (nav/client-center/
// social links, markdown links, CTA buttons) must be scheme-checked to prevent
// stored XSS via `javascript:`/`data:`/`vbscript:`. Client portal labels/URLs
// and crawled markdown links are untrusted inputs.
// ---------------------------------------------------------------------------

// Return the URL if it uses a safe scheme (or is relative/anchor), else null.
// Rejects javascript:/data:/vbscript: and any other explicit scheme.
export function safeUrl(raw: string): string | null {
  const url = (raw ?? '').trim()
  if (!url) return null
  // Relative paths, root-relative, and fragments are always safe.
  if (/^(#|\/|\.\/|\.\.\/)/.test(url)) return url
  // Explicit allowlisted schemes.
  if (/^(https?:|mailto:|tel:)/i.test(url)) return url
  // Anything else carrying a scheme (javascript:, data:, vbscript:, …) is dropped.
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null
  // No scheme and not clearly relative (e.g. "services") — treat as relative.
  return url
}

// Escape a value for use inside a double-quoted HTML attribute or as element
// text: encodes &, <, >, and both quote styles so nothing can break out.
export function htmlAttrEscape(value: string): string {
  return escapeShortcodeBrackets(
    (value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;'),
  )
}

// WordPress parses shortcodes with a regex over the whole post_content, so a
// literal "[et_pb_…]" inside copy (crawled from an old site, pasted, or
// AI-written) would close the enclosing module and splice in its own. Every
// text that reaches the export goes through this; WP renders the entities as
// plain brackets.
export function escapeShortcodeBrackets(value: string): string {
  return value.replace(/\[/g, '&#91;').replace(/\]/g, '&#93;')
}
