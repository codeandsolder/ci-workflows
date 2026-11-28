#!/usr/bin/env bash
# Project runtime packages have one declaration for managed and hosted native
# builds. Explicit workflow apt-packages remain host prerequisites.
set -euo pipefail
[[ $# == 5 ]] || { echo 'Usage: prepare.sh hosted|managed MANIFEST HOST_PACKAGES BASE_ID_FILE CATALOG_DIR' >&2; exit 64; }
mode=$1
manifest=$2
host_packages=$3
base_file=$4
catalog=$5
case "$mode" in hosted|managed) ;; *) exit 64 ;; esac
normalize() {
    local line
    [[ -f $manifest && -r $manifest ]] || { echo "Invalid native package manifest: $manifest" >&2; exit 65; }
    while IFS= read -r line || [[ -n $line ]]; do
        line=${line%%#*}
        line=${line#"${line%%[![:space:]]*}"}
        line=${line%"${line##*[![:space:]]}"}
        [[ -n $line ]] || continue
        [[ $line =~ ^[a-z0-9][a-z0-9+.-]+$ ]] || { echo "Invalid Debian package name: $line" >&2; exit 65; }
        printf '%s\n' "$line"
    done < "$manifest" | LC_ALL=C sort -u
}
requested=()
if [[ -n $manifest && ( -e $manifest || -L $manifest ) ]]; then
    normalized=$(normalize)
    if [[ -n $normalized ]]; then
        if [[ $mode == managed ]]; then
            # Missing runtime/catalog is a provisioning failure, not a reason
            # to install host packages or attempt another compiler runtime.
            read -r base < "$base_file"
            image=$(sccache-runtime-profile select "$base" "$manifest" "$catalog")
            printf 'Registered managed native package image: %s\n' "$image"
        else
            mapfile -t requested <<< "$normalized"
        fi
    fi
fi
read -r -a host <<< "$host_packages"
if ((${#requested[@]} + ${#host[@]})); then
    sudo apt-get update
    if ((${#requested[@]})); then sudo apt-get install -y --no-install-recommends -- "${requested[@]}"; fi
    if ((${#host[@]})); then sudo apt-get install -y -- "${host[@]}"; fi
fi
