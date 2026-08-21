#!/bin/sh
set -eu

readonly template_path="${VECTOR_CONFIG_TEMPLATE:-/etc/vector/vector.yaml}"
readonly runtime_path="${VECTOR_RUNTIME_CONFIG:-/tmp/vector-runtime.yaml}"
readonly secrets_path="${VECTOR_SECRETS_DIR:-/run/secrets}"
readonly source_url_path="${secrets_path}/convoy_meilisearch_source_url"
readonly source_url_prefix="http://convoy-agent:5008/ingest/"
readonly source_url_placeholder='SECRET[docker_secrets.convoy_meilisearch_source_url]'
readonly r2_endpoint_placeholder='https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com'
readonly vector_executable="${VECTOR_EXECUTABLE:-/usr/local/bin/vector}"

fail() {
  printf 'Vector runtime configuration error: %s\n' "$1" >&2
  exit 1
}

test -r "$template_path" || fail "configuration template is not readable"
test -x "$vector_executable" || fail "Vector executable is not available"

umask 077
cp "$template_path" "$runtime_path"

if grep -Fq "$source_url_placeholder" "$runtime_path"; then
  test -r "$source_url_path" || fail "Convoy source URL secret is not readable"

  source_url="$(tr -d '\r\n' < "$source_url_path")"
  case "$source_url" in
    "${source_url_prefix}"*) ;;
    *) fail "Convoy source URL has an unexpected origin or path" ;;
  esac

  source_mask="${source_url#"$source_url_prefix"}"
  test -n "$source_mask" || fail "Convoy source mask is empty"
  case "$source_mask" in
    *[!A-Za-z0-9_-]*) fail "Convoy source mask contains invalid characters" ;;
  esac

  sed \
    "s|uri: SECRET\\[docker_secrets.convoy_meilisearch_source_url\\]|uri: ${source_url}|" \
    "$runtime_path" > "${runtime_path}.next"
  mv "${runtime_path}.next" "$runtime_path"

  if grep -Fq "$source_url_placeholder" "$runtime_path"; then
    fail "Convoy source URL placeholder was not resolved"
  fi
fi

if grep -Fq "$r2_endpoint_placeholder" "$runtime_path"; then
  test -n "${R2_ACCOUNT_ID:-}" || fail "R2_ACCOUNT_ID is empty"
  case "$R2_ACCOUNT_ID" in
    *[!A-Za-z0-9]*) fail "R2_ACCOUNT_ID contains invalid characters" ;;
  esac

  sed \
    "s|endpoint: https://\\\${R2_ACCOUNT_ID}.r2.cloudflarestorage.com|endpoint: https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com|" \
    "$runtime_path" > "${runtime_path}.next"
  mv "${runtime_path}.next" "$runtime_path"

  if grep -Fq "$r2_endpoint_placeholder" "$runtime_path"; then
    fail "R2 endpoint placeholder was not resolved"
  fi
fi

exec "$vector_executable" "$@"
