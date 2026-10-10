#!/usr/bin/env bash
# Undo what Trami did on a LOCAL project during a sandbox run so the scenario
# can be replayed from scratch: trámites created by the sandbox user, its
# notes, its WhatsApp rows, the shadow rows and the outbox rows.
#   scripts/trami-reset-case.sh EFU-00678-1
set -euo pipefail
EFU="${1:?EFU code}"
DB="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
psql -X -v ON_ERROR_STOP=1 "$DB" <<SQL
DO \$\$
DECLARE v_p uuid; v_u uuid;
BEGIN
  SELECT id INTO v_p FROM public.projects WHERE efu = '$EFU';
  SELECT user_id INTO v_u FROM public.profiles WHERE email = 'trami-sandbox@futurenergy.mx';
  IF v_p IS NULL THEN RAISE EXCEPTION 'no project $EFU'; END IF;
  DELETE FROM public.tramite_file_links l USING public.project_tramites t WHERE l.tramite_id = t.id AND t.project_id = v_p AND t.created_by = v_u;
  DELETE FROM public.project_tramites WHERE project_id = v_p AND created_by = v_u;
  DELETE FROM public.crm_activities WHERE entity_id = v_p AND performed_by = v_u;
  DELETE FROM public.agent_shadow_calls WHERE project_id = v_p OR user_id = v_u AND project_id IS NULL;
  DELETE FROM public.webhook_outbox WHERE target = 'agent' AND payload->>'projectId' = v_p::text;
  RAISE NOTICE 'reset % (project %, user %)', '$EFU', v_p, v_u;
END \$\$;
DELETE FROM public.whatsapp_messages m USING public.whatsapp_conversations c, public.whatsapp_channels ch WHERE m.conversation_id = c.id AND c.channel_id = ch.id AND ch.session_id = 'trami-sandbox';
SQL
