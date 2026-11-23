// ---------------------------------------------------------------------------
// WordPress eXtended RSS (WXR) builder for the Divi export bridge.
// Part of the throwaway bridge (see ./README.md).
//
// Emits a single import file containing every page (Divi shortcode as
// content:encoded, marked to open in the Divi Builder) plus the primary nav
// menu built from the confirmed sitemap. Header/footer travel separately as a
// Divi Library JSON (see ./library.ts) because standard WXR can't carry Theme
// Builder assignments.
// ---------------------------------------------------------------------------

import type { NavJson, NavItem } from '@/types/nav-json'
import type { BlogCategory } from '@/lib/content/blog-categories'
import { toPagePath } from '@/lib/content/deliverable-builder'

export type WxrPage = {
  title: string
  path: string // root-relative, e.g. /services/virtual-cfo-advisory or /
  slug: string
  postId: number
  parentId: number
  // Position in the editor sidebar (nav order, then not-in-nav pages) so the WP
  // Pages list and page-attribute order match what the operator arranged.
  menuOrder?: number
  content: string // assembled Divi shortcode
}

const MENU_TERM_ID = 2
// Category term ids start here: page ids are 100+i and menu item ids 500+n, so
// 900+ stays clear of both for any realistic site.
const CATEGORY_TERM_ID_BASE = 900
const MENU_SLUG = 'primary-menu'
const MENU_NAME = 'Primary Menu'

function cdata(value: string): string {
  // ]]> can't appear inside a CDATA section; split the sequence if present.
  return `<![CDATA[${(value ?? '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`
}

