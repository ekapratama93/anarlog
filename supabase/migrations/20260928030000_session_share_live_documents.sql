-- Live (CRDT) collaboration log for shared notes. The sync service relays
-- Yjs updates between connected editors and appends every accepted update
-- here so any sync instance can rebuild the document and so late joiners
-- (or another Fly Machine) converge on the same state. Snapshots stay the
-- durable, reconciled representation; this log is the low-latency layer.

CREATE TABLE public.session_share_live_documents (
  share_id uuid PRIMARY KEY
    REFERENCES public.session_shares(id) ON DELETE CASCADE,
  state bytea NOT NULL,
  compacted_through_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_share_live_documents_state_check CHECK (
    octet_length(state) <= 8388608
  ),
  CONSTRAINT session_share_live_documents_seq_check CHECK (
    compacted_through_seq >= 0
  ),
  CONSTRAINT session_share_live_documents_time_check CHECK (
    updated_at >= created_at
  )
);

CREATE TABLE public.session_share_live_updates (
  share_id uuid NOT NULL
    REFERENCES public.session_shares(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  update bytea NOT NULL,
  actor_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (share_id, seq),
  CONSTRAINT session_share_live_updates_seq_check CHECK (seq > 0),
  CONSTRAINT session_share_live_updates_size_check CHECK (
    octet_length(update) BETWEEN 1 AND 1048576
  )
);

ALTER TABLE public.session_share_live_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_share_live_updates ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.session_share_live_documents
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.session_share_live_updates
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.session_share_live_documents TO service_role;
GRANT ALL ON TABLE public.session_share_live_updates TO service_role;

CREATE POLICY session_share_live_documents_service_all
  ON public.session_share_live_documents
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY session_share_live_updates_service_all
  ON public.session_share_live_updates
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Resolves what a permanent user may do on a live document. Editors need the
-- same standing as web snapshot edits (workspace owner/admin or an explicit
-- editor grant on a web-editable snapshot); everyone else with read access is
-- a viewer who receives updates but may not publish them.
CREATE OR REPLACE FUNCTION private.resolve_session_share_live_access(
  p_share_id uuid,
  p_actor_user_id uuid
)
RETURNS TABLE (
  share_id uuid,
  capability text,
  access_version bigint,
  content_revision bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_share public.session_shares%ROWTYPE;
  v_snapshot public.session_share_snapshots%ROWTYPE;
  v_manage_access boolean;
  v_has_editor_grant boolean;
  v_has_read_access boolean;
  v_capability text;
BEGIN
  IF p_share_id IS NULL OR p_actor_user_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM 1
  FROM auth.users AS actor
  WHERE actor.id = p_actor_user_id
    AND actor.email_confirmed_at IS NOT NULL
    AND COALESCE(actor.is_anonymous, false) = false
    AND NOT EXISTS (
      SELECT 1
      FROM private.account_deletion_jobs AS deletion
      WHERE deletion.owner_user_id = actor.id
    );

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT share.*
  INTO v_share
  FROM public.session_shares AS share
  JOIN public.workspaces AS workspace
    ON workspace.id = share.workspace_id
  WHERE share.id = p_share_id
    AND share.deleted_at IS NULL
    AND workspace.deleted_at IS NULL;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT snapshot.*
  INTO v_snapshot
  FROM public.session_share_snapshots AS snapshot
  WHERE snapshot.share_id = v_share.id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.workspace_memberships AS membership
    WHERE membership.workspace_id = v_share.workspace_id
      AND membership.user_id = p_actor_user_id
      AND membership.role IN ('owner', 'admin')
      AND membership.deleted_at IS NULL
  )
  INTO v_manage_access;

  SELECT EXISTS (
    SELECT 1
    FROM public.session_access_grants AS access_grant
    WHERE access_grant.share_id = v_share.id
      AND access_grant.grantee_user_id = p_actor_user_id
      AND access_grant.capability = 'editor'
      AND access_grant.revoked_at IS NULL
  )
  INTO v_has_editor_grant;

  IF v_manage_access OR (v_has_editor_grant AND v_snapshot.web_editable) THEN
    v_capability := 'editor';
  ELSE
    SELECT EXISTS (
      SELECT 1
      FROM public.session_access_grants AS access_grant
      WHERE access_grant.share_id = v_share.id
        AND access_grant.grantee_user_id = p_actor_user_id
        AND access_grant.revoked_at IS NULL

      UNION ALL

      SELECT 1
      FROM public.workspace_memberships AS target_membership
      WHERE v_share.general_scope = 'workspace'
        AND target_membership.workspace_id = v_share.general_workspace_id
        AND target_membership.user_id = p_actor_user_id
        AND target_membership.deleted_at IS NULL

      UNION ALL

      SELECT 1
      WHERE v_share.general_scope = 'public'
    )
    INTO v_has_read_access;

    IF NOT v_has_read_access THEN
      RETURN;
    END IF;

    v_capability := 'viewer';
  END IF;

  RETURN QUERY SELECT
    v_share.id,
    v_capability,
    v_share.access_version,
    v_snapshot.content_revision;
END;
$$;

-- Returns the compacted state plus every update appended after it, hex
-- encoded so the payload survives PostgREST's JSON transport unchanged.
CREATE OR REPLACE FUNCTION private.read_session_share_live_document(
  p_share_id uuid
)
RETURNS TABLE (
  share_id uuid,
  state_hex text,
  compacted_through_seq bigint,
  updates jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_state bytea;
  v_compacted bigint := 0;
BEGIN
  IF p_share_id IS NULL THEN
    RAISE EXCEPTION 'invalid live document request'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.session_shares AS share
  WHERE share.id = p_share_id
    AND share.deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'live document not permitted'
      USING ERRCODE = '42501';
  END IF;

  SELECT document.state, document.compacted_through_seq
  INTO v_state, v_compacted
  FROM public.session_share_live_documents AS document
  WHERE document.share_id = p_share_id;

  RETURN QUERY SELECT
    p_share_id,
    CASE WHEN v_state IS NULL THEN NULL ELSE encode(v_state, 'hex') END,
    COALESCE(v_compacted, 0),
    COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'seq', page.seq,
            'update_hex', encode(page.update, 'hex')
          )
          ORDER BY page.seq
        )
        FROM (
          SELECT live_update.seq, live_update.update
          FROM public.session_share_live_updates AS live_update
          WHERE live_update.share_id = p_share_id
            AND live_update.seq > COALESCE(v_compacted, 0)
          ORDER BY live_update.seq
          LIMIT 256
        ) AS page
      ),
      '[]'::jsonb
    );
