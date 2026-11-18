'use client'

import { useMemo, useState } from 'react'
import HeaderImagePicker from './HeaderImagePicker'
import {
  bodyImageAnchors,
  bodyImageMarkdown,
  cleanImageAlt,
  extractBodyImages,
  insertBodyImage,
  setBodyImage,
  setBodyImageAlt,
} from '@/lib/editor/page-images'

const ALT_INPUT =
  'w-full text-xs font-body px-2.5 py-1.5 rounded border border-border-default focus:border-brand-cyan focus:outline-none'

function AltField({ value, placeholder, onChange }: { value: string; placeholder: string; onChange: (v: string) => void }) {
  return (
    <label className="block mt-2">
      <span className="block text-[11px] font-heading text-text-muted mb-0.5">
        Alt text (what the photo shows, for screen readers &amp; SEO)
      </span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={ALT_INPUT}
      />
    </label>
  )
}

// Every image a post shows, in one place: the featured image (frontmatter
// `image`) then each body image in reading order. Choosing another file
// re-points THIS post only; replacing a file for every page that uses it is the
// Image library's job.
export default function PostImagesPanel({
  sessionId,
  featured,
  featuredAlt,
  onFeaturedChange,
  onFeaturedAltChange,
  body,
  onBodyChange,
}: {
  sessionId: string
  featured: string
  featuredAlt: string
  onFeaturedChange: (filename: string) => void
  onFeaturedAltChange: (alt: string) => void
  body: string
  onBodyChange: (body: string) => void
}) {
  const bodyImages = useMemo(() => extractBodyImages(body), [body])
  const anchors = useMemo(() => bodyImageAnchors(body), [body])
  const [adding, setAdding] = useState(false)
  const [newFile, setNewFile] = useState('')
  const [newAlt, setNewAlt] = useState('')
  const [anchor, setAnchor] = useState<string>('end')

  const resetAdd = () => {
    setAdding(false)
    setNewFile('')
    setNewAlt('')
    setAnchor('end')
  }

  const addImage = () => {
    if (!newFile) return
    onBodyChange(insertBodyImage(body, bodyImageMarkdown(newFile, newAlt), anchor === 'end' ? null : Number(anchor)))
    resetAdd()
  }

  return (
    <section className="bg-surface-card border border-border-default rounded-lg p-4 space-y-5">
      <div>
        <h2 className="text-sm font-heading font-semibold text-brand-navy">Post images</h2>
        <p className="text-xs font-body text-text-muted mt-1">
          Swapping an image here changes this post only. Save to apply; WordPress picks up the change on its next sync.
        </p>
      </div>

      <div className="border border-border-default rounded-md p-3">
        <HeaderImagePicker
          sessionId={sessionId}
          label="Featured image"
          value={featured}
          onChange={onFeaturedChange}
        />
        {featured && (
          <AltField value={featuredAlt} placeholder="Describe the featured image" onChange={onFeaturedAltChange} />
        )}
      </div>

      {bodyImages.map((img, n) => (
        <div key={`${img.index}-${img.filename}`} className="border border-border-default rounded-md p-3">
          <HeaderImagePicker
            sessionId={sessionId}
            label={`Body image ${n + 1}`}
            value={img.filename}
            onChange={(filename) => onBodyChange(setBodyImage(body, img.index, filename || null))}
          />
          <AltField
            value={img.alt}
            placeholder="Describe the image"
            onChange={(alt) => onBodyChange(setBodyImageAlt(body, img.index, alt))}
          />
        </div>
      ))}

      {adding ? (
        <div className="border border-dashed border-brand-cyan rounded-md p-3 space-y-3">
          <HeaderImagePicker sessionId={sessionId} label="New body image" value={newFile} onChange={setNewFile} />
          <AltField value={newAlt} placeholder="Describe the image" onChange={(v) => setNewAlt(cleanImageAlt(v))} />
          <label className="block">
            <span className="block text-[11px] font-heading text-text-muted mb-0.5">Place it</span>
            <select
              value={anchor}
              onChange={(e) => setAnchor(e.target.value)}
              className="w-full text-xs font-body px-2.5 py-1.5 rounded border border-border-default focus:border-brand-cyan focus:outline-none bg-surface-card"
            >
              {anchors.map((h, i) => (
                <option key={`${i}-${h}`} value={String(i)}>
                  Under “{h.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '')}”
                </option>
              ))}
              <option value="end">At the end of the post</option>
            </select>
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={addImage}
              disabled={!newFile}
              className="bg-brand-cyan text-text-inverse font-heading font-semibold text-[11px] px-3 py-1 rounded-pill transition-all hover:bg-brand-cyan-dark disabled:bg-border-default disabled:text-text-muted"
            >
              Add to post
            </button>
            <button
              type="button"
              onClick={resetAdd}
              className="text-[11px] font-heading text-text-muted hover:text-text-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="border border-brand-navy text-brand-navy font-heading font-semibold text-[11px] px-3 py-1 rounded-pill transition-all hover:bg-brand-navy/5"
        >
          + Add image to body
        </button>
      )}
    </section>
  )
}
