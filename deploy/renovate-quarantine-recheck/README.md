# Central Renovate quarantine recheck

One hourly cold-storage systemd timer, using the existing scoped GitHub App
identity through /usr/local/bin/gh and github-app-git-credential.

This is not a release-age bypass. The script only re-runs an Actions job
after its failure log proves every new crates.io version has aged at least
72 hours, plus a 15-minute margin. The actual CI gate runs again; normal
Renovate automerge alone handles successful PRs.

- Discover all nonarchived repositories in the GitHub App installation.
- Inspect only open Renovate PRs at the exact current head.
- Select completed failed GitHub Actions quarantine or strict-Rust jobs.
- Require that the sole failed step be the Cargo quarantine.
- Refuse missing timestamps, unexpected reasons, other failed jobs,
  queued/in-progress checks, changed PR heads, or repeat run attempts.
- Revalidate the PR head, job and check state immediately before mutation.
- Rerun only the specific failed job, not whole workflow runs.
- JSON-lines audit output includes crate versions and eligibility dates.
- No daemon, database, persistent state, cache or build artifacts.
- Default read-only mode; --apply is required, --max caps one sweep.

## Installation on cold-storage

Run the following one time as the existing authorized operator. The source
is the merged ci-workflows main branch; the live checkout is under /srv.

    sudo install -d -o sentinelx -g sentinelx -m 0755 /srv/ci-workflows
    sudo -u sentinelx git clone --depth=1 https://github.com/codeandsolder/ci-workflows.git /srv/ci-workflows
    sudo install -m 0644 deploy/renovate-quarantine-recheck/renovate-quarantine-recheck.service /etc/systemd/system/
    sudo install -m 0644 deploy/renovate-quarantine-recheck/renovate-quarantine-recheck.timer /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now renovate-quarantine-recheck.timer

If /srv/ci-workflows already exists, pull --ff-only rather than re-cloning.
The service updates its checkout before every run; a failed pull blocks retry.
It uses the existing GitHub App helper, not an unscoped PAT.
The privileged ExecStartPre invokes the existing root-owned token-minting oneshot, so the actual fleet scanner can run under NoNewPrivileges=true with a fresh scoped credential.

## Verification and operations

    sudo -u sentinelx /usr/bin/node /srv/ci-workflows/scripts/renovate-quarantine-recheck.mjs --repo=codeandsolder/sccache-deduplicated
    sudo systemctl start renovate-quarantine-recheck.service
    sudo journalctl -u renovate-quarantine-recheck.service -n 100 --no-pager
    systemctl list-timers renovate-quarantine-recheck.timer

    node --test scripts/renovate-quarantine-recheck*.test.mjs

Do not deploy this timer on each runner; this is one fleet controller.
