#!/usr/bin/env bash
#
# Read the deployed library back off the host and check it is usable.
#
# A module that failed to upload cleanly, or got the wrong content type, still
# answers 200 with a body. Status codes alone therefore prove very little. This
# fetches every module the deploy should have published and asserts three
# things per file: the host returns 200, it serves it as JavaScript, and the
# bytes it serves actually parse.
#
# Reads over WebDAV with the API key, so it does not need to know the public
# hostname.
#
# Usage:
#   verify-deploy.sh
#
# Environment:
#   PAGELOVE_WEBDAV_URL   WebDAV endpoint
#   PAGELOVE_API_KEY      console API key (pk_...)
#
set -euo pipefail

: "${PAGELOVE_WEBDAV_URL:?PAGELOVE_WEBDAV_URL is not set}"
: "${PAGELOVE_API_KEY:?PAGELOVE_API_KEY is not set}"

BASE="${PAGELOVE_WEBDAV_URL%/}/"
AUTH="Authorization: Bearer ${PAGELOVE_API_KEY}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

checked=0
failures=0

while IFS= read -r path; do
  url="${BASE}$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe="/:@"))' "$path")"
  local_file="${TMP}/$(echo "$path" | tr '/' '_')"

  read -r code type < <(curl -sS -o "$local_file" \
    -w '%{http_code} %{content_type}\n' \
    "$url" -H "$AUTH" --max-time 60 --retry 2)

  if [ "$code" != "200" ]; then
    echo "  FAIL   ${path} -> HTTP ${code}" >&2
    failures=$((failures + 1))
    continue
  fi

  case "$type" in
    text/javascript*|application/javascript*) ;;
    *)
      echo "  FAIL   ${path} -> served as '${type}', not JavaScript" >&2
      failures=$((failures + 1))
      continue
      ;;
  esac

  # node --check needs a recognised extension before it will parse a file as a
  # module, so give the copy one.
  mv "$local_file" "${local_file}.mjs"
  if ! node --check "${local_file}.mjs"; then
    echo "  FAIL   ${path} -> served bytes do not parse" >&2
    failures=$((failures + 1))
    continue
  fi

  echo "  OK     ${path} (${code}, ${type})"
  checked=$((checked + 1))
done < <(git ls-files '*.mjs' | grep -v '^test/')

if [ "$checked" -eq 0 ]; then
  echo "FATAL: no modules were checked; the file list is empty." >&2
  exit 1
fi

if [ "$failures" -gt 0 ]; then
  echo "Verify failed: ${failures} of $((checked + failures)) module(s) are wrong on the host." >&2
  exit 1
fi
echo "Verified ${checked} module(s) on the host."