// Escapes a value for an XML text node that isn't CDATA-wrapped (URLs in
// <link>/<guid>): a raw `&` there makes the whole WXR file unparseable.
function xmlText(value: string): string {
  return (value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function categoryTerm(c: BlogCategory, termId: number): string {
  return (
    `\t<wp:category><wp:term_id>${termId}</wp:term_id><wp:category_nicename>${xmlText(c.slug)}</wp:category_nicename>` +
    `<wp:category_parent></wp:category_parent><wp:cat_name>${cdata(c.name)}</wp:cat_name>` +
    `<wp:category_description>${cdata(c.description ?? '')}</wp:category_description>` +
    `<wp:termmeta><wp:meta_key>_rv_category_id</wp:meta_key><wp:meta_value>${cdata(c.id)}</wp:meta_value></wp:termmeta></wp:category>\n`
  )
}

function postmeta(key: string, value: string): string {
  return `\t\t<wp:postmeta>\n\t\t\t<wp:meta_key>${cdata(key)}</wp:meta_key>\n\t\t\t<wp:meta_value>${cdata(value)}</wp:meta_value>\n\t\t</wp:postmeta>\n`
}

function pageItem(page: WxrPage, dateGmt: string, author: string, baseUrl: string): string {
  const permalink = page.path === '/' ? `${baseUrl}/` : `${baseUrl}${page.path}/`
  return (
    `\t<item>\n` +
    `\t\t<title>${cdata(page.title)}</title>\n` +
    `\t\t<link>${xmlText(permalink)}</link>\n` +
    `\t\t<dc:creator>${cdata(author)}</dc:creator>\n` +
    // Stable guid so a re-import updates rather than duplicates these pages.
    `\t\t<guid isPermaLink="false">${xmlText(baseUrl)}/?page_id=${page.postId}</guid>\n` +
    `\t\t<content:encoded>${cdata(page.content)}</content:encoded>\n` +
    `\t\t<excerpt:encoded>${cdata('')}</excerpt:encoded>\n` +
    `\t\t<wp:post_id>${page.postId}</wp:post_id>\n` +
    `\t\t<wp:post_date>${cdata(dateGmt)}</wp:post_date>\n` +
    `\t\t<wp:post_date_gmt>${cdata(dateGmt)}</wp:post_date_gmt>\n` +
    `\t\t<wp:comment_status>${cdata('closed')}</wp:comment_status>\n` +
    `\t\t<wp:ping_status>${cdata('closed')}</wp:ping_status>\n` +
    `\t\t<wp:post_name>${cdata(page.slug)}</wp:post_name>\n` +
    `\t\t<wp:status>${cdata('draft')}</wp:status>\n` +
    `\t\t<wp:post_parent>${page.parentId}</wp:post_parent>\n` +
    `\t\t<wp:menu_order>${page.menuOrder ?? 0}</wp:menu_order>\n` +
    `\t\t<wp:post_type>${cdata('page')}</wp:post_type>\n` +
    `\t\t<wp:post_password>${cdata('')}</wp:post_password>\n` +
    `\t\t<wp:is_sticky>0</wp:is_sticky>\n` +
    // Tell Divi this page was built with the Builder so it renders the modules.
    postmeta('_et_pb_use_builder', 'on') +
    postmeta('_et_pb_page_layout', 'et_no_sidebar') +
    postmeta('_et_pb_side_nav', 'off') +
    postmeta('_wp_page_template', 'default') +
    `\t</item>\n`
  )
}

type MenuLink = {
  id: number
  parentMenuId: number
  order: number
  label: string
  url: string
  objectId: number // page post_id, or 0 for a custom link
}

// Flatten the nav tree into menu-item records, resolving each item's URL to a
// page post_id where one exists (so WP links the menu item to the page).
function flattenNav(
  items: NavItem[],
  pageIdByPath: Map<string, number>,
  startId: number,
  parentMenuId: number,
  counter: { order: number }
): MenuLink[] {
  const out: MenuLink[] = []
  let nextId = startId
  for (const item of items) {
    const path = toPagePath(item.url)
    const objectId = pageIdByPath.get(path) ?? 0
    const id = nextId++
    counter.order += 1
    out.push({ id, parentMenuId, order: counter.order, label: item.label, url: item.url, objectId })
    if (item.children && item.children.length) {
      const children = flattenNav(item.children, pageIdByPath, nextId, id, counter)
      out.push(...children)
      nextId += children.length
    }
  }
  return out
}

function menuItemItem(link: MenuLink, dateGmt: string, author: string): string {
  const isPage = link.objectId > 0
  return (
    `\t<item>\n` +
    `\t\t<title>${cdata(link.label)}</title>\n` +
    `\t\t<dc:creator>${cdata(author)}</dc:creator>\n` +
    `\t\t<content:encoded>${cdata('')}</content:encoded>\n` +
    `\t\t<excerpt:encoded>${cdata('')}</excerpt:encoded>\n` +
    `\t\t<wp:post_id>${link.id}</wp:post_id>\n` +
    `\t\t<wp:post_date>${cdata(dateGmt)}</wp:post_date>\n` +
    `\t\t<wp:post_date_gmt>${cdata(dateGmt)}</wp:post_date_gmt>\n` +
    `\t\t<wp:post_name>${cdata(String(link.id))}</wp:post_name>\n` +
    `\t\t<wp:status>${cdata('publish')}</wp:status>\n` +
    `\t\t<wp:post_parent>0</wp:post_parent>\n` +
    `\t\t<wp:menu_order>${link.order}</wp:menu_order>\n` +
    `\t\t<wp:post_type>${cdata('nav_menu_item')}</wp:post_type>\n` +
    `\t\t<category domain="nav_menu" nicename="${MENU_SLUG}">${cdata(MENU_NAME)}</category>\n` +
    postmeta('_menu_item_type', isPage ? 'post_type' : 'custom') +
    postmeta('_menu_item_menu_item_parent', String(link.parentMenuId)) +
    postmeta('_menu_item_object_id', String(isPage ? link.objectId : link.id)) +
    postmeta('_menu_item_object', isPage ? 'page' : 'custom') +
    postmeta('_menu_item_target', '') +
    postmeta('_menu_item_classes', 'a:1:{i:0;s:0:"";}') +
    postmeta('_menu_item_xfn', '') +
    postmeta('_menu_item_url', isPage ? '' : link.url) +
    `\t</item>\n`
  )
}

export function buildWxr(opts: {
  siteTitle: string
  siteUrl: string
  pages: WxrPage[]
  nav: NavJson
  dateGmt: string
  author?: string
  categories?: BlogCategory[]
}): string {
  const author = opts.author ?? 'admin'
  const baseUrl = (opts.siteUrl || 'https://example.com').replace(/\/+$/, '')

  const pageIdByPath = new Map<string, number>()
  for (const p of opts.pages) pageIdByPath.set(p.path, p.postId)

  const menuLinks = flattenNav(opts.nav.primary, pageIdByPath, 500, 0, { order: 0 })

  const categories = (opts.categories ?? [])
    .map((c, i) => categoryTerm(c, CATEGORY_TERM_ID_BASE + i))
    .join('')

  const header =
    `<?xml version="1.0" encoding="UTF-8" ?>\n` +
    `<rss version="2.0"\n` +
    `\txmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"\n` +
    `\txmlns:content="http://purl.org/rss/1.0/modules/content/"\n` +
    `\txmlns:wfw="http://wellformedweb.org/CommentAPI/"\n` +
    `\txmlns:dc="http://purl.org/dc/elements/1.1/"\n` +
    `\txmlns:wp="http://wordpress.org/export/1.2/">\n` +
    `<channel>\n` +
    `\t<title>${cdata(opts.siteTitle)}</title>\n` +
    `\t<link>${xmlText(baseUrl)}</link>\n` +
    `\t<description>${cdata('Divi content export')}</description>\n` +
    `\t<language>en-US</language>\n` +
    `\t<wp:wxr_version>1.2</wp:wxr_version>\n` +
    `\t<wp:base_site_url>${xmlText(baseUrl)}</wp:base_site_url>\n` +
    `\t<wp:base_blog_url>${xmlText(baseUrl)}</wp:base_blog_url>\n` +
    `\t<wp:author><wp:author_id>1</wp:author_id><wp:author_login>${cdata(author)}</wp:author_login><wp:author_email>${cdata('')}</wp:author_email><wp:author_display_name>${cdata(author)}</wp:author_display_name><wp:author_first_name>${cdata('')}</wp:author_first_name><wp:author_last_name>${cdata('')}</wp:author_last_name></wp:author>\n` +
    categories +
    `\t<wp:term>\n\t\t<wp:term_id>${MENU_TERM_ID}</wp:term_id>\n\t\t<wp:term_taxonomy>nav_menu</wp:term_taxonomy>\n\t\t<wp:term_slug>${MENU_SLUG}</wp:term_slug>\n\t\t<wp:term_name>${cdata(MENU_NAME)}</wp:term_name>\n\t</wp:term>\n`

  const pageItems = opts.pages.map((p) => pageItem(p, opts.dateGmt, author, baseUrl)).join('')
  const menuItems = menuLinks.map((l) => menuItemItem(l, opts.dateGmt, author)).join('')

  return header + pageItems + menuItems + `</channel>\n</rss>\n`
}
