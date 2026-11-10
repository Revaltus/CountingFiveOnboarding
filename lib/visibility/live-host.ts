// A report URL counts as the firm's live domain unless it is a Vercel preview,
// localhost, or a bare IP. Off-site evidence (Google ranks, Business Profile,
// AI answers) is only meaningful for the live domain.
export function isLiveHost(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return false
  if (host.endsWith('.vercel.app')) return false
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false
  if (host.startsWith('[') || host.includes(':')) return false
  return host.includes('.')
}
