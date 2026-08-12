#!/usr/bin/env bash
#
# Snapshot every pin to backups/, as both CSV and JSON.
#
#   ./backup.sh
#
# Reads the project URL and key from config.js so there is one source of truth.
# Needs nothing but curl. Run it whenever you want a checkpoint — certainly once
# after the class has finished adding themselves.
#
# NOTE: this pulls what the public key can read, which is every column except
# `secret` (the token that lets a person delete their own pin). That is the
# whole artifact and is what you want for keeping. It is not a restore-ready
# dump: reimporting it would leave nobody able to delete their own entry. For
# that, use Supabase → Table Editor → pins → Export to CSV, which runs with
# privileged access and includes `secret`.

set -euo pipefail
cd "$(dirname "$0")"

COLS='id,name,label,lat,lng,note,created_at'
OUT_DIR='backups'

URL=$(sed -n "s/^[[:space:]]*supabaseUrl:[[:space:]]*'\([^']*\)'.*/\1/p" config.js)
KEY=$(sed -n "s/^[[:space:]]*supabaseKey:[[:space:]]*'\([^']*\)'.*/\1/p" config.js)

if [ -z "$URL" ] || [ -z "$KEY" ]; then
  echo "Could not read supabaseUrl / supabaseKey out of config.js." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
STAMP=$(date +%Y-%m-%d-%H%M)
BASE="$OUT_DIR/pins-$STAMP"

fetch() {  # fetch <accept-header> <destination> [header-dump]
  local code
  code=$(curl -sS -w '%{http_code}' -o "$2" ${3:+-D "$3"} \
    "$URL/rest/v1/pins?select=$COLS&order=created_at.asc&limit=10000" \
    -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
    -H "Prefer: count=exact" -H "Accept: $1")
  if [ "$code" != "200" ] && [ "$code" != "206" ]; then
    echo "Request failed (HTTP $code). If the project has been idle a while it" >&2
    echo "may be paused — un-pause it in the Supabase dashboard and retry." >&2
    cat "$2" >&2 || true
    rm -f "$2"
    exit 1
  fi
}

HDRS=$(mktemp)
trap 'rm -f "$HDRS"' EXIT

fetch 'text/csv'         "$BASE.csv"  "$HDRS"
fetch 'application/json' "$BASE.json"

# Ask the database how many rows it sent. Counting lines is wrong: a note may
# contain a newline inside a quoted CSV field, and the last line may have none.
ROWS=$(grep -i '^content-range:' "$HDRS" | tr -d '\r' | sed 's|.*/||')

if [ -z "$ROWS" ] || [ "$ROWS" -lt 1 ] 2>/dev/null; then
  echo "Fetched 0 pins — refusing to leave an empty backup behind." >&2
  rm -f "$BASE.csv" "$BASE.json"
  exit 1
fi

echo "Backed up $ROWS pins:"
echo "  $BASE.csv"
echo "  $BASE.json"
