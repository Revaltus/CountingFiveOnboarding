import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Enables forbidden()/unauthorized() so section layouts can return a real
  // HTTP 403 for authenticated-but-unauthorized users (see lib/auth/page-guards).
  experimental: { authInterrupts: true },
  // lightningcss ships native .node bindings — keep it out of the server
  // bundle (require() it at runtime) instead of letting Turbopack try to
  // bundle the binary. Used by lib/design/css-sanitizer.ts (server-only).
  serverExternalPackages: ['lightningcss', '@sparticuz/chromium', 'playwright-core', '@resvg/resvg-js'],
  // Force-includes native deps that file tracing can't follow (computed
  // require()s / by-path loads) for every route that (even lazily) needs
  // them. See the `lightningcss` / `renderer` comments below for why.
  outputFileTracingIncludes: (() => {
    // lightningcss (the CSS sanitizer's engine) picks its native binding with
    // a computed require() and, on Linux, first require()s detect-libc —
    // tracing can't follow either, so force-include them for every route
    // that (even lazily) loads css-sanitizer / bundle-files / apply-bundle.
    const lightningcss = [
      './node_modules/lightningcss/**',
      './node_modules/lightningcss-linux-x64-gnu/**',
      './node_modules/detect-libc/**',
    ]
    // @sparticuz/chromium ships its brotli-compressed Chromium in bin/, loaded
    // by path; playwright-core requires browsers.json (and the rest of lib/)
    // by path. Untraced, both crash the route module at cold start.
    const renderer = ['./node_modules/@sparticuz/chromium/bin/**', './node_modules/playwright-core/**']
    // Keys are picomatch globs against the route path — escape the brackets.
    return {
      '/api/edit/\\[id\\]/design': lightningcss, // GET state imports bundle-files (P2 gap)
      '/api/edit/\\[id\\]/design/render': renderer,
      '/api/edit/\\[id\\]/design/runs/\\[runId\\]/step': [...lightningcss, ...renderer],
      '/api/edit/\\[id\\]/design/concepts/\\[cid\\]/apply': lightningcss,
      '/api/edit/\\[id\\]/design/concepts/\\[cid\\]/preview': lightningcss,
      '/api/edit/\\[id\\]/design/versions/\\[vid\\]/restore': lightningcss,
      '/api/edit/\\[id\\]/design/versions/import': lightningcss,
      '/api/edit/\\[id\\]/design/locks': lightningcss,
      // Design chat: chat-workspace (sanitizer) + chat-preview (renderer), both lazy.
      '/api/edit/\\[id\\]/design/chat': [...lightningcss, ...renderer],
      // Divi export sitemap: resvg's native binding is require()d by platform
      // name, and the bundled fonts are read by path (PNG + PDF).
      // WP plugin self-update: version/readme are read at request time and the
      // committed zip is served as the update package.
      '/api/wp-feed/\\[site\\]/plugin': [
        './wordpress-plugin/revaltus-blog-sync/revaltus-blog-sync.php',
        './wordpress-plugin/revaltus-blog-sync/readme.txt',
      ],
      '/api/wp-feed/\\[site\\]/plugin/download': ['./wordpress-plugin/revaltus-blog-sync.zip'],
      '/api/edit/\\[id\\]/export-divi': [
        './node_modules/@resvg/resvg-js/**',
        './node_modules/@resvg/resvg-js-linux-x64-gnu/**',
        './lib/content/divi/assets/*.ttf',
      ],
    }
  })(),
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ]
  },
};

export default nextConfig;
