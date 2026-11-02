// Few-shot exemplars injected into the content generators' cached static
// prefixes. Rules alone ("12-18 words, benefit-led") leave the model guessing at
// what "good" looks like; a single gold example does far more to lift quality and
// cut retries. These are JOB-CONSTANT strings — they live in the cached prefix so
// they cost one cache write per job, then ride as cache reads on every page.
//
// They are deliberately firm-agnostic (no real firm name/facts) so nothing here
// can leak into a specific client's copy — they demonstrate SHAPE and VOICE, not
// content to reuse. Every generator prompt already says "never copy verbatim".

// Weak-vs-strong pairs for the four failure modes that most often force a human
// edit: passive/self-focused hero subheads, run-on service-card descriptions,
// bloated-or-thin FAQ answers, and generic openers. Sent alongside ANTI_SLOP_RULES
// so the flagged-phrase retry rewrites TOWARD these patterns rather than swapping
// one hollow synonym for another.
export const WRITING_EXAMPLES = `WRITE LIKE THESE (study the ✓ / ✗ contrast — the ✗ versions are the exact mistakes to avoid):

Hero subhead (12-18 words, speaks to the reader's outcome):
  ✗ "Expert accounting and tax services from a trusted, dedicated team of professionals" (generic, self-focused, zero benefit)
  ✗ "We help businesses with all of their accounting and tax needs" (passive, vague, restates the obvious)
  ✓ "Know your tax exposure before year-end, so a surprise bill never derails your cash flow"
  ✓ "Clean books and a real plan, so you can price jobs and take draws with confidence"

Page opener (first paragraph — earn the read, name the reader's problem):
  ✗ "In today's fast-paced business environment, managing your finances is more important than ever. Our firm is dedicated to providing tailored solutions for all your needs." (filler, banned phrases, says nothing)
  ✓ "Most contractors we meet are profitable on paper and still short on cash. The gap is almost always in job costing and the timing of estimated taxes, and both are fixable once someone actually looks at the numbers."

Service-card description (1-3 tight sentences, concrete, not a run-on):
  ✗ "Our comprehensive tax planning service covers federal, state, and local obligations, including quarterly estimated payments, retirement contributions, entity structure optimization, and year-end reviews to minimize your overall tax burden." (one exhausting sentence, lists everything, lands nowhere)
  ✓ "Quarterly tax planning built around your actual numbers, not last year's. We model estimated payments and entity elections before the deadline, so nothing is a surprise in April."

FAQ answer (40-80 words, answer the question directly, then one useful specific — the FAQ carries the page's depth):
  ✗ "It depends on your situation. There are many factors involved, and we'd be happy to discuss your unique needs to find the best solution for you." (evasive, no information, pure deflection)
  ✓ "For most S-corps, a reasonable salary lands between 40 and 60 percent of net profit, with the rest taken as distributions. The IRS weighs your role, hours, and industry pay data, so we document the basis for the number rather than picking a round figure."`

// A compact, fully-annotated mini-page in the user-first page skeleton
// (page-structure.ts): short acknowledgement, a bulleted problem/solution list,
// ONE content-split with a real image annotation, process steps, and a
// page-specific CTA. Injected into the page-body generator so the dense
// block-annotation spec has a worked example to anchor on.
export const PAGE_BODY_EXEMPLAR = `WORKED EXAMPLE — a strong, lean page in the exact annotation format (illustrative firm; never copy its facts):

<!-- block: intro-text | variant: centered -->
## Bookkeeping that tells you something

Numbers you can't act on aren't worth much. We keep the books current to the week and turn them into the few figures that change what you do next.

<!-- block: checklist-section | variant: standalone -->
## Where small-business books usually break

- **Transactions pile up until January.** We categorize weekly, so you always know where you stand.
- **Reports nobody reads.** You get a two-page monthly summary, not a 40-page export.
- **Surprises at tax time.** Estimates are modeled every quarter against your real numbers.

<!-- block: content-split | variant: image-right | image: monthly-close-review.jpg | alt: "Accountant reviewing a monthly close with a small business owner at a laptop" | query: "accountant small business owner reviewing finances" -->
## A monthly close you'll actually read

Every month you get cash position, margin by service line, and anything that moved more than ten percent. When a trend needs attention, we flag it the same month.

<!-- block: process-steps | variant: vertical -->
## How we get you there

### Discovery call
We look at your current books and agree on what a useful month-end looks like.

### Cleanup
We reconcile the backlog so the first close starts clean.

### Monthly close and review
A clean close plus a short call to walk the numbers.

<!-- block: cta-banner | variant: color-bg -->
## Find out what your books are telling you

Send us last month's statements and we'll walk you through the three numbers that matter most for your business.

[Book a bookkeeping review](/contact)`

// A strong outline whose section descriptions are working briefs — each names the
// concrete input (a niche persona, a proof point, a keyword) it draws on. Injected
// into the outline generator to demonstrate the specificity the spec demands.
export const OUTLINE_EXEMPLAR = `EXAMPLE OF A STRONG OUTLINE (note how each description names a specific audience, pain, or proof — never a generic label):

{
  "h1": "Accounting for construction contractors",
  "sections": [
    { "h2": "Books that keep up with retainage and progress billing", "description": "Acknowledgement in the owner's own vocabulary (retainage, WIP, progress billing): we know why contractor books fall behind and we take that off your plate.", "word_count": 60 },
    { "h2": "Where contractor cash goes missing", "description": "Problem/solution as bullets: profitable-on-paper but cash-poor, untracked job costs, surprise tax bills in lumpy years, each paired with the fix.", "word_count": 130 },
    { "h2": "What you get every month", "description": "How it's delivered: WIP schedule, job-cost report, estimated-tax calendar, bonding-ready statements. Bullets; name the firm's Sage Intacct expertise.", "word_count": 110 },
    { "h2": "Contractors who bid bigger with clean financials", "description": "Validation from the firm context only: the bonding-ready reviewed statements proof point. Never invent a client or number.", "word_count": 60 },
    { "h2": "How we work with your team", "description": "Process steps: discovery call, cleanup, monthly close, quarterly planning. One or two sentences each.", "word_count": 100 },
    { "h2": "Get a job-costing review", "description": "Page-specific CTA: a job-costing review for contractors, button 'Book a job-costing review' to /contact.", "word_count": 40 }
  ],
  "target_keyword": "accounting for construction contractors",
  "notes": "Write to the owner-operator, not a CFO. Lead with cash flow, not compliance. Detail on WIP methods and bonding requirements goes in the FAQ."
}`

// Good/bad short-copy example for the interactive Generate Content assistant
// (LinkedIn bios, social posts). Not job-cached — the assistant builds its prompt
// per turn — but small enough that the grounding is worth the tokens.
export const SHORT_COPY_EXEMPLAR = `EXAMPLE — a LinkedIn bio in the house voice (illustrative; ground every real one in the profile facts):
  ✗ "Passionate CPA dedicated to empowering businesses to unlock their full potential with tailored, cutting-edge financial solutions." (every banned phrase at once, says nothing specific)
  ✓ "CPA who works with construction and trades businesses in the Merrimack Valley. I keep job costing honest and estimated taxes boring, so owners can price work and take draws without second-guessing the numbers."`
