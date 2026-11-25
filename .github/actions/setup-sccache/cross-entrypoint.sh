#!/bin/sh
# Run the compiler cache inside cross's Docker namespace, where rustc and
# compiler inputs actually exist. No host sccache server is started.
set -eu
export RUSTC_WRAPPER=/ci-sccache/sccache
export CMAKE_C_COMPILER_LAUNCHER="$RUSTC_WRAPPER"
export CMAKE_CXX_COMPILER_LAUNCHER="$RUSTC_WRAPPER"
export SCCACHE_DIR=/ci-sccache-cache
export SCCACHE_SERVER_UDS=/tmp/codeandsolder-ci-sccache.sock
export CARGO_INCREMENTAL=0
unset SCCACHE_SERVER_PORT SCCACHE_CLIENT_SIDE SCCACHE_START_SERVER SCCACHE_NO_AUTO_START_SERVER
"$RUSTC_WRAPPER" --start-server
"$RUSTC_WRAPPER" --zero-stats
finish() {
    status="$?"
    trap - EXIT
    stats_file="$(mktemp /ci-sccache/stats.XXXXXX.json)"
    "$RUSTC_WRAPPER" --show-stats --stats-format json > "$stats_file" || status=1
    "$RUSTC_WRAPPER" --show-stats || status=1
    "$RUSTC_WRAPPER" --stop-server || status=1
    exit "$status"
}
trap finish EXIT
"$@"
