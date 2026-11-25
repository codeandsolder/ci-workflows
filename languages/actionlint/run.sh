#!/usr/bin/env bash
# Analyze actual caller GitHub Actions workflow files; no duplicate ShellCheck/Python.
set -euo pipefail
if (( $# != 3 )); then
  echo "usage: run.sh CALLER-ROOT ACTIONLINT-BINARY POLICY-CONFIG" >&2
  exit 2
fi
root="$1"
binary="$2"
config="$3"
cd -- "$root"
mapfile -d '' workflows < <(git ls-files -z -- '.github/workflows/*.yml' '.github/workflows/*.yaml')
if (( ${#workflows[@]} == 0 )); then
  echo 'No tracked GitHub Actions workflow YAML; actionlint skipped.'
  exit 0
fi
"$binary" \
  -shellcheck= -pyflakes= -no-color \
  -ignore 'property "workflow_(repository|sha)" is not defined in object type' \
  -ignore 'label "ubuntu-26\.04" is unknown' \
  -config-file "$config" \
  "${workflows[@]}"
