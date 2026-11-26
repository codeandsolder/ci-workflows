#!/usr/bin/env bash
# A real hosted client of the existing protocol-5 fleet. No fleet bootstrap token.
set -euo pipefail
umask 077
root="${RUNNER_TEMP:?}/hosted-sccache-canary"
anchor="$(cd -- "$(dirname -- "$0")" && pwd)/cluster-ca.pem"
scheduler_id=a19339f6146c06e35cce4930167a7bc1f53ea96f023af64a57e8313c334dfe6e
scheduler_ip=100.73.74.69
scheduler_name="${scheduler_id:0:32}.${scheduler_id:32}.scheduler.sccache.invalid"
source_sha=99c4ed63d72b4aa5444302b8e2cf9d968fff8e12
release="https://github.com/codeandsolder/sccache-deduplicated/releases/download/sccache-ci-$source_sha"
mkdir -p "$root/identity"
case "${1:?probe or compile}" in
probe)
    test "$(openssl x509 -in "$anchor" -noout -fingerprint -sha256 | cut -d= -f2)" = C3:19:7B:59:41:B9:59:16:06:93:F4:BA:6A:E1:2F:A3:67:57:86:BC:3C:D7:0E:F7:76:07:01:B6:73:12:CF:74
    for port in 10600 10602; do
        echo "Checking authenticated scheduler endpoint $scheduler_ip:$port"
        timeout 20 openssl s_client -connect "$scheduler_ip:$port" -servername "$scheduler_name" \
            -verify_hostname "$scheduler_name" -verify_return_error -CAfile "$anchor" \
            -tls1_3 -brief </dev/null
    done
    ;;
compile)
    # The secret contains only this canary's enrolled CLIENT key and certificate.
    # A missing/expired certificate fails; the placeholder cannot enroll a new key.
    trap 'if [[ -x "$root/sccache-linux-x86_64-v2" && -S "$root/daemon.sock" ]]; then SCCACHE_SERVER_UDS="$root/daemon.sock" "$root/sccache-linux-x86_64-v2" --stop-server >/dev/null 2>&1 || true; fi; rm -rf -- "$root"' EXIT
    printf '%s' "${CANARY_IDENTITY:?missing enrolled canary identity}" | base64 --decode | tar -xf - -C "$root/identity" key.pem leaf.der
    unset CANARY_IDENTITY
    chmod 0600 "$root/identity/"{key.pem,leaf.der}
    cd "$root"
    for file in build.txt SHA256SUMS sccache-linux-x86_64-v2 sccache-dist-linux-x86_64-v2; do
        curl --fail --silent --show-error --location --retry 2 --connect-timeout 10 --max-time 180 \
            "$release/$file" -o "$file"
    done
    for field in "source_sha=$source_sha" "dist_protocol=5" "rollout_epoch=6"; do
        grep -Fxq "$field" build.txt
    done
    sha256sum --check --ignore-missing SHA256SUMS
    for file in sccache-linux-x86_64-v2 sccache-dist-linux-x86_64-v2; do
        grep -Eq "^[[:xdigit:]]{64}  $file$" SHA256SUMS
        chmod 0755 "$file"
    done
    bin="$root/sccache-linux-x86_64-v2"
    export SCCACHE_CONF="$root/client.toml" SCCACHE_SERVER_UDS="$root/daemon.sock"
    cat > "$SCCACHE_CONF" <<EOF
[dist]
scheduler_url = "https://$scheduler_ip:10600"
cache_dir = "$root/toolchains"
toolchain_cache_size = 4294967296
toolchains = []
[dist.auth]
type = "token"
token = "pre-enrolled-canary-only"
[dist.cluster]
directory = "$root/identity"
ca_certificate = "$anchor"
scheduler_id = "$scheduler_id"
[dist.native]
endpoint = "https://$scheduler_ip:10602"
platform_contract = "linux-x86_64-zen2-explicit-codegen-bwrap-v1"
request_timeout_secs = 120
build_timeout_secs = 600
renewal_interval_secs = 15
max_metadata_bytes = 67108864
max_result_bytes = 1073741824
[cache.disk]
dir = "$root/l0"
size = 1073741824
EOF
    "$root/sccache-dist-linux-x86_64-v2" cluster-status --client-config "$SCCACHE_CONF" | jq -e '.num_servers >= 1'
    "$bin" --version
    # Unique per attempt; the warm pass uses identical inputs but a new daemon and
    # empty L0. A local fallback cannot satisfy either acceptance assertion.
    printf 'const char *hosted_canary(void) { return "%s-%s"; }\n' "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" > probe.c
    "$bin" --start-server
    "$bin" --zero-stats
    "$bin" /usr/bin/gcc -O2 -march=x86-64-v2 -c probe.c -o probe.o
    "$bin" --show-stats --stats-format json > cold.json
    jq -e '(.stats.dist_compiles | [.[]] | add // 0) == 1 and .stats.dist_errors == 0 and .stats.cache_read_errors == 0 and .stats.cache_write_errors == 0' cold.json
    sha256sum probe.o > expected.sha256
    "$bin" --stop-server
    rm -rf -- "$root/l0" "$root/toolchains"
    rm -f probe.o
    "$bin" --start-server
    "$bin" --zero-stats
    "$bin" /usr/bin/gcc -O2 -march=x86-64-v2 -c probe.c -o probe.o
    sha256sum --check expected.sha256
    "$bin" --show-stats --stats-format json > warm.json
    jq -e '(.stats.cache_hits.counts | [.[]] | add // 0) == 1 and (.stats.dist_compiles | [.[]] | add // 0) == 0 and .stats.dist_errors == 0 and .stats.cache_read_errors == 0 and .stats.cache_write_errors == 0' warm.json
    echo "PASS: GitHub hosted client compiled on fleet, then retrieved identical output from shared native CAS with cold L0."
    ;;
*) exit 2 ;;
esac
