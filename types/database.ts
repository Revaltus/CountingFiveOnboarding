export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      admins: {
        Row: {
          capabilities: string[]
          created_at: string
          email: string
          id: string
          name: string
          role: string
        }
        Insert: {
          capabilities?: string[]
          created_at?: string
          email: string
          id: string
          name: string
          role?: string
        }
        Update: {
          capabilities?: string[]
          created_at?: string
          email?: string
          id?: string
          name?: string
          role?: string
        }
        Relationships: []
      }
      ai_service_status: {
        Row: {
          credit_exhausted_at: string | null
          id: boolean
          outage_kind: string | null
          updated_at: string
          usage_limit_resets_on: string | null
        }
        Insert: {
          credit_exhausted_at?: string | null
          id?: boolean
          outage_kind?: string | null
          updated_at?: string
          usage_limit_resets_on?: string | null
        }
        Update: {
          credit_exhausted_at?: string | null
          id?: boolean
          outage_kind?: string | null
          updated_at?: string
          usage_limit_resets_on?: string | null
        }
        Relationships: []
      }
      assets: {
        Row: {
          asset_category: string | null
          file_name: string
          file_size_bytes: number | null
          id: string
          metadata: Json | null
          mime_type: string
          public_url: string | null
          session_id: string
          storage_path: string
          uploaded_at: string
        }
        Insert: {
          asset_category?: string | null
          file_name: string
          file_size_bytes?: number | null
          id?: string
          metadata?: Json | null
          mime_type: string
          public_url?: string | null
          session_id: string
          storage_path: string
          uploaded_at?: string
        }
        Update: {
          asset_category?: string | null
          file_name?: string
          file_size_bytes?: number | null
          id?: string
          metadata?: Json | null
          mime_type?: string
          public_url?: string | null
          session_id?: string
          storage_path?: string
          uploaded_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "assets_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_batches: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          label: string | null
          status: string
          total_count: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          label?: string | null
          status?: string
          total_count: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          label?: string | null
          status?: string
          total_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_batches_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "admins"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_messages: {
        Row: {
          audit_run_id: string
          content: string
          created_at: string
          id: string
          role: string
        }
        Insert: {
          audit_run_id: string
          content: string
          created_at?: string
          id?: string
          role: string
        }
        Update: {
          audit_run_id?: string
          content?: string
          created_at?: string
          id?: string
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_messages_audit_run_id_fkey"
            columns: ["audit_run_id"]
            isOneToOne: false
            referencedRelation: "audit_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_runs: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          audit_batch_id: string | null
          audit_group: string
          audit_status: string
          category_scores: Json | null
          completed_at: string | null
          created_at: string
          created_by: string | null
          domain: string
          error_message: string | null
          focus_segments: string[] | null
          id: string
          max_pages: number
          overall_grade: string | null
          overall_score: number | null
          pages_crawled: number | null
          result: Json | null
          session_id: string | null
          share_token: string | null
          shared_at: string | null
          site_name: string | null
          started_at: string | null
          status_detail: string | null
          url: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          audit_batch_id?: string | null
          audit_group?: string
          audit_status?: string
          category_scores?: Json | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          domain: string
          error_message?: string | null
          focus_segments?: string[] | null
          id?: string
          max_pages?: number
          overall_grade?: string | null
          overall_score?: number | null
          pages_crawled?: number | null
          result?: Json | null
          session_id?: string | null
          share_token?: string | null
          shared_at?: string | null
          site_name?: string | null
          started_at?: string | null
          status_detail?: string | null
          url: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          audit_batch_id?: string | null
          audit_group?: string
          audit_status?: string
          category_scores?: Json | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          domain?: string
          error_message?: string | null
          focus_segments?: string[] | null
          id?: string
          max_pages?: number
          overall_grade?: string | null
          overall_score?: number | null
          pages_crawled?: number | null
          result?: Json | null
          session_id?: string | null
          share_token?: string | null
          shared_at?: string | null
          site_name?: string | null
          started_at?: string | null
          status_detail?: string | null
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_runs_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "admins"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_runs_audit_batch_id_fkey"
            columns: ["audit_batch_id"]
            isOneToOne: false
            referencedRelation: "audit_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_runs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "admins"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_runs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      blog_batch_targets: {
        Row: {
          attempts: number
          batch_id: string
          content_job_id: string
          content_type: string
          created_at: string
          error: string | null
          id: string
          industry: string
          resource_idea_id: string | null
          session_id: string
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          batch_id: string
          content_job_id: string
          content_type?: string
          created_at?: string
          error?: string | null
          id?: string
          industry?: string
          resource_idea_id?: string | null
          session_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          batch_id?: string
          content_job_id?: string
          content_type?: string
          created_at?: string
          error?: string | null
          id?: string
          industry?: string
          resource_idea_id?: string | null
          session_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "blog_batch_targets_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "blog_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blog_batch_targets_content_job_id_fkey"
            columns: ["content_job_id"]
            isOneToOne: false
            referencedRelation: "content_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blog_batch_targets_resource_idea_id_fkey"
            columns: ["resource_idea_id"]
            isOneToOne: false
            referencedRelation: "resource_ideas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blog_batch_targets_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      blog_batches: {
        Row: {
          angle: string | null
          content_type: string
          created_at: string
          created_by: string | null
          id: string
          industry: string
          rationale: string | null
          secondary_keywords: Json
          seed: string | null
          status: string
          target_keyword: string | null
          title: string
          updated_at: string
        }
        Insert: {
          angle?: string | null
          content_type?: string
          created_at?: string
          created_by?: string | null
          id?: string
          industry?: string
          rationale?: string | null
          secondary_keywords?: Json
          seed?: string | null
          status?: string
          target_keyword?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          angle?: string | null
          content_type?: string
          created_at?: string
          created_by?: string | null
          id?: string
          industry?: string
          rationale?: string | null
          secondary_keywords?: Json
          seed?: string | null
          status?: string
          target_keyword?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "blog_batches_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "admins"
            referencedColumns: ["id"]
          },
        ]
      }
      content_edit_stats: {
        Row: {
          computed_at: string
          head_sha: string
          session_id: string
          stats: Json
        }
        Insert: {
          computed_at?: string
          head_sha: string
          session_id: string
          stats: Json
        }
        Update: {
          computed_at?: string
          head_sha?: string
          session_id?: string
          stats?: Json
        }
        Relationships: [
          {
            foreignKeyName: "content_edit_stats_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: true
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      content_job_article_imports: {
        Row: {
          attempts: number
          audit_run_id: string
          content_job_id: string
          created_at: string
          draft_commit_sha: string | null
          draft_path: string | null
          error: string | null
          id: string
          session_id: string
          slug: string | null
          source_title: string | null
          source_url: string
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          audit_run_id: string
          content_job_id: string
          created_at?: string
          draft_commit_sha?: string | null
          draft_path?: string | null
          error?: string | null
          id?: string
          session_id: string
          slug?: string | null
          source_title?: string | null
          source_url: string
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          audit_run_id?: string
          content_job_id?: string
          created_at?: string
          draft_commit_sha?: string | null
          draft_path?: string | null
          error?: string | null
          id?: string
          session_id?: string
          slug?: string | null
          source_title?: string | null
          source_url?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "content_job_article_imports_audit_run_id_fkey"
            columns: ["audit_run_id"]
            isOneToOne: false
            referencedRelation: "audit_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_job_article_imports_content_job_id_fkey"
            columns: ["content_job_id"]
            isOneToOne: false
            referencedRelation: "content_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_job_article_imports_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      content_job_library_selections: {
        Row: {
          attempts: number
          batch_id: string
          content_job_id: string
          created_at: string
          error: string | null
          id: string
          resource_idea_id: string | null
          session_id: string
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          batch_id: string
          content_job_id: string
          created_at?: string
          error?: string | null
          id?: string
          resource_idea_id?: string | null
          session_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          batch_id?: string
          content_job_id?: string
          created_at?: string
          error?: string | null
          id?: string
          resource_idea_id?: string | null
          session_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "content_job_library_selections_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "blog_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_job_library_selections_content_job_id_fkey"
            columns: ["content_job_id"]
            isOneToOne: false
            referencedRelation: "content_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_job_library_selections_resource_idea_id_fkey"
            columns: ["resource_idea_id"]
            isOneToOne: false
            referencedRelation: "resource_ideas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_job_library_selections_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      content_jobs: {
        Row: {
          articles_reviewed_at: string | null
          confirmed_sitemap: Json | null
          created_at: string
          created_by: string | null
          design_tokens: Json | null
          error_message: string | null
          github_repo: string | null
          id: string
          library_reviewed_at: string | null
          nav_config: Json | null
          palette: Json | null
          phase: number
          preview_url: string | null
          session_id: string
          status: string
          updated_at: string
        }
        Insert: {
          articles_reviewed_at?: string | null
          confirmed_sitemap?: Json | null
          created_at?: string
          created_by?: string | null
          design_tokens?: Json | null
          error_message?: string | null
          github_repo?: string | null
          id?: string
          library_reviewed_at?: string | null
          nav_config?: Json | null
          palette?: Json | null
          phase?: number
          preview_url?: string | null
          session_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          articles_reviewed_at?: string | null
          confirmed_sitemap?: Json | null
          created_at?: string
          created_by?: string | null
          design_tokens?: Json | null
          error_message?: string | null
          github_repo?: string | null
          id?: string
          library_reviewed_at?: string | null
          nav_config?: Json | null
          palette?: Json | null
          phase?: number
          preview_url?: string | null
          session_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "content_jobs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "admins"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_jobs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      design_chat_messages: {
        Row: {
          attachment_ids: string[]
          content: string
          created_at: string
          created_by: string | null
          id: string
          parts: Json | null
          role: string
          session_id: string
          version_id: string | null
        }
        Insert: {
          attachment_ids?: string[]
          content?: string
          created_at?: string
          created_by?: string | null
          id?: string
          parts?: Json | null
          role: string
          session_id: string
          version_id?: string | null
        }
        Update: {
          attachment_ids?: string[]
          content?: string
          created_at?: string
          created_by?: string | null
          id?: string
          parts?: Json | null
          role?: string
          session_id?: string
          version_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "design_chat_messages_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "admins"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "design_chat_messages_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "design_chat_messages_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "design_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      design_chat_state: {
        Row: {
          adopted_concept_id: string | null
          session_id: string
          updated_at: string
        }
        Insert: {
          adopted_concept_id?: string | null
          session_id: string
          updated_at?: string
        }
        Update: {
          adopted_concept_id?: string | null
          session_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "design_chat_state_adopted_concept_id_fkey"
            columns: ["adopted_concept_id"]
            isOneToOne: false
            referencedRelation: "design_concepts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "design_chat_state_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: true
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      design_concepts: {
        Row: {
          bundle: Json | null
          cost_usd: number
          created_at: string
          critique: Json | null
          error: string | null
          id: string
          initial_bundle: Json | null
          iterations: number
          position: number
          run_id: string
          screenshots: Json
          session_id: string
          status: string
          updated_at: string
        }
        Insert: {
          bundle?: Json | null
          cost_usd?: number
          created_at?: string
          critique?: Json | null
          error?: string | null
          id?: string
          initial_bundle?: Json | null
          iterations?: number
          position: number
          run_id: string
          screenshots?: Json
          session_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          bundle?: Json | null
          cost_usd?: number
          created_at?: string
          critique?: Json | null
          error?: string | null
          id?: string
          initial_bundle?: Json | null
          iterations?: number
          position?: number
          run_id?: string
          screenshots?: Json
          session_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "design_concepts_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "design_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "design_concepts_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      design_inputs: {
        Row: {
          archived: boolean
          capture_error: string | null
          capture_status: string
          captured_at: string | null
          created_at: string
          created_by: string | null
          id: string
          kind: string
          label: string | null
          notes: string | null
          session_id: string
          storage_path: string | null
          updated_at: string
          url: string | null
        }
        Insert: {
          archived?: boolean
          capture_error?: string | null
          capture_status?: string
          captured_at?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          kind: string
          label?: string | null
          notes?: string | null
          session_id: string
          storage_path?: string | null
          updated_at?: string
          url?: string | null
        }
        Update: {
          archived?: boolean
          capture_error?: string | null
          capture_status?: string
          captured_at?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          kind?: string
          label?: string | null
          notes?: string | null
          session_id?: string
          storage_path?: string | null
          updated_at?: string
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "design_inputs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "admins"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "design_inputs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      design_locks: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          key: string
          kind: string
          label: string
          session_id: string
          snapshot: Json | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          key: string
          kind: string
          label?: string
          session_id: string
          snapshot?: Json | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          key?: string
          kind?: string
          label?: string
          session_id?: string
          snapshot?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "design_locks_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "admins"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "design_locks_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      design_runs: {
        Row: {
          admin_brief: string | null
          base_snapshot: Json | null
          capabilities: Json
          concept_count: number
          cost_cap_usd: number
          cost_usd: number
          created_at: string
          created_by: string | null
          error: string | null
          id: string
          input_ids: string[]
          max_revisions: number
          palette_freedom: string
          session_id: string
          stage: string | null
          status: string
          updated_at: string
        }
        Insert: {
          admin_brief?: string | null
          base_snapshot?: Json | null
          capabilities?: Json
          concept_count?: number
          cost_cap_usd?: number
          cost_usd?: number
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          input_ids?: string[]
          max_revisions?: number
          palette_freedom?: string
          session_id: string
          stage?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          admin_brief?: string | null
          base_snapshot?: Json | null
          capabilities?: Json
          concept_count?: number
          cost_cap_usd?: number
          cost_usd?: number
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          input_ids?: string[]
          max_revisions?: number
          palette_freedom?: string
          session_id?: string
          stage?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "design_runs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "admins"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "design_runs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      design_versions: {
        Row: {
          applied_blobs: Json
          applied_commit_sha: string | null
          bundle: Json
          concept_id: string | null
          created_at: string
          created_by: string | null
          id: string
          screenshots: Json
          session_id: string
          source: string
          summary: string | null
          version_no: number
        }
        Insert: {
          applied_blobs?: Json
          applied_commit_sha?: string | null
          bundle: Json
          concept_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          screenshots?: Json
          session_id: string
          source: string
          summary?: string | null
          version_no: number
        }
        Update: {
          applied_blobs?: Json
          applied_commit_sha?: string | null
          bundle?: Json
          concept_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          screenshots?: Json
          session_id?: string
          source?: string
          summary?: string | null
          version_no?: number
        }
        Relationships: [
          {
            foreignKeyName: "design_versions_concept_id_fkey"
            columns: ["concept_id"]
            isOneToOne: false
            referencedRelation: "design_concepts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "design_versions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "admins"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "design_versions_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      generated_pages: {
        Row: {
          admin_approved_content: boolean
          answer_block: string | null
          canonical_url: string | null
          client_approved_content: boolean
          content_job_id: string
          content_markdown: string | null
          created_at: string
          critic_review: Json | null
          eeat_signals: Json | null
          faq_block: Json | null
          faq_heading: string | null
          generation_attempts: number
          generation_error: string | null
          generation_started_at: string | null
          generation_status: string
          hero_block: string
          hero_image: string | null
          hero_image_alt: string | null
          hero_image_query: string | null
          hero_subhead: string | null
          hero_variant: string | null
          id: string
          internal_links: Json | null
          llm_citation_note: string | null
          meta_description: string | null
          meta_title: string | null
          needs_client_review: boolean
          page_title: string
          page_url: string
          qa_attempts: number
          qa_review: Json | null
          qa_started_at: string | null
          qa_status: string | null
          schema_markup_type: string | null
          secondary_keywords: Json | null
          target_keyword: string | null
          url_slug: string | null
          word_count_actual: number | null
          word_count_target: number | null
        }
        Insert: {
          admin_approved_content?: boolean
          answer_block?: string | null
          canonical_url?: string | null
          client_approved_content?: boolean
          content_job_id: string
          content_markdown?: string | null
          created_at?: string
          critic_review?: Json | null
          eeat_signals?: Json | null
          faq_block?: Json | null
          faq_heading?: string | null
          generation_attempts?: number
          generation_error?: string | null
          generation_started_at?: string | null
          generation_status?: string
          hero_block?: string
          hero_image?: string | null
          hero_image_alt?: string | null
          hero_image_query?: string | null
          hero_subhead?: string | null
          hero_variant?: string | null
          id?: string
          internal_links?: Json | null
          llm_citation_note?: string | null
          meta_description?: string | null
          meta_title?: string | null
          needs_client_review?: boolean
          page_title: string
          page_url: string
          qa_attempts?: number
          qa_review?: Json | null
          qa_started_at?: string | null
          qa_status?: string | null
          schema_markup_type?: string | null
          secondary_keywords?: Json | null
          target_keyword?: string | null
          url_slug?: string | null
          word_count_actual?: number | null
          word_count_target?: number | null
        }
        Update: {
          admin_approved_content?: boolean
          answer_block?: string | null
          canonical_url?: string | null
          client_approved_content?: boolean
          content_job_id?: string
          content_markdown?: string | null
          created_at?: string
          critic_review?: Json | null
          eeat_signals?: Json | null
          faq_block?: Json | null
          faq_heading?: string | null
          generation_attempts?: number
          generation_error?: string | null
          generation_started_at?: string | null
          generation_status?: string
          hero_block?: string
          hero_image?: string | null
          hero_image_alt?: string | null
          hero_image_query?: string | null
          hero_subhead?: string | null
          hero_variant?: string | null
          id?: string
          internal_links?: Json | null
          llm_citation_note?: string | null
          meta_description?: string | null
          meta_title?: string | null
          needs_client_review?: boolean
          page_title?: string
          page_url?: string
          qa_attempts?: number
          qa_review?: Json | null
          qa_started_at?: string | null
          qa_status?: string | null
          schema_markup_type?: string | null
          secondary_keywords?: Json | null
          target_keyword?: string | null
          url_slug?: string | null
          word_count_actual?: number | null
          word_count_target?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "generated_pages_content_job_id_fkey"
            columns: ["content_job_id"]
            isOneToOne: false
            referencedRelation: "content_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      manager_clients: {
        Row: {
          created_at: string
          id: string
          manager_id: string
          session_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          manager_id: string
          session_id: string
        }
        Update: {
          created_at?: string
          id?: string
          manager_id?: string
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "manager_clients_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "admins"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "manager_clients_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      mbp_messages: {
        Row: {
          content: string
          created_at: string
          id: string
          role: string
          session_id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          role: string
          session_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          role?: string
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "mbp_messages_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      mbp_suggestions: {
        Row: {
          changes: Json
          created_at: string
          dedupe_key: string
          id: string
          origin: string
          resolved_at: string | null
          resolved_by: string | null
          session_id: string
          source_ref: string | null
          status: string
          summary: string
        }
        Insert: {
          changes: Json
          created_at?: string
          dedupe_key: string
          id?: string
          origin: string
          resolved_at?: string | null
          resolved_by?: string | null
          session_id: string
          source_ref?: string | null
          status?: string
          summary: string
        }
        Update: {
          changes?: Json
          created_at?: string
          dedupe_key?: string
          id?: string
          origin?: string
          resolved_at?: string | null
          resolved_by?: string | null
          session_id?: string
          source_ref?: string | null
          status?: string
          summary?: string
        }
        Relationships: [
          {
            foreignKeyName: "mbp_suggestions_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "admins"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mbp_suggestions_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          content: string
          created_at: string
          id: string
          role: string
          session_id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          role: string
          session_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          role?: string
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      new_page_generations: {
        Row: {
          brief: string | null
          content_job_id: string
          created_at: string
          error: string | null
          id: string
          page_url: string
          session_id: string
          starter_sha: string | null
          status: string
          target_path: string
          title: string
          updated_at: string
        }
        Insert: {
          brief?: string | null
          content_job_id: string
          created_at?: string
          error?: string | null
          id?: string
          page_url: string
          session_id: string
          starter_sha?: string | null
          status?: string
          target_path: string
          title: string
          updated_at?: string
        }
        Update: {
          brief?: string | null
          content_job_id?: string
          created_at?: string
          error?: string | null
          id?: string
          page_url?: string
          session_id?: string
          starter_sha?: string | null
          status?: string
          target_path?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "new_page_generations_content_job_id_fkey"
            columns: ["content_job_id"]
            isOneToOne: false
            referencedRelation: "content_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "new_page_generations_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      no_go_phrases: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          note: string | null
          phrase: string
          phrase_normalized: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          phrase: string
          phrase_normalized: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          phrase?: string
          phrase_normalized?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "no_go_phrases_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "admins"
            referencedColumns: ["id"]
          },
        ]
      }
      oneoff_generations: {
        Row: {
          content_job_id: string
          context: Json
          created_at: string
          error: string | null
          id: string
          options: Json
          prompt: string
          session_id: string
          status: string
          updated_at: string
        }
        Insert: {
          content_job_id: string
          context?: Json
          created_at?: string
          error?: string | null
          id?: string
          options?: Json
          prompt: string
          session_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          content_job_id?: string
          context?: Json
          created_at?: string
          error?: string | null
          id?: string
          options?: Json
          prompt?: string
          session_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "oneoff_generations_content_job_id_fkey"
            columns: ["content_job_id"]
            isOneToOne: false
            referencedRelation: "content_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "oneoff_generations_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      page_outlines: {
        Row: {
          admin_approved: boolean
          admin_notes: string | null
          angle: string | null
          content_job_id: string
          created_at: string
          cta: Json | null
          generation_claimed_at: string | null
          generation_mode: string
          h1: string | null
          id: string
          merge_source_urls: string[]
          page_title: string
          page_url: string
          sections: Json | null
          source_snapshot_path: string | null
          target_keyword: string | null
          updated_at: string
        }
        Insert: {
          admin_approved?: boolean
          admin_notes?: string | null
          angle?: string | null
          content_job_id: string
          created_at?: string
          cta?: Json | null
          generation_claimed_at?: string | null
          generation_mode?: string
          h1?: string | null
          id?: string
          merge_source_urls?: string[]
          page_title: string
          page_url: string
          sections?: Json | null
          source_snapshot_path?: string | null
          target_keyword?: string | null
          updated_at?: string
        }
        Update: {
          admin_approved?: boolean
          admin_notes?: string | null
          angle?: string | null
          content_job_id?: string
          created_at?: string
          cta?: Json | null
          generation_claimed_at?: string | null
          generation_mode?: string
          h1?: string | null
          id?: string
          merge_source_urls?: string[]
          page_title?: string
          page_url?: string
          sections?: Json | null
          source_snapshot_path?: string | null
          target_keyword?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "page_outlines_content_job_id_fkey"
            columns: ["content_job_id"]
            isOneToOne: false
            referencedRelation: "content_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      pricing_calculators: {
        Row: {
          config: Json
          created_at: string
          enabled: boolean
          id: string
          session_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          config: Json
          created_at?: string
          enabled?: boolean
          id?: string
          session_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          config?: Json
          created_at?: string
          enabled?: boolean
          id?: string
          session_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pricing_calculators_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: true
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pricing_calculators_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "admins"
            referencedColumns: ["id"]
          },
        ]
      }
      pricing_plans: {
        Row: {
          config: Json
          created_at: string
          enabled: boolean
          id: string
          session_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          config: Json
          created_at?: string
          enabled?: boolean
          id?: string
          session_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          config?: Json
          created_at?: string
          enabled?: boolean
          id?: string
          session_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pricing_plans_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: true
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pricing_plans_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "admins"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_limit_events: {
        Row: {
          created_at: string
          id: string
          key: string
        }
        Insert: {
          created_at?: string
          id?: string
          key: string
        }
        Update: {
          created_at?: string
          id?: string
          key?: string
        }
        Relationships: []
      }
      reminders: {
        Row: {
          days_inactive: number
          id: string
          sent_at: string
          session_id: string
        }
        Insert: {
          days_inactive: number
          id?: string
          sent_at?: string
          session_id: string
        }
        Update: {
          days_inactive?: number
          id?: string
          sent_at?: string
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reminders_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      research_results: {
        Row: {
          competitor_references: Json | null
          content_job_id: string
          created_at: string
          error_message: string | null
          existing_content: string | null
          id: string
          merged_content: string | null
          page_title: string
          page_url: string
          research_status: string
          secondary_keywords: Json | null
          target_keyword: string | null
          updated_at: string
        }
        Insert: {
          competitor_references?: Json | null
          content_job_id: string
          created_at?: string
          error_message?: string | null
          existing_content?: string | null
          id?: string
          merged_content?: string | null
          page_title: string
          page_url: string
          research_status?: string
          secondary_keywords?: Json | null
          target_keyword?: string | null
          updated_at?: string
        }
        Update: {
          competitor_references?: Json | null
          content_job_id?: string
          created_at?: string
          error_message?: string | null
          existing_content?: string | null
          id?: string
          merged_content?: string | null
          page_title?: string
          page_url?: string
          research_status?: string
          secondary_keywords?: Json | null
          target_keyword?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "research_results_content_job_id_fkey"
            columns: ["content_job_id"]
            isOneToOne: false
            referencedRelation: "content_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      resource_ideas: {
        Row: {
          angle: string | null
          content_job_id: string
          content_type: string
          created_at: string
          critic_review: Json | null
          draft_commit_sha: string | null
          draft_error: string | null
          draft_notes: string | null
          draft_path: string | null
          draft_status: string
          external_links: Json
          id: string
          industry: string
          rationale: string | null
          reverse_links: Json
          score: number | null
          score_breakdown: Json
          secondary_keywords: Json
          session_id: string
          slug: string | null
          social_path: string | null
          social_status: string
          status: string
          target_keyword: string | null
          title: string
          updated_at: string
        }
        Insert: {
          angle?: string | null
          content_job_id: string
          content_type?: string
          created_at?: string
          critic_review?: Json | null
          draft_commit_sha?: string | null
          draft_error?: string | null
          draft_notes?: string | null
          draft_path?: string | null
          draft_status?: string
          external_links?: Json
          id?: string
          industry?: string
          rationale?: string | null
          reverse_links?: Json
          score?: number | null
          score_breakdown?: Json
          secondary_keywords?: Json
          session_id: string
          slug?: string | null
          social_path?: string | null
          social_status?: string
          status?: string
          target_keyword?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          angle?: string | null
          content_job_id?: string
          content_type?: string
          created_at?: string
          critic_review?: Json | null
          draft_commit_sha?: string | null
          draft_error?: string | null
          draft_notes?: string | null
          draft_path?: string | null
          draft_status?: string
          external_links?: Json
          id?: string
          industry?: string
          rationale?: string | null
          reverse_links?: Json
          score?: number | null
          score_breakdown?: Json
          secondary_keywords?: Json
          session_id?: string
          slug?: string | null
          social_path?: string | null
          social_status?: string
          status?: string
          target_keyword?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "resource_ideas_content_job_id_fkey"
            columns: ["content_job_id"]
            isOneToOne: false
            referencedRelation: "content_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "resource_ideas_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      sessions: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          call_notes: string | null
          client_email: string | null
          completed_at: string | null
          content_generation_phase: number | null
          content_generation_ready: boolean
          content_generation_started_at: string | null
          created_at: string
          created_by: string | null
          current_phase: number
          gap_list: Json
          id: string
          last_activity_at: string
          live_site_url: string | null
          mbp_content: string | null
          notes_extracted_at: string | null
          pdf_url: string | null
          processing: boolean
          reminder_count: number
          schema_data: Json
          schema_version: number
          status: string
          website_url: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          call_notes?: string | null
          client_email?: string | null
          completed_at?: string | null
          content_generation_phase?: number | null
          content_generation_ready?: boolean
          content_generation_started_at?: string | null
          created_at?: string
          created_by?: string | null
          current_phase?: number
          gap_list?: Json
          id?: string
          last_activity_at?: string
          live_site_url?: string | null
          mbp_content?: string | null
          notes_extracted_at?: string | null
          pdf_url?: string | null
          processing?: boolean
          reminder_count?: number
          schema_data?: Json
          schema_version?: number
          status?: string
          website_url: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          call_notes?: string | null
          client_email?: string | null
          completed_at?: string | null
          content_generation_phase?: number | null
          content_generation_ready?: boolean
          content_generation_started_at?: string | null
          created_at?: string
          created_by?: string | null
          current_phase?: number
          gap_list?: Json
          id?: string
          last_activity_at?: string
          live_site_url?: string | null
          mbp_content?: string | null
          notes_extracted_at?: string | null
          pdf_url?: string | null
          processing?: boolean
          reminder_count?: number
          schema_data?: Json
          schema_version?: number
          status?: string
          website_url?: string
        }
        Relationships: [
          {
            foreignKeyName: "sessions_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "admins"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sessions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "admins"
            referencedColumns: ["id"]
          },
        ]
      }
      site_settings: {
        Row: {
          booking_provider: string
          booking_url: string
          created_at: string
          id: string
          session_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          booking_provider?: string
          booking_url?: string
          created_at?: string
          id?: string
          session_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          booking_provider?: string
          booking_url?: string
          created_at?: string
          id?: string
          session_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "site_settings_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: true
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "admins"
            referencedColumns: ["id"]
          },
        ]
      }
      task_progress: {
        Row: {
          content_job_id: string | null
          created_at: string
          created_by: string | null
          current: number
          id: string
          kind: string
          message: string | null
          phase: string | null
          session_id: string | null
          state: string
          total: number
          updated_at: string
        }
        Insert: {
          content_job_id?: string | null
          created_at?: string
          created_by?: string | null
          current?: number
          id: string
          kind: string
          message?: string | null
          phase?: string | null
          session_id?: string | null
          state?: string
          total?: number
          updated_at?: string
        }
        Update: {
          content_job_id?: string | null
          created_at?: string
          created_by?: string | null
          current?: number
          id?: string
          kind?: string
          message?: string | null
          phase?: string | null
          session_id?: string | null
          state?: string
          total?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_progress_content_job_id_fkey"
            columns: ["content_job_id"]
            isOneToOne: false
            referencedRelation: "content_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_progress_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      token_usage: {
        Row: {
          audit_id: string | null
          cache_creation_input_tokens: number
          cache_read_input_tokens: number
          content_job_id: string | null
          cost_usd: number
          created_at: string
          created_by: string | null
          id: string
          input_tokens: number
          model: string
          output_tokens: number
          page_url: string | null
          session_id: string | null
          stage: string
          task: string
        }
        Insert: {
          audit_id?: string | null
          cache_creation_input_tokens?: number
          cache_read_input_tokens?: number
          content_job_id?: string | null
          cost_usd?: number
          created_at?: string
          created_by?: string | null
          id?: string
          input_tokens?: number
          model: string
          output_tokens?: number
          page_url?: string | null
          session_id?: string | null
          stage: string
          task?: string
        }
        Update: {
          audit_id?: string | null
          cache_creation_input_tokens?: number
          cache_read_input_tokens?: number
          content_job_id?: string | null
          cost_usd?: number
          created_at?: string
          created_by?: string | null
          id?: string
          input_tokens?: number
          model?: string
          output_tokens?: number
          page_url?: string | null
          session_id?: string | null
          stage?: string
          task?: string
        }
        Relationships: [
          {
            foreignKeyName: "token_usage_audit_id_fkey"
            columns: ["audit_id"]
            isOneToOne: false
            referencedRelation: "audit_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "token_usage_content_job_id_fkey"
            columns: ["content_job_id"]
            isOneToOne: false
            referencedRelation: "content_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "token_usage_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "admins"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "token_usage_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      visibility_reports: {
        Row: {
          attempts: number
          audience_scores: Json | null
          completed_at: string | null
          created_at: string
          created_by: string | null
          domain: string
          error: string | null
          id: string
          is_live_domain: boolean
          narrative: Json | null
          overall_grade: string | null
          overall_score: number | null
          pdf_path: string | null
          published_at: string | null
          published_by: string | null
          result: Json | null
          rubric_version: string | null
          session_id: string
          share_token: string | null
          started_at: string | null
          status: string
          status_detail: string | null
          updated_at: string
          url: string
        }
        Insert: {
          attempts?: number
          audience_scores?: Json | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          domain: string
          error?: string | null
          id?: string
          is_live_domain?: boolean
          narrative?: Json | null
          overall_grade?: string | null
          overall_score?: number | null
          pdf_path?: string | null
          published_at?: string | null
          published_by?: string | null
          result?: Json | null
          rubric_version?: string | null
          session_id: string
          share_token?: string | null
          started_at?: string | null
          status?: string
          status_detail?: string | null
          updated_at?: string
          url: string
        }
        Update: {
          attempts?: number
          audience_scores?: Json | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          domain?: string
          error?: string | null
          id?: string
          is_live_domain?: boolean
          narrative?: Json | null
          overall_grade?: string | null
          overall_score?: number | null
          pdf_path?: string | null
          published_at?: string | null
          published_by?: string | null
          result?: Json | null
          rubric_version?: string | null
          session_id?: string
          share_token?: string | null
          started_at?: string | null
          status?: string
          status_detail?: string | null
          updated_at?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "visibility_reports_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "admins"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visibility_reports_published_by_fkey"
            columns: ["published_by"]
            isOneToOne: false
            referencedRelation: "admins"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visibility_reports_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      wordpress_sites: {
        Row: {
          created_at: string
          enabled: boolean
          github_repo: string
          id: string
          secret: string
          site_key: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          github_repo: string
          id?: string
          secret: string
          site_key: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          github_repo?: string
          id?: string
          secret?: string
          site_key?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      qa_apply_page_update: {
        Args: {
          p_content: string
          p_content_changed: boolean
          p_expected_content_md5: string
          p_expected_rev: number
          p_job_id: string
          p_meta_description: string
          p_meta_title: string
          p_page_id: string
          p_qa_review: Json
        }
        Returns: {
          admin_approved_content: boolean
          answer_block: string | null
          canonical_url: string | null
          client_approved_content: boolean
          content_job_id: string
          content_markdown: string | null
          created_at: string
          critic_review: Json | null
          eeat_signals: Json | null
          faq_block: Json | null
          generation_attempts: number
          generation_error: string | null
          generation_started_at: string | null
          generation_status: string
          hero_block: string
          hero_image: string | null
          hero_image_alt: string | null
          hero_image_query: string | null
          hero_subhead: string | null
          hero_variant: string | null
          id: string
          internal_links: Json | null
          llm_citation_note: string | null
          meta_description: string | null
          meta_title: string | null
          needs_client_review: boolean
          page_title: string
          page_url: string
          qa_attempts: number
          qa_review: Json | null
          qa_started_at: string | null
          qa_status: string | null
          schema_markup_type: string | null
          secondary_keywords: Json | null
          target_keyword: string | null
          url_slug: string | null
          word_count_actual: number | null
          word_count_target: number | null
        }[]
        SetofOptions: {
          from: "*"
          to: "generated_pages"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      token_usage_model_totals: {
        Args: { since?: string }
        Returns: {
          cost_usd: number
          input_tokens: number
          model: string
          output_tokens: number
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
