-- 086: optional FAQ section heading per generated page.
-- Industry pages title their FAQ "Common questions from <audience>" (prime.cpa
-- style); NULL keeps the default "Frequently Asked Questions About <title>".
ALTER TABLE generated_pages ADD COLUMN IF NOT EXISTS faq_heading text;
