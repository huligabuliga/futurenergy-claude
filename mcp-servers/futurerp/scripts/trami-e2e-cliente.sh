#!/usr/bin/env bash
# End to end on the LOCAL stack: a client's inbound WhatsApp row → the real DB
# trigger → the outbox payload → the dispatcher's message rendering (deno,
# shared/trami.ts) → the real model with the shadow tools. Nothing is sent.
#   scripts/trami-e2e-cliente.sh <channel_session_id> <client_phone_digits> "<text>" [media_url]
# Needs: trami-sandbox.mjs running (shadow), ANTHROPIC_API_KEY in env, deno.
set -eo pipefail
CH="${1:?channel session_id, e.g. trami-sandbox}"; PHONE="${2:?client phone digits}"; TEXT="${3:?text}"; MEDIA="${4:-}"
DB="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PRONTO="${TRAMI_PRONTO:-$HOME/Documents/GitHub/pronto-resolver-61-trami}"
q() { psql -X -q -v ON_ERROR_STOP=1 -Atc "$1" "$DB"; }
PREV_EMAIL=$(q "select config_value from system_config where config_key='trami_user_email'")
PREV_TRG=$(q "select tgenabled from pg_trigger where tgname='trg_trami_enqueue_whatsapp'")
cleanup() {
  q "update system_config set config_value='$PREV_EMAIL' where config_key='trami_user_email'" >/dev/null
  [ "$PREV_TRG" = "D" ] && q "alter table public.whatsapp_messages disable trigger trg_trami_enqueue_whatsapp" >/dev/null || true
}
trap cleanup EXIT
q "update system_config set config_value='trami-sandbox@futurenergy.mx' where config_key='trami_user_email'; alter table public.whatsapp_messages enable trigger trg_trami_enqueue_whatsapp" >/dev/null
CHID=$(q "select id from whatsapp_channels where session_id='$CH'"); [ -n "$CHID" ] || { echo "no channel $CH"; exit 2; }
CONV=$(q "select id from whatsapp_conversations where channel_id='$CHID' and chat_id='${PHONE}@c.us' limit 1" || true)
[ -n "$CONV" ] || CONV=$(q "insert into whatsapp_conversations (channel_id, chat_id, contact_phone) values ('$CHID', '${PHONE}@c.us', '$PHONE') returning id")
[ -n "$CONV" ] || { echo "could not create the conversation"; exit 2; }
WA="e2e-cli-$(date +%s)"
MSG=$(q "insert into whatsapp_messages (conversation_id, direction, body, sender_phone, wa_message_id, media_url, media_type) values ('$CONV','inbound',\$t\$${TEXT}\$t\$,'$PHONE','$WA',$( [ -n "$MEDIA" ] && echo "'$MEDIA','document'" || echo "null,null")) returning id")
echo "1. inbound row $MSG on channel $CH"
PAYLOAD=$(q "select payload from webhook_outbox where target='agent' and payload->>'waMessageId'='$WA'")
if [ -z "$PAYLOAD" ]; then echo "2. TRIGGER DID NOT QUEUE (no outbox row): the agent would not wake up"; exit 0; fi
echo "2. outbox payload: $(echo "$PAYLOAD" | python3 -c 'import sys,json; p=json.load(sys.stdin); print({k:p.get(k) for k in ["fromClient","viaTrami","efu","clientName","tramiteId"]})')"
HIST=$(q "select coalesce(json_agg(json_build_object('direction',m.direction,'sender_name',m.sender_name,'body',m.body,'media_url',m.media_url,'media_type',m.media_type,'sent_at',m.sent_at) order by m.sent_at desc),'[]') from (select * from whatsapp_messages where conversation_id='$CONV' and id<>'$MSG' order by sent_at desc limit 20) m")
TEXTFILE=$(mktemp)
P="$PAYLOAD" H="$HIST" deno eval --quiet "import { renderWhatsAppMessage } from '$PRONTO/supabase/functions/_shared/trami.ts'; const p = JSON.parse(Deno.env.get('P')); const h = JSON.parse(Deno.env.get('H')).reverse(); console.log(renderWhatsAppMessage(p, h));" > "$TEXTFILE"
echo "3. dispatcher text ($(wc -c < "$TEXTFILE") chars): $(head -c 220 "$TEXTFILE" | tr '\n' ' ')…"
T0=$(date -u +%FT%TZ)
echo "4. session:"
node "$HERE/trami-local-agent.mjs" --message "$(cat "$TEXTFILE")" --project "$(echo "$PAYLOAD" | python3 -c "import sys,json; print(json.load(sys.stdin).get('efu') or '')")" | grep -E "^  → |^\[trami\]|tool calls" | cut -c1-240
echo "5. what it would have done (shadow rows):"
q "select '   - '||tool_name||' · '||left(resumen,200) from agent_shadow_calls where created_at >= '$T0' order by created_at"
rm -f "$TEXTFILE"