END;
$$;

CREATE OR REPLACE FUNCTION private.read_session_share_live_updates(
  p_share_id uuid,
  p_after_seq bigint,
  p_limit integer
)
RETURNS TABLE (
  seq bigint,
  update_hex text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_share_id IS NULL
    OR p_after_seq IS NULL
    OR p_after_seq < 0
    OR p_limit IS NULL
    OR p_limit < 1
    OR p_limit > 1000
  THEN
    RAISE EXCEPTION 'invalid live document request'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT live_update.seq, encode(live_update.update, 'hex')
  FROM public.session_share_live_updates AS live_update
  WHERE live_update.share_id = p_share_id
    AND live_update.seq > p_after_seq
  ORDER BY live_update.seq
  LIMIT p_limit;
END;
$$;

-- Appends one accepted update. When p_require_empty is set the append only
-- succeeds if no update or compacted state exists yet, which lets exactly one
-- client seed the live document from the durable snapshot.
CREATE OR REPLACE FUNCTION private.append_session_share_live_update(
  p_share_id uuid,
  p_actor_user_id uuid,
  p_update_hex text,
  p_require_empty boolean
)
RETURNS TABLE (
  outcome text,
  seq bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_update bytea;
  v_seq bigint;
BEGIN
  IF p_share_id IS NULL
    OR p_actor_user_id IS NULL
    OR p_update_hex IS NULL
    OR p_update_hex !~ '^[0-9a-fA-F]+$'
    OR length(p_update_hex) % 2 <> 0
    OR length(p_update_hex) > 2 * 1048576
    OR p_require_empty IS NULL
  THEN
    RAISE EXCEPTION 'invalid live document update'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM private.resolve_session_share_live_access(p_share_id, p_actor_user_id)
    AS access
  WHERE access.capability = 'editor';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'live document edit not permitted'
      USING ERRCODE = '42501';
  END IF;

  v_update := decode(p_update_hex, 'hex');

  PERFORM pg_advisory_xact_lock(hashtext('session_share_live:' || p_share_id::text));

  IF p_require_empty AND (
    EXISTS (
      SELECT 1
      FROM public.session_share_live_documents AS document
      WHERE document.share_id = p_share_id
    )
    OR EXISTS (
      SELECT 1
      FROM public.session_share_live_updates AS live_update
      WHERE live_update.share_id = p_share_id
    )
  ) THEN
    RETURN QUERY SELECT 'not_empty'::text, NULL::bigint;
    RETURN;
  END IF;

  SELECT COALESCE(max(live_update.seq), 0) + 1
  INTO v_seq
  FROM public.session_share_live_updates AS live_update
  WHERE live_update.share_id = p_share_id;

  IF v_seq = 1 THEN
    SELECT GREATEST(v_seq, document.compacted_through_seq + 1)
    INTO v_seq
    FROM public.session_share_live_documents AS document
    WHERE document.share_id = p_share_id;
    v_seq := COALESCE(v_seq, 1);
  END IF;

  INSERT INTO public.session_share_live_updates (
    share_id,
    seq,
    update,
    actor_user_id
  ) VALUES (
    p_share_id,
    v_seq,
    v_update,
    p_actor_user_id
  );

  RETURN QUERY SELECT 'appended'::text, v_seq;
END;
$$;

-- Replaces the compacted state with a full encoding that already contains
-- every update through p_through_seq, then drops those updates.
CREATE OR REPLACE FUNCTION private.compact_session_share_live_document(
  p_share_id uuid,
  p_state_hex text,
  p_through_seq bigint
)
RETURNS TABLE (
  share_id uuid,
  compacted_through_seq bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_share_id IS NULL
    OR p_state_hex IS NULL
    OR p_state_hex !~ '^[0-9a-fA-F]+$'
    OR length(p_state_hex) % 2 <> 0
    OR length(p_state_hex) > 2 * 8388608
    OR p_through_seq IS NULL
    OR p_through_seq <= 0
  THEN
    RAISE EXCEPTION 'invalid live document compaction'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('session_share_live:' || p_share_id::text));

  IF EXISTS (
    SELECT 1
    FROM public.session_share_live_documents AS document
    WHERE document.share_id = p_share_id
      AND document.compacted_through_seq >= p_through_seq
  ) THEN
    RETURN QUERY
    SELECT document.share_id, document.compacted_through_seq
    FROM public.session_share_live_documents AS document
    WHERE document.share_id = p_share_id;
    RETURN;
  END IF;

  INSERT INTO public.session_share_live_documents (
    share_id,
    state,
    compacted_through_seq,
    created_at,
    updated_at
  ) VALUES (
    p_share_id,
    decode(p_state_hex, 'hex'),
    p_through_seq,
    v_now,
    v_now
  )
  ON CONFLICT ON CONSTRAINT session_share_live_documents_pkey
  DO UPDATE SET
    state = excluded.state,
    compacted_through_seq = excluded.compacted_through_seq,
    updated_at = excluded.updated_at;

  DELETE FROM public.session_share_live_updates AS live_update
  WHERE live_update.share_id = p_share_id
    AND live_update.seq <= p_through_seq;

  RETURN QUERY SELECT p_share_id, p_through_seq;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_session_share_live_access(
  p_share_id uuid,
  p_actor_user_id uuid
)
RETURNS TABLE (
  share_id uuid,
  capability text,
  access_version bigint,
  content_revision bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT *
  FROM private.resolve_session_share_live_access(p_share_id, p_actor_user_id);
$$;

CREATE OR REPLACE FUNCTION public.read_session_share_live_document(
  p_share_id uuid
)
RETURNS TABLE (
  share_id uuid,
  state_hex text,
  compacted_through_seq bigint,
  updates jsonb
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT *
  FROM private.read_session_share_live_document(p_share_id);
$$;

CREATE OR REPLACE FUNCTION public.read_session_share_live_updates(
  p_share_id uuid,
  p_after_seq bigint,
  p_limit integer
)
RETURNS TABLE (
  seq bigint,
  update_hex text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT *
  FROM private.read_session_share_live_updates(p_share_id, p_after_seq, p_limit);
$$;

CREATE OR REPLACE FUNCTION public.append_session_share_live_update(
  p_share_id uuid,
  p_actor_user_id uuid,
  p_update_hex text,
  p_require_empty boolean
)
RETURNS TABLE (
  outcome text,
  seq bigint
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT *
  FROM private.append_session_share_live_update(
    p_share_id,
    p_actor_user_id,
    p_update_hex,
    p_require_empty
  );
$$;

CREATE OR REPLACE FUNCTION public.compact_session_share_live_document(
  p_share_id uuid,
  p_state_hex text,
  p_through_seq bigint
)
RETURNS TABLE (
  share_id uuid,
  compacted_through_seq bigint
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT *
  FROM private.compact_session_share_live_document(
    p_share_id,
    p_state_hex,
    p_through_seq
  );
$$;

REVOKE ALL ON FUNCTION public.resolve_session_share_live_access(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_session_share_live_document(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_session_share_live_updates(uuid, bigint, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.append_session_share_live_update(uuid, uuid, text, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.compact_session_share_live_document(uuid, text, bigint)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.resolve_session_share_live_access(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.read_session_share_live_document(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.read_session_share_live_updates(uuid, bigint, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.append_session_share_live_update(uuid, uuid, text, boolean)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.compact_session_share_live_document(uuid, text, bigint)
  TO service_role;
