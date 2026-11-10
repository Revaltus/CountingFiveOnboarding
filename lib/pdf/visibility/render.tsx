import { renderToBuffer } from '@react-pdf/renderer'
import type { VisibilityNarrative, VisibilityResult } from '@/lib/visibility/types'
import { VisibilityPdf } from './VisibilityPdf'

export async function renderVisibilityPdf(result: VisibilityResult, narrative: VisibilityNarrative, firmName: string): Promise<Buffer> {
  return renderToBuffer(<VisibilityPdf result={result} narrative={narrative} firmName={firmName} />)
}
