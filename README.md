# ci-workflows

Centrally managed reusable GitHub Actions workflows for `codeandsolder` repositories.

## Rust shared sccache

`.github/workflows/rust-sccache.yml` runs a caller-supplied Rust command on a GitHub-hosted Linux runner. On trusted `push` and `workflow_dispatch` events it:

- joins the tailnet with GitHub OIDC workload identity federation;
- verifies the tailnet-only Garage S3 ingress;
- uses the maintained `codeandsolder/sccache-deduplicated` fork in canonical-Rust mode with a persistent runner-local L0 and Garage L1;
- obtains the dedicated Garage credentials from the tailnet-only broker and fails closed if trusted cache access is unavailable.

The Tailscale Client ID and Audience embedded in the workflow are identifiers, not secrets. The federated identity is restricted by Tailscale claim matching and can mint only ephemeral nodes carrying the existing `tag:sccache-worker` tag.

The reusable workflow deliberately refuses ordinary pull-request events. PR CI should stay in a job without `id-token: write`; this prevents checked-out untrusted code from requesting an OIDC token directly.

Caller repositories do not need Garage secrets in normal operation. The tagged runner obtains dedicated cache credentials from the tailnet-only broker. The two optional reusable-workflow secrets remain only as an explicit fallback for controlled recovery:

- `SCCACHE_S3_ACCESS_KEY_ID`
- `SCCACHE_S3_SECRET_ACCESS_KEY`

The workflow fails closed rather than silently running a trusted cache job uncached when neither broker nor fallback credentials are available.


## Tailnet credential broker

The server-side broker lives in `broker/`. It binds only to cold-storage's Tailscale address on TCP 3903. For `GET /v1/sccache-credentials` it:

1. identifies the TCP peer with `tailscale whois`;
2. requires `tag:sccache-worker`;
3. obtains the dedicated `github-actions-sccache` key from the local Garage CLI;
4. returns only the sccache S3 connection parameters with `Cache-Control: no-store`.

The reusable workflow masks both returned key values immediately. Garage itself remains available only over the tailnet, and the dedicated key has RW permission only on the `sccache` bucket.

The broker is intentionally a system service rather than a copied GitHub secret. This makes importing the reusable workflow into another repository secret-free while keeping authentication rooted in GitHub OIDC -> Tailscale machine identity.

## Rolling local L0

Trusted jobs restore a per-repository rolling 1 GiB local sccache L0 before the Cargo command. New or backfilled objects are emitted as a short-lived delta artifact. Caller repositories should pair the trusted build with a small `workflow_run` wrapper around `.github/workflows/merge-sccache-l0.yml`; the reusable merger serializes updates, bounds the snapshot, saves the next cache generation, and deletes the merged delta artifact.

Direct GitHub-hosted `sccache-dist` worker mode is available through `distributed: true`, but remains opt-in. The normal deployment path uses `distributed: false` and relies on persistent L0 plus Garage L1.


### Cargo compatibility

The shared Rust workflow uses the maintained ephemeral Cargo client by default so registry source paths are normalized for cross-run cache reuse. Callers whose compile-time tooling spawns `$CARGO` for nested workspace queries can set `ephemeral-cargo: false`; this switches only Cargo back to the stock toolchain client while retaining the same sccache L0/Garage configuration.
