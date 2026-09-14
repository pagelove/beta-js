#!/usr/bin/env bash
#
# Read the deployed library back off the host and check a browser can use it.
#
# A module that failed to upload cleanly, or got the wrong content type, still
# answers 200 with a body. Status codes alone therefore prove very little.
#
# This checks the public host rather than the WebDAV endpoint, and does it
# anonymously, because that is what a browser importing the library actually
# sees. Processors run on the public host; WebDAV is the storage API and does
# not apply them, so a CORS check against WebDAV would prove nothing.
#
# Asserts, per module:
#   - the host returns 200
#   - it sends Access-Control-Allow-Origin, so a cross-origin import works
#     (skipped when REQUIRE_CORS=0, for a host that cannot send one)
#   - it serves the file as JavaScript
#   - the bytes it serves actually parse
#
# Usage:
#   verify-deploy.sh
#
# Environment:
#   PAGELOVE_WEBDAV_URL   WebDAV endpoint
#   PAGELOVE_PUBLIC_URL   public host; derived from the WebDAV URL if unset
#   REQUIRE_CORS          1 by default; 0 skips the CORS assertion
#
set -euo pipefail

: "${PAGELOVE_WEBDAV_URL:?PAGELOVE_WEBDAV_URL is not set}"

# The public host is the WebDAV host without its dav- prefix. Derived rather
# than configured so there is one less variable to keep in step, but
# overridable, because that naming is a convention rather than a guarantee.
if [ -z "${PAGELOVE_PUBLIC_URL:-}" ]; then
  PAGELOVE_PUBLIC_URL="$(printf '%s' "$PAGELOVE_WEBDAV_URL" | sed -E 's#^(https?://)dav-#\1#')"
  if [ "$PAGELOVE_PUBLIC_URL" = "$PAGELOVE_WEBDAV_URL" ]; then
    echo "FATAL: could not derive the public host from '${PAGELOVE_WEBDAV_URL}'." >&2
    echo "It has no dav- prefix, so set PAGELOVE_PUBLIC_URL explicitly." >&2
    exit 1
  fi
fi

BASE="${PAGELOVE_PUBLIC_URL%/}/"
# Any origin that is not the host itself. The point is to prove the response
# is readable by a site served from somewhere else.
PROBE_ORIGIN='https://cors-probe.invalid'

echo "Checking ${BASE} as a browser would, from origin ${PROBE_ORIGIN}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

checked=0
failures=0

while IFS= read -r path; do
  url="${BASE}$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe="/:@"))' "$path")"
  body="${TMP}/$(echo "$path" | tr '/' '_').mjs"
  headers="${TMP}/$(echo "$path" | tr '/' '_').headers"

  code=$(curl -sS -o "$body" -D "$headers" -w '%{http_code}' \
    "$url" -H "Origin: ${PROBE_ORIGIN}" --max-time 60 --retry 2)

  if [ "$code" != "200" ]; then
    echo "  FAIL   ${path} -> HTTP ${code}" >&2
    failures=$((failures + 1))
    continue
  fi

  acao=$(tr -d '\r' < "$headers" | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}' | tail -1)
  if [ "${REQUIRE_CORS:-1}" = "0" ]; then
    acao="${acao:-not required}"
  elif [ -z "$acao" ]; then
    echo "  FAIL   ${path} -> no Access-Control-Allow-Origin; a cross-origin import will be blocked" >&2
    failures=$((failures + 1))
    continue
  fi
  if [ "$acao" != "*" ] && [ "$acao" != "$PROBE_ORIGIN" ]; then
    echo "  FAIL   ${path} -> Access-Control-Allow-Origin is '${acao}', which does not admit this origin" >&2
    failures=$((failures + 1))
    continue
  fi

  type=$(tr -d '\r' < "$headers" | awk -F': ' 'tolower($1)=="content-type"{print $2}' | tail -1)
  case "$type" in
    text/javascript*|application/javascript*) ;;
    *)
      echo "  FAIL   ${path} -> served as '${type}', not JavaScript" >&2
      failures=$((failures + 1))
      continue
      ;;
  esac

  if ! node --check "$body"; then
    echo "  FAIL   ${path} -> served bytes do not parse" >&2
    failures=$((failures + 1))
    continue
  fi

  echo "  OK     ${path} (200, ${type}, allow-origin ${acao})"
  checked=$((checked + 1))
done < <(git ls-files '*.mjs' | grep -v '^test/')

if [ "$checked" -eq 0 ] && [ "$failures" -eq 0 ]; then
  echo "FATAL: no modules were checked; the file list is empty." >&2
  exit 1
fi

if [ "$failures" -gt 0 ]; then
  echo "Verify failed: ${failures} of $((checked + failures)) module(s) are wrong on the host." >&2
  exit 1
fi
echo "Verified ${checked} module(s): served, readable cross-origin, and parsing."
