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
fail() { printf '%s\n' "$*" >&2; exit 65; }
normalize() {
    local manifest=$1 line name digest url extra canonical
    declare -A seen=()
    [[ -f $manifest && -r $manifest ]] || fail "Cannot read runtime package manifest: $manifest"
    while IFS= read -r line || [[ -n $line ]]; do
        line=${line%%#*}
        read -r name digest url extra <<< "$line"
        [[ -n $name ]] || continue
        [[ $name =~ ^[a-z0-9][a-z0-9+.-]+$ ]] || fail "Invalid Debian package name in $manifest: $name"
        canonical=$name
        if [[ -n $digest || -n $url || -n $extra ]]; then
            [[ $digest =~ ^sha256:[0-9a-f]{64}$ && $url =~ ^https://[a-zA-Z0-9._~:/%+@=-]+\.deb$ && -z $extra ]] || fail "Invalid pinned Debian archive declaration in $manifest: $line"
            canonical="$name $digest $url"
        fi
        [[ ! ${seen[$name]+present} || ${seen[$name]} == "$canonical" ]] || fail "Conflicting declarations for package $name"
        seen[$name]=$canonical
    done < "$manifest"
    if ((${#seen[@]})); then printf '%s\n' "${seen[@]}" | LC_ALL=C sort; fi
}
requested=()
declare -A pinned_versions=()
scratch=''
trap 'if [[ -n $scratch ]]; then rm -rf -- "$scratch"; fi' EXIT
if [[ -n $manifest && ( -e $manifest || -L $manifest ) ]]; then
    normalized=$(normalize "$manifest")
    if [[ -n $normalized ]]; then
        if [[ $mode == managed ]]; then
            # Missing runtime/catalog is a provisioning failure, not a reason
            # to install host packages or attempt another compiler runtime.
            read -r base < "$base_file"
            image=$(sccache-runtime-profile ensure "$base" "$manifest" "$catalog" /run/sccache-runtime-profile.sock)
            printf 'Resolved managed native package image: %s\n' "$image"
        else
            while read -r name digest url; do
                if [[ -z $digest ]]; then requested+=("$name"); continue; fi
                if [[ -z $scratch ]]; then scratch=$(mktemp -d); chmod 755 "$scratch"; fi
                archive=$scratch/$name.deb
                curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --retry 3 --max-time 300 --output "$archive" "$url"
                printf '%s  %s\n' "${digest#sha256:}" "$archive" | sha256sum -c -
                [[ $(dpkg-deb -f "$archive" Package) == "$name" ]] || fail "Archive package name differs from $name"
                pinned_versions[$name]=$(dpkg-deb -f "$archive" Version)
                requested+=("$archive")
            done <<< "$normalized"
        fi
    fi
fi
read -r -a host <<< "$host_packages"
if ((${#requested[@]} + ${#host[@]})); then
    sudo apt-get update
    if ((${#requested[@]})); then sudo apt-get install -y --no-install-recommends -- "${requested[@]}"; fi
    if ((${#host[@]})); then sudo apt-get install -y -- "${host[@]}"; fi
fi

for name in "${!pinned_versions[@]}"; do
    [[ $(dpkg-query -W -f='${Version}' -- "$name") == "${pinned_versions[$name]}" ]] || fail "Installed package version differs from pinned archive: $name"
done
