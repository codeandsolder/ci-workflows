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


## Tailnet credential broker

The server-side broker lives in `broker/`. It binds only to cold-storage's Tailscale address on TCP 3903. For `GET /v1/sccache-credentials` it:

1. identifies the TCP peer with `tailscale whois`;
2. requires `tag:sccache-worker`;
3. obtains the dedicated `github-actions-sccache` key from the local Garage CLI;
4. returns only the sccache S3 connection parameters with `Cache-Control: no-store`.

The reusable workflow masks both returned key values immediately. Garage itself remains available only over the tailnet, and the dedicated key has RW permission only on the `sccache` bucket.

The broker is intentionally a system service rather than a copied GitHub secret. This makes importing the reusable workflow into another repository secret-free while keeping authentication rooted in GitHub OIDC -> Tailscale machine identity.
