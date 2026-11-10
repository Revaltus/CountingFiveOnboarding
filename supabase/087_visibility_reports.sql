-- ============================================================
-- 087: Visibility Reports — post-launch, five-audience report per client
-- ============================================================
--
-- sessions.live_site_url: the operator-confirmed address of the rebuilt site
-- (the old site stays in website_url). Pre-fills the run dialog.
--
-- visibility_reports: one row per report run. status flows
-- queued → running → draft → published (or error). `result` holds the typed
-- VisibilityResult (lib/visibility/types.ts), `narrative` the AI draft plus
-- operator edits. share_token is set only while published; the public page
-- looks up by it alone. Trends compare reports with equal rubric_version.
--
-- Idempotent. Apply, then regenerate types/database.ts.
-- ============================================================

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS live_site_url text DEFAULT NULL;

CREATE TABLE IF NOT EXISTS visibility_reports (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  url             text        NOT NULL,
  domain          text        NOT NULL,
  is_live_domain  boolean     NOT NULL DEFAULT true,
  status          text        NOT NULL DEFAULT 'queued'
                              CHECK (status IN ('queued', 'running', 'draft', 'published', 'error')),
  status_detail   text        DEFAULT NULL,
  error           text        DEFAULT NULL,
  attempts        int         NOT NULL DEFAULT 0,
  rubric_version  text        DEFAULT NULL,
  overall_score   int         DEFAULT NULL,
  overall_grade   text        DEFAULT NULL,
  audience_scores jsonb       DEFAULT NULL,
  result          jsonb       DEFAULT NULL,
  narrative       jsonb       DEFAULT NULL,
  share_token     uuid        DEFAULT NULL UNIQUE,
  published_at    timestamptz DEFAULT NULL,
  published_by    uuid        DEFAULT NULL REFERENCES admins(id) ON DELETE SET NULL,
  pdf_path        text        DEFAULT NULL,
  created_by      uuid        DEFAULT NULL REFERENCES admins(id) ON DELETE SET NULL,
  started_at      timestamptz DEFAULT NULL,
  completed_at    timestamptz DEFAULT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS visibility_reports_session_idx
  ON visibility_reports (session_id, created_at DESC);

ALTER TABLE visibility_reports ENABLE ROW LEVEL SECURITY;

-- Admin-table membership, like every session-scoped table. Per-client scoping
-- (managers → manager_clients) is enforced in app code; routes use the
-- service-role client.
DROP POLICY IF EXISTS "Admins manage visibility_reports" ON visibility_reports;
CREATE POLICY "Admins manage visibility_reports"
  ON visibility_reports FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admins WHERE admins.id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM admins WHERE admins.id = auth.uid()));

-- ------------------------------------------------------------
-- Verify (read-only; run after applying):
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'sessions' AND column_name = 'live_site_url';      -- 1 row
--   SELECT rowsecurity FROM pg_tables WHERE tablename = 'visibility_reports'; -- true
-- ------------------------------------------------------------
