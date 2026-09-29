# ci-workflows

Centrally managed reusable GitHub Actions workflows for `codeandsolder` repositories.

## Rust shared sccache

`.github/workflows/rust-sccache.yml` runs a caller-supplied Rust command on a GitHub-hosted Linux runner. On trusted `push` and `workflow_dispatch` events it:

- joins the tailnet with GitHub OIDC workload identity federation;
- verifies the tailnet-only Garage S3 ingress;
- uses the maintained `codeandsolder/sccache-deduplicated` fork in canonical-Rust mode when the caller supplies the dedicated Garage credentials;
- falls back to running the command normally if those optional cache credentials are not configured.

The Tailscale Client ID and Audience embedded in the workflow are identifiers, not secrets. The federated identity is restricted by Tailscale claim matching and can mint only ephemeral nodes carrying the existing `tag:sccache-worker` tag.

The reusable workflow deliberately refuses ordinary pull-request events. PR CI should stay in a job without `id-token: write`; this prevents checked-out untrusted code from requesting an OIDC token directly.

Caller repositories only need the two optional repository secrets below to enable the shared Garage cache:

- `SCCACHE_S3_ACCESS_KEY_ID`
- `SCCACHE_S3_SECRET_ACCESS_KEY`

Without them, the workflow still validates OIDC/Tailscale connectivity and runs the requested Rust command without sccache.
