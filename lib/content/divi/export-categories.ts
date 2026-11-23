// Blog categories for the Divi WXR export. Read from MAIN (as last published):
// the Blog Sync plugin reconciles WP terms against main's feed, so a draft-only
// category exported here would be deleted on the next sync. Missing, invalid or
// partially-corrupt → none (never a partial set). Never throws.
import { MAIN_BRANCH, FileNotFoundError, readFile } from '@/lib/github/repo-files'
import { CATEGORIES_PATH, parseCategoriesFileDetailed, type BlogCategory } from '@/lib/content/blog-categories'

export async function readExportCategories(githubRepo: string): Promise<BlogCategory[]> {
  let text: string
  try {
    text = (await readFile(githubRepo, CATEGORIES_PATH, MAIN_BRANCH)).content
  } catch (err) {
    if (!(err instanceof FileNotFoundError)) {
      console.warn('[export-divi] categories read failed; exporting without categories:', err)
    }
    return []
  }
  const { file, dropped } = parseCategoriesFileDetailed(text)
  if (!file || dropped > 0) {
    console.warn('[export-divi] categories.json on main is invalid; exporting without categories')
    return []
  }
  return file.categories
}
