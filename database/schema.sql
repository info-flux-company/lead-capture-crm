-- ============================================================================
-- Reusable White-Label B2B Lead Capture & Analytics Mini-CRM Schema
-- Target Platform: Supabase (PostgreSQL 15+)
-- Security Model: Strict Multi-Tenant RLS + Anti-Theft Trigger + Zero Anon Access
-- ============================================================================

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- 2. NORMALIZED TABLES
-- ============================================================================

-- Workspaces (Tenant Isolation Root)
CREATE TABLE IF NOT EXISTS public.workspaces (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 150),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Workspace Members (User <-> Workspace Role Mapping)
CREATE TABLE IF NOT EXISTS public.workspace_members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('owner', 'sales')),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_workspace_members_user_workspace UNIQUE (user_id, workspace_id)
);

-- Landing Pages belonging to a Workspace
CREATE TABLE IF NOT EXISTS public.pages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    slug text NOT NULL UNIQUE CHECK (char_length(trim(slug)) BETWEEN 1 AND 120),
    title text NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 200),
    is_published boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Page Views (Analytics Events logged server-side via Cloudflare Pages Function)
CREATE TABLE IF NOT EXISTS public.page_views (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    page_id uuid REFERENCES public.pages(id) ON DELETE SET NULL,
    country text,
    city text,
    device text,
    utm_source text,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Leads (Captured B2B Inquiries logged server-side via Cloudflare Pages Function)
CREATE TABLE IF NOT EXISTS public.leads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    page_id uuid REFERENCES public.pages(id) ON DELETE SET NULL,
    name text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 150),
    phone text NOT NULL CHECK (char_length(trim(phone)) BETWEEN 5 AND 30),
    city text,
    country text,
    utm_source text,
    status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'interested', 'won', 'no_answer')),
    notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 2000),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- 3. PERFORMANCE INDEXES
-- ============================================================================

