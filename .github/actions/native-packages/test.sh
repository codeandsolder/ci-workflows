#!/usr/bin/env bash
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
mkdir "$root/bin"
export TEST_LOG=$root/calls
export PATH="$root/bin:$PATH"
cat > "$root/bin/sudo" <<'MOCK'
#!/usr/bin/env bash
printf 'sudo %s\n' "$*" >> "$TEST_LOG"
MOCK
cat > "$root/bin/sccache-runtime-profile" <<'MOCK'
#!/usr/bin/env bash
printf 'profile %s\n' "$*" >> "$TEST_LOG"
[[ $3 != *missing* ]] || exit 69
printf 'sha256:example\n'
MOCK
chmod +x "$root/bin/"*
printf 'poppler-utils\n  ripgrep # guard\n\npoppler-utils\n' > "$root/manifest"
printf 'sha256:base\n' > "$root/base"
: > "$TEST_LOG"
bash .github/actions/native-packages/prepare.sh hosted "$root/manifest" '' "$root/base" "$root/catalog"
diff -u <(printf 'sudo apt-get update\nsudo apt-get install -y --no-install-recommends -- poppler-utils ripgrep\n') "$TEST_LOG"
: > "$TEST_LOG"
bash .github/actions/native-packages/prepare.sh managed "$root/manifest" '' "$root/base" "$root/catalog"
diff -u <(printf 'profile select sha256:base %s %s\n' "$root/manifest" "$root/catalog") "$TEST_LOG"
: > "$TEST_LOG"
bash .github/actions/native-packages/prepare.sh managed "$root/manifest" 'host-tool' "$root/base" "$root/catalog"
diff -u <(printf 'profile select sha256:base %s %s\nsudo apt-get update\nsudo apt-get install -y -- host-tool\n' "$root/manifest" "$root/catalog") "$TEST_LOG"
: > "$TEST_LOG"
printf 'poppler-utils\n' > "$root/missing"
if bash .github/actions/native-packages/prepare.sh managed "$root/missing" 'host-tool' "$root/base" "$root/catalog"; then exit 1; else [[ $? == 69 ]]; fi
diff -u <(printf 'profile select sha256:base %s %s\n' "$root/missing" "$root/catalog") "$TEST_LOG"
: > "$TEST_LOG"
printf '%s\n' '--allow-unauthenticated' > "$root/invalid"
if bash .github/actions/native-packages/prepare.sh hosted "$root/invalid" '' "$root/base" "$root/catalog"; then exit 1; else [[ $? == 65 ]]; fi
[[ ! -s $TEST_LOG ]]
bash .github/actions/native-packages/prepare.sh hosted '' '' "$root/base" "$root/catalog"
[[ ! -s $TEST_LOG ]]
echo 'Native package preparation tests passed'
: > "$TEST_LOG"
printf 'oracle sha256:%064d https://example.com/oracle.deb\n' 7 > "$root/pinned"
bash .github/actions/native-packages/prepare.sh managed "$root/pinned" '' "$root/base" "$root/catalog"
diff -u <(printf 'profile select sha256:base %s %s\n' "$root/pinned" "$root/catalog") "$TEST_LOG"
: > "$TEST_LOG"
printf 'oracle sha256:%064d https://example.com/oracle.deb\noracle\n' 7 > "$root/conflict"
if bash .github/actions/native-packages/prepare.sh hosted "$root/conflict" '' "$root/base" "$root/catalog"; then exit 1; else [[ $? == 65 ]]; fi
[[ ! -s $TEST_LOG ]]
printf 'archive contents\n' > "$root/deb-fixture"
digest=$(sha256sum "$root/deb-fixture" | cut -d ' ' -f1)
export TEST_DEB_FIXTURE=$root/deb-fixture
cat > "$root/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
while (($#)); do
    if [[ $1 == --output ]]; then cp "$TEST_DEB_FIXTURE" "$2"; exit; fi
    shift
done
exit 1
MOCK
cat > "$root/bin/dpkg-deb" <<'MOCK'
#!/usr/bin/env bash
case "$3" in Package) echo oracle;; Version) echo 47-1;; *) exit 1;; esac
MOCK
cat > "$root/bin/dpkg-query" <<'MOCK'
#!/usr/bin/env bash
printf '47-1'
MOCK
chmod +x "$root/bin/"{curl,dpkg-deb,dpkg-query}
printf 'oracle sha256:%s https://example.com/oracle.deb\nripgrep\n' "$digest" > "$root/pinned"
bash .github/actions/native-packages/prepare.sh hosted "$root/pinned" '' "$root/base" "$root/catalog"
rg -q 'sudo apt-get install -y --no-install-recommends -- .*/oracle.deb ripgrep$' "$TEST_LOG"
: > "$TEST_LOG"
printf 'oracle sha256:%064d https://example.com/oracle.deb\n' 7 > "$root/wrong-digest"
if bash .github/actions/native-packages/prepare.sh hosted "$root/wrong-digest" '' "$root/base" "$root/catalog"; then exit 1; fi
[[ ! -s $TEST_LOG ]]
echo 'Pinned Debian archive hosted/managed tests passed'
