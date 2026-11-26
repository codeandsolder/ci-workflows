#!/usr/bin/env bash
set -euo pipefail
toolchain=${1:?toolchain required}
components=${2-}
targets=${3-}
select=${4-false}
[[ "$toolchain" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]
[[ "$select" == true || "$select" == false ]]
IFS=', ' read -r -a component_list <<< "$components"
IFS=', ' read -r -a target_list <<< "$targets"
if ! rustup run "$toolchain" rustc --version >/dev/null 2>&1; then
    flags=()
    for component in "${component_list[@]}"; do flags+=(--component "$component"); done
    for target in "${target_list[@]}"; do flags+=(--target "$target"); done
    rustup toolchain install "$toolchain" --profile minimal --no-self-update "${flags[@]}"
else
    if (( ${#component_list[@]} )); then
        rustup component add --toolchain "$toolchain" "${component_list[@]}"
    fi
    if (( ${#target_list[@]} )); then
        rustup target add --toolchain "$toolchain" "${target_list[@]}"
    fi
fi
rustup run "$toolchain" rustc --version
if [[ "$select" == true ]]; then
    # The workflow process, not rustup settings.toml, owns the selection.
    printf 'RUSTUP_TOOLCHAIN=%s\n' "$toolchain" >> "${GITHUB_ENV:?GITHUB_ENV missing}"
fi