-- Mandatory composite indexes for fast tenant timeline queries
CREATE INDEX IF NOT EXISTS idx_leads_workspace_created_at
    ON public.leads (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_page_views_workspace_created_at
    ON public.page_views (workspace_id, created_at DESC);

-- Supporting indexes for RLS lookups, status KPI counts, and page filters
CREATE INDEX IF NOT EXISTS idx_workspace_members_user_id
    ON public.workspace_members (user_id);

CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace_user_role
    ON public.workspace_members (workspace_id, user_id, role);

CREATE INDEX IF NOT EXISTS idx_pages_workspace_id
    ON public.pages (workspace_id);

CREATE INDEX IF NOT EXISTS idx_leads_workspace_status
    ON public.leads (workspace_id, status);

CREATE INDEX IF NOT EXISTS idx_leads_workspace_page_created
    ON public.leads (workspace_id, page_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_page_views_workspace_page_created
    ON public.page_views (workspace_id, page_id, created_at DESC);

-- ============================================================================
-- 4. NON-RECURSIVE SECURITY DEFINER HELPER FUNCTIONS
-- ============================================================================

-- Returns all workspace IDs assigned to the authenticated user without RLS recursion
CREATE OR REPLACE FUNCTION public.get_my_workspace_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT wm.workspace_id
    FROM public.workspace_members AS wm
    WHERE wm.user_id = auth.uid();
$$;

-- Returns true if the authenticated user is an 'owner' of the target workspace
CREATE OR REPLACE FUNCTION public.is_workspace_owner(ws_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.workspace_members AS wm
        WHERE wm.workspace_id = ws_id
          AND wm.user_id = auth.uid()
          AND wm.role = 'owner'
    );
$$;

-- Restrict helper execution strictly to authenticated users and service_role
REVOKE ALL ON FUNCTION public.get_my_workspace_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_workspace_ids() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.is_workspace_owner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_workspace_owner(uuid) TO authenticated, service_role;

-- ============================================================================
-- 5. ANTI-DATA-THEFT BEFORE UPDATE TRIGGER ON PUBLIC.LEADS
-- ============================================================================

-- IMPORTANT: Must remain SECURITY INVOKER so current_user reflects the actual
-- caller ('authenticated' vs 'service_role') and does not elevate to 'postgres'.
CREATE OR REPLACE FUNCTION public.enforce_leads_update_security()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
    -- Allow privileged backend/admin database roles (e.g. migrations or service_role)
    IF current_user IN ('postgres', 'supabase_admin', 'service_role') THEN
        NEW.notes := COALESCE(NEW.notes, '');
        RETURN NEW;
    END IF;

    -- Reject unauthenticated update attempts
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Forbidden: unauthenticated update not allowed.'
            USING ERRCODE = '42501';
    END IF;

    -- Immutable fields cannot be altered by ANY client role (owner or sales)
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Forbidden: immutable lead fields (id, workspace_id, created_at) cannot be modified.'
            USING ERRCODE = '42501';
    END IF;

    -- Sales members may ONLY modify status and notes; all lead identity/source fields are locked
    IF NOT public.is_workspace_owner(OLD.workspace_id) THEN
        IF NEW.page_id IS DISTINCT FROM OLD.page_id
           OR NEW.name IS DISTINCT FROM OLD.name
           OR NEW.phone IS DISTINCT FROM OLD.phone
           OR NEW.city IS DISTINCT FROM OLD.city
           OR NEW.country IS DISTINCT FROM OLD.country
           OR NEW.utm_source IS DISTINCT FROM OLD.utm_source THEN
            RAISE EXCEPTION 'Forbidden: sales users can only update lead status and notes.'
                USING ERRCODE = '42501';
        END IF;
    ELSE
        -- Owners changing page_id must still reference a page belonging to the same workspace
        IF NEW.page_id IS DISTINCT FROM OLD.page_id AND NEW.page_id IS NOT NULL THEN
            IF NOT EXISTS (
                SELECT 1
                FROM public.pages AS p
                WHERE p.id = NEW.page_id
                  AND p.workspace_id = OLD.workspace_id
            ) THEN
                RAISE EXCEPTION 'Forbidden: page_id does not belong to this workspace.'
                    USING ERRCODE = '42501';
            END IF;
        END IF;
    END IF;

    NEW.notes := COALESCE(NEW.notes, '');
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_leads_enforce_update_security ON public.leads;
CREATE TRIGGER trg_leads_enforce_update_security
    BEFORE UPDATE ON public.leads
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_leads_update_security();

-- ============================================================================
-- 6. LEAST-PRIVILEGE GRANTS & STRICT ROW LEVEL SECURITY (RLS)
-- ============================================================================

-- Defense in depth: revoke all client privileges first, then grant minimum required
REVOKE ALL ON TABLE
    public.workspaces,
    public.workspace_members,
    public.pages,
    public.page_views,
    public.leads
FROM anon, authenticated;

GRANT SELECT, UPDATE ON TABLE public.workspaces TO authenticated;
GRANT SELECT ON TABLE public.workspace_members TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pages TO authenticated;
GRANT SELECT ON TABLE public.page_views TO authenticated;
GRANT SELECT, UPDATE, DELETE ON TABLE public.leads TO authenticated;

-- Enable RLS on ALL 5 tables (zero unrestricted access)
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.page_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

-- --- Policies: public.workspaces ---
DROP POLICY IF EXISTS "workspaces_select_member" ON public.workspaces;
CREATE POLICY "workspaces_select_member"
    ON public.workspaces
    FOR SELECT
    TO authenticated
    USING (id IN (SELECT public.get_my_workspace_ids()));

DROP POLICY IF EXISTS "workspaces_update_owner" ON public.workspaces;
CREATE POLICY "workspaces_update_owner"
    ON public.workspaces
    FOR UPDATE
    TO authenticated
    USING (public.is_workspace_owner(id))
    WITH CHECK (public.is_workspace_owner(id));

-- --- Policies: public.workspace_members ---
DROP POLICY IF EXISTS "workspace_members_select_self_or_owner" ON public.workspace_members;
CREATE POLICY "workspace_members_select_self_or_owner"
    ON public.workspace_members
    FOR SELECT
    TO authenticated
    USING (
        user_id = auth.uid()
        OR public.is_workspace_owner(workspace_id)
    );

-- --- Policies: public.pages ---
DROP POLICY IF EXISTS "pages_select_member" ON public.pages;
CREATE POLICY "pages_select_member"
    ON public.pages
    FOR SELECT
    TO authenticated
    USING (workspace_id IN (SELECT public.get_my_workspace_ids()));

DROP POLICY IF EXISTS "pages_insert_owner" ON public.pages;
CREATE POLICY "pages_insert_owner"
    ON public.pages
    FOR INSERT
    TO authenticated
    WITH CHECK (public.is_workspace_owner(workspace_id));

DROP POLICY IF EXISTS "pages_update_owner" ON public.pages;
CREATE POLICY "pages_update_owner"
    ON public.pages
    FOR UPDATE
    TO authenticated
    USING (public.is_workspace_owner(workspace_id))
    WITH CHECK (public.is_workspace_owner(workspace_id));

DROP POLICY IF EXISTS "pages_delete_owner" ON public.pages;
CREATE POLICY "pages_delete_owner"
    ON public.pages
    FOR DELETE
    TO authenticated
    USING (public.is_workspace_owner(workspace_id));

-- --- Policies: public.page_views (read-only for workspace members; inserts via service_role only) ---
DROP POLICY IF EXISTS "page_views_select_member" ON public.page_views;
CREATE POLICY "page_views_select_member"
    ON public.page_views
    FOR SELECT
    TO authenticated
    USING (workspace_id IN (SELECT public.get_my_workspace_ids()));

-- --- Policies: public.leads (inserts via service_role only; delete restricted to owner) ---
DROP POLICY IF EXISTS "leads_select_member" ON public.leads;
CREATE POLICY "leads_select_member"
    ON public.leads
    FOR SELECT
    TO authenticated
    USING (workspace_id IN (SELECT public.get_my_workspace_ids()));

DROP POLICY IF EXISTS "leads_update_member" ON public.leads;
CREATE POLICY "leads_update_member"
    ON public.leads
    FOR UPDATE
    TO authenticated
    USING (workspace_id IN (SELECT public.get_my_workspace_ids()))
    WITH CHECK (workspace_id IN (SELECT public.get_my_workspace_ids()));

DROP POLICY IF EXISTS "leads_delete_owner_only" ON public.leads;
CREATE POLICY "leads_delete_owner_only"
    ON public.leads
    FOR DELETE
    TO authenticated
    USING (public.is_workspace_owner(workspace_id));

-- ============================================================================
-- 7. SUPABASE REALTIME PUBLICATION REGISTRATION
-- ============================================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_publication
        WHERE pubname = 'supabase_realtime'
    ) THEN
        IF NOT EXISTS (
            SELECT 1
            FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime'
              AND schemaname = 'public'
              AND tablename = 'leads'
        ) THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.leads;
        END IF;
    END IF;
END;
$$;

-- ============================================================================
-- 8. SEED SNIPPET: FIRST WORKSPACE, OWNER ACCOUNT & DEFAULT LANDING PAGE
-- ============================================================================

HOW TO SEED YOUR FIRST WORKSPACE & OWNER ACCOUNT:
1. Open Supabase Dashboard -> Authentication -> Users -> "Add user" -> "Create new user".
   Enter your owner email (e.g., owner@yourcompany.com) and password, and keep "Auto Confirm User" enabled.
2. Run the SQL block below inside Supabase SQL Editor (replace email, workspace name, slug, and title):

DO $$
DECLARE
    v_owner_email    text := 'owner@yourcompany.com';
    v_workspace_name text := 'شركتي للخدمات والأعمال';
    v_page_slug      text := 'main-landing';
    v_page_title     text := 'الصفحة الرئيسية للعرض';
    v_user_id        uuid;
    v_workspace_id   uuid;
BEGIN
    SELECT id INTO v_user_id
    FROM auth.users
    WHERE lower(email) = lower(v_owner_email)
    LIMIT 1;

    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Auth user with email "%" was not found. Create the user in Authentication -> Users first.', v_owner_email;
    END IF;

    INSERT INTO public.workspaces (name)
    VALUES (v_workspace_name)
    RETURNING id INTO v_workspace_id;

    INSERT INTO public.workspace_members (user_id, workspace_id, role)
    VALUES (v_user_id, v_workspace_id, 'owner')
    ON CONFLICT (user_id, workspace_id) DO NOTHING;

    INSERT INTO public.pages (workspace_id, slug, title, is_published)
    VALUES (v_workspace_id, v_page_slug, v_page_title, true)
    ON CONFLICT (slug) DO NOTHING;

    RAISE NOTICE 'Seeded workspace_id = %, owner user_id = %', v_workspace_id, v_user_id;
END;
$$;

-- OPTIONAL: Add a Sales team member to the existing workspace (after creating the sales user in Auth):
DO $$
DECLARE
    v_sales_email  text := 'sales@yourcompany.com';
    v_workspace_id uuid := '00000000-0000-0000-0000-000000000000'; -- Replace with workspace_id from above
    v_sales_uid    uuid;
BEGIN
    SELECT id INTO v_sales_uid
    FROM auth.users
    WHERE lower(email) = lower(v_sales_email)
    LIMIT 1;

    IF v_sales_uid IS NULL THEN
        RAISE EXCEPTION 'Sales user with email "%" was not found.', v_sales_email;
    END IF;

    INSERT INTO public.workspace_members (user_id, workspace_id, role)
    VALUES (v_sales_uid, v_workspace_id, 'sales')
    ON CONFLICT (user_id, workspace_id) DO UPDATE SET role = EXCLUDED.role;
END;
$$;

