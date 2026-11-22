# Fleet Rust nightly scheduler

One daily check, weekly maximum promotion cadence. Resume an existing cohort
candidate, refresh outdated branches, and promote only if the entire cohort's
real checks are green. A failure retains the old coordinator pin. No upstream
issue filtering. A failed candidate remains visible for investigation.

Deploy on cold-storage only after all intended repositories have merged the
initial common pin and been enrolled in nightly-cohort.json. Uses the existing
/srv/ci-workflows checkout and GitHub App authentication, exactly as the existing
Renovate quarantine service. Run the read-only tick before enabling.

    sudo -u sentinelx git -C /srv/ci-workflows pull --ff-only origin main
    sudo -u sentinelx /usr/bin/node /srv/ci-workflows/scripts/nightly-cohort.mjs tick
    sudo install -m 0644 /srv/ci-workflows/deploy/nightly-cohort/nightly-cohort.{service,timer} /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now nightly-cohort.timer

Investigate held candidates with journalctl -u nightly-cohort.service and
the candidate PRs; do not bypass failing tests. Cross-repository publication
is sequential, coordinator last; an interrupted promotion resumes next tick.
