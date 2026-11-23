#!/usr/bin/env bash
# Install a frozen, checksummed executable into a job-scoped directory.
set -euo pipefail
if (( $# != 2 )); then
  echo "usage: install.sh TOOL DESTINATION-DIRECTORY" >&2
  exit 2
fi
tool="$1"
directory="$2"
mkdir -p -- "$directory"
case "$tool" in
  shellcheck)
    version='v0.11.0'
    name='shellcheck-v0.11.0.linux.x86_64.tar.xz'
    sha='8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198'
    url="https://github.com/koalaman/shellcheck/releases/download/$version/$name"
    ;;
  shfmt)
    version='v3.14.1'
    name='shfmt_v3.14.1_linux_amd64'
    sha='76e77641faa025814b77f153b29796b8e6fa2fca03e0c76a691608b86c7ea7bf'
    url="https://github.com/mvdan/sh/releases/download/$version/$name"
    ;;
  oxlint)
    version='oxlint_v1.95.0'
    name='oxlint-x86_64-unknown-linux-gnu.tar.gz'
    sha='180d51ffd469995f394ba379a4b6f73c55ddb98443df442e3e456951d874a5f1'
    url="https://github.com/oxc-project/oxc/releases/download/$version/$name"
    ;;
  actionlint)
    version='v1.7.12'
    name='actionlint_1.7.12_linux_amd64.tar.gz'
    sha='8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8'
    url="https://github.com/rhysd/actionlint/releases/download/$version/$name"
    ;;
  *)
    echo "unsupported pinned quality tool: $tool" >&2
    exit 2
    ;;
esac
archive="$directory/$name"
if [[ ! -f "$archive" ]] || ! echo "$sha  $archive" | sha256sum --check --status; then
  curl --fail --location --silent --show-error --retry 3 --retry-all-errors --connect-timeout 15 \
    --output "$archive.tmp" "$url"
  mv -- "$archive.tmp" "$archive"
fi
echo "$sha  $archive" | sha256sum --check --status
case "$tool" in
  shellcheck)
    tar -xJf "$archive" -C "$directory" shellcheck-v0.11.0/shellcheck
    cp -- "$directory/shellcheck-v0.11.0/shellcheck" "$directory/shellcheck"
    ;;
  oxlint)
    tar -xzf "$archive" -C "$directory" oxlint-x86_64-unknown-linux-gnu
    cp -- "$directory/oxlint-x86_64-unknown-linux-gnu" "$directory/oxlint"
    ;;
  actionlint) tar -xzf "$archive" -C "$directory" actionlint ;;
  shfmt) cp -- "$archive" "$directory/shfmt" ;;
esac
chmod +x -- "$directory/$tool"
printf '%s\n' "$directory/$tool"
