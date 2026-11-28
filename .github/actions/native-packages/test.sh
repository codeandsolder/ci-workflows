#!/usr/bin/env bash
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
mkdir "$root/bin" "$root/manifest" "$root/missing" "$root/pinned"
export TEST_LOG=$root/calls
export PATH="$root/bin:$PATH"
cat > "$root/bin/sudo" <<'MOCK'
#!/usr/bin/env bash
printf 'sudo %s\n' "$*" >> "$TEST_LOG"
MOCK
cat > "$root/bin/sccache-runtime-profile" <<'MOCK'
#!/usr/bin/env bash
[[ $1 == manifest ]]
printf '%s/.sccache-runtime-packages\n' "$2"
MOCK
cat > "$root/bin/sccache-runtime" <<'MOCK'
#!/usr/bin/env bash
printf 'runtime %s\n' "$*" >> "$TEST_LOG"
[[ $2 != *missing* ]] || exit 69
MOCK
chmod +x "$root/bin/"*
printf 'poppler-utils\n  ripgrep # guard\n\npoppler-utils\n' > "$root/manifest/.sccache-runtime-packages"
: > "$TEST_LOG"
bash .github/actions/native-packages/prepare.sh hosted "$root/manifest/.sccache-runtime-packages" ''
diff -u <(printf 'sudo apt-get update\nsudo apt-get install -y --no-install-recommends -- poppler-utils ripgrep\n') "$TEST_LOG"
: > "$TEST_LOG"
bash .github/actions/native-packages/prepare.sh managed "$root/manifest/.sccache-runtime-packages" ''
diff -u <(printf 'runtime --project-dir %s --offline -- true\n' "$root/manifest") "$TEST_LOG"
: > "$TEST_LOG"
bash .github/actions/native-packages/prepare.sh managed "$root/manifest/.sccache-runtime-packages" 'host-tool'
diff -u <(printf 'runtime --project-dir %s --offline -- true\nsudo apt-get update\nsudo apt-get install -y -- host-tool\n' "$root/manifest") "$TEST_LOG"
: > "$TEST_LOG"
printf 'poppler-utils\n' > "$root/missing/.sccache-runtime-packages"
if bash .github/actions/native-packages/prepare.sh managed "$root/missing/.sccache-runtime-packages" 'host-tool'; then exit 1; else [[ $? == 69 ]]; fi
diff -u <(printf 'runtime --project-dir %s --offline -- true\n' "$root/missing") "$TEST_LOG"
: > "$TEST_LOG"
printf '%s\n' '--allow-unauthenticated' > "$root/invalid"
if bash .github/actions/native-packages/prepare.sh hosted "$root/invalid" ''; then exit 1; else [[ $? == 65 ]]; fi
[[ ! -s $TEST_LOG ]]
bash .github/actions/native-packages/prepare.sh hosted '' ''
[[ ! -s $TEST_LOG ]]
echo 'Native package preparation tests passed'
: > "$TEST_LOG"
printf 'oracle sha256:%064d https://example.com/oracle.deb\n' 7 > "$root/pinned/.sccache-runtime-packages"
bash .github/actions/native-packages/prepare.sh managed "$root/pinned/.sccache-runtime-packages" ''
diff -u <(printf 'runtime --project-dir %s --offline -- true\n' "$root/pinned") "$TEST_LOG"
: > "$TEST_LOG"
printf 'oracle sha256:%064d https://example.com/oracle.deb\noracle\n' 7 > "$root/conflict"
if bash .github/actions/native-packages/prepare.sh hosted "$root/conflict" ''; then exit 1; else [[ $? == 65 ]]; fi
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
printf 'oracle sha256:%s https://example.com/oracle.deb\nripgrep\n' "$digest" > "$root/pinned/.sccache-runtime-packages"
bash .github/actions/native-packages/prepare.sh hosted "$root/pinned/.sccache-runtime-packages" ''
[[ $(<"$TEST_LOG") == *'sudo apt-get install -y --no-install-recommends -- '*'/oracle.deb ripgrep' ]]
: > "$TEST_LOG"
printf 'oracle sha256:%064d https://example.com/oracle.deb\n' 7 > "$root/wrong-digest"
if bash .github/actions/native-packages/prepare.sh hosted "$root/wrong-digest" ''; then exit 1; fi
[[ ! -s $TEST_LOG ]]
echo 'Pinned Debian archive hosted/managed tests passed'
