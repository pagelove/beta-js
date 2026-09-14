#!/usr/bin/env bash
#
# Sync this repository to a Pagelove host over WebDAV.
#
# Usage:
#   sync-webdav.sh <before-sha> <after-sha>   incremental: sync what changed between the two
#   sync-webdav.sh --all                      full: upload every tracked library file
#
# Environment:
#   PAGELOVE_WEBDAV_URL   WebDAV endpoint, e.g. https://dav-xxxx.onpagelove.com/
#   PAGELOVE_API_KEY      console API key (pk_...)
#   DRY_RUN=1             print the planned requests without sending any
#
set -euo pipefail

: "${PAGELOVE_WEBDAV_URL:?PAGELOVE_WEBDAV_URL is not set}"
: "${PAGELOVE_API_KEY:?PAGELOVE_API_KEY is not set}"

BASE="${PAGELOVE_WEBDAV_URL%/}/"
AUTH="Authorization: Bearer ${PAGELOVE_API_KEY}"
DRY_RUN="${DRY_RUN:-0}"

# Repo files that are tooling, not part of the published library.
# Anything starting with a dot is repo machinery (.github/, .gitignore, editor
# config) rather than shipped code — exclude the lot, so a new tooling
# directory cannot silently reach the host. .well-known is the one dot-path the
# web actually serves.
#
# test/ and the package manifests describe how to build and check the library.
# They are not part of what a browser imports, so they stay out.
is_excluded() {
  case "$1" in
    .well-known/*)                 return 1 ;;
    .*)                            return 0 ;;
    test/*)                        return 0 ;;
    package.json|package-lock.json) return 0 ;;
    README.md)                     return 0 ;;
    *)                             return 1 ;;
  esac
}

# Paths the live host owns, as a space-separated list of prefixes.
#
# Empty by default: this repo publishes JavaScript modules, and nothing on the
# host is authored live, so every path is safe to overwrite. If an HTML
# document ever lands here, that stops being true — a Pagelove document is its
# own database, so overwriting one destroys whatever clients have written into
# it. Set HOST_OWNED_PREFIXES to guard those paths: they are then created but
# never overwritten or deleted.
HOST_OWNED_PREFIXES="${HOST_OWNED_PREFIXES:-}"
is_host_owned() {
  [ "${OVERWRITE_DATA:-0}" = "1" ] && return 1
  [ -z "$HOST_OWNED_PREFIXES" ] && return 1
  local prefix
  for prefix in $HOST_OWNED_PREFIXES; do
    case "$1" in "$prefix"*) return 0 ;; esac
  done
  return 1
}

# Percent-encode a path for use in a URL, leaving separators intact.
urlencode_path() {
  python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe="/:@"))' "$1"
}

content_type_for() {
  case "$1" in
    *.mjs|*.js)   echo 'text/javascript' ;;
    *.html|*.htm) echo 'text/html' ;;
    *.css)        echo 'text/css' ;;
    *.json)       echo 'application/json' ;;
    *.map)        echo 'application/json' ;;
    *.svg)        echo 'image/svg+xml' ;;
    *.png)        echo 'image/png' ;;
    *.ico)        echo 'image/x-icon' ;;
    *.txt|LICENSE) echo 'text/plain' ;;
    *)            echo 'application/octet-stream' ;;
  esac
}

failures=0
created_dirs=" "

# MKCOL every ancestor collection of a file path, parents first.
ensure_parents() {
  local path="$1" dir="" part
  local IFS=/
  # shellcheck disable=SC2086
  set -- ${path%/*}
  [ "${path%/*}" = "$path" ] && return 0  # file at repo root
  unset IFS
  for part in "$@"; do
    dir="${dir}${part}/"
    case "$created_dirs" in *" $dir "*) continue ;; esac
    created_dirs="${created_dirs}${dir} "
    if [ "$DRY_RUN" = "1" ]; then
      echo "  MKCOL  ${dir}"
      continue
    fi
    local code
    code=$(curl -sS -o /dev/null -w '%{http_code}' -X MKCOL \
      "${BASE}$(urlencode_path "$dir")" -H "$AUTH" --max-time 60 --retry 2)
    case "$code" in
      201|405) ;;  # created, or already exists (RFC 4918)
      409)
        # This host returns 409 for an existing collection, but 409 also means
        # "parent missing" — so confirm which by asking, rather than assuming.
        local check
        check=$(curl -sS -o /dev/null -w '%{http_code}' -X PROPFIND \
          "${BASE}$(urlencode_path "$dir")" -H "$AUTH" -H 'Depth: 0' --max-time 60)
        if [ "$check" != "207" ]; then
          echo "  MKCOL  ${dir} -> HTTP 409 and not present (missing parent?)" >&2
          failures=$((failures + 1))
        fi
        ;;
      *) echo "  MKCOL  ${dir} -> HTTP ${code}" >&2; failures=$((failures + 1)) ;;
    esac
  done
}

put_file() {
  local path="$1"
  if [ ! -f "$path" ]; then
    echo "  SKIP   ${path} (not present in working tree)"
    return 0
  fi
  ensure_parents "$path"

  # Host-owned paths are created but never overwritten. If-None-Match: * makes
  # that atomic at the protocol level: an existing file returns 412 and keeps
  # its content, so a concurrent write cannot be clobbered by a
  # check-then-write race.
  local guard=()
  if is_host_owned "$path"; then
    guard=(-H 'If-None-Match: *')
  fi

  if [ "$DRY_RUN" = "1" ]; then
    if is_host_owned "$path"; then
      echo "  PUT    ${path}  [$(content_type_for "$path")] (create-only; skipped if it exists)"
    else
      echo "  PUT    ${path}  [$(content_type_for "$path")]"
    fi
    return 0
  fi

  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT \
    "${BASE}$(urlencode_path "$path")" -H "$AUTH" \
    -H "Content-Type: $(content_type_for "$path")" ${guard[@]+"${guard[@]}"} \
    --data-binary "@${path}" --max-time 120 --retry 2)
  case "$code" in
    2*)  echo "  PUT    ${path} -> ${code}" ;;
    412) echo "  KEPT   ${path} (exists on host; host owns this path)" ;;
    *)   echo "  PUT    ${path} -> HTTP ${code}" >&2; failures=$((failures + 1)) ;;
  esac
}

delete_file() {
  local path="$1"
  if is_host_owned "$path"; then
    echo "  KEPT   ${path} (host owns this path; not deleted)"
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    echo "  DELETE ${path}"
    return 0
  fi
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE \
    "${BASE}$(urlencode_path "$path")" -H "$AUTH" --max-time 60 --retry 2)
  case "$code" in
    2*|404) echo "  DELETE ${path} -> ${code}" ;;  # already gone is success
    *)      echo "  DELETE ${path} -> HTTP ${code}" >&2; failures=$((failures + 1)) ;;
  esac
}

uploads=()
deletes=()

if [ "${1:-}" = "--all" ]; then
  echo "Full sync: every tracked library file."
  while IFS= read -r -d '' path; do
    is_excluded "$path" || uploads+=("$path")
  done < <(git ls-files -z)
else
  BEFORE="${1:?usage: sync-webdav.sh <before-sha> <after-sha> | --all}"
  AFTER="${2:?usage: sync-webdav.sh <before-sha> <after-sha> | --all}"
  echo "Incremental sync: ${BEFORE:0:12}..${AFTER:0:12}"
  # -z keeps paths intact, in case one ever contains a space.
  while IFS= read -r -d '' status; do
    case "$status" in
      R*|C*)
        IFS= read -r -d '' old
        IFS= read -r -d '' new
        is_excluded "$old" || deletes+=("$old")
        is_excluded "$new" || uploads+=("$new")
        ;;
      D*)
        IFS= read -r -d '' path
        is_excluded "$path" || deletes+=("$path")
        ;;
      *)
        IFS= read -r -d '' path
        is_excluded "$path" || uploads+=("$path")
        ;;
    esac
  done < <(git diff --name-status -z "$BEFORE" "$AFTER")
fi

if [ ${#uploads[@]} -eq 0 ] && [ ${#deletes[@]} -eq 0 ]; then
  echo "Nothing to sync."
  exit 0
fi

# Uploads before deletes, so a rename never leaves the host missing a module.
if [ ${#uploads[@]} -gt 0 ]; then
  echo "Uploading ${#uploads[@]} file(s):"
  for path in "${uploads[@]}"; do put_file "$path"; done
fi

if [ ${#deletes[@]} -gt 0 ]; then
  echo "Deleting ${#deletes[@]} file(s):"
  for path in "${deletes[@]}"; do delete_file "$path"; done
fi

if [ "$failures" -gt 0 ]; then
  echo "Sync finished with ${failures} failure(s)." >&2
  exit 1
fi
echo "Sync complete."
