# Conditional language quality modules

The reusable workflow .github/workflows/source-quality.yml uses one Linux X64 runner and the existing Git-index source detector. It runs only the modules whose sources are tracked in the caller, skipping all irrelevant language installation. Public callers use ubuntu-24.04; private callers use the established local-ci pool.

## Pinning and defaults

Invoke the reusable workflow as a normal job, pinned to a full merged commit SHA followed by the branch comment "# main" so Renovate can advance it.

The default checks are blocking ShellCheck for Bash/POSIX scripts, shfmt syntax parsing (also parses Zsh), Oxlint correctness for JavaScript/TypeScript, and CPU-only Naga 30.0.2 WGSL parsing and semantic validation. Versioned binaries (ShellCheck 0.11.0, shfmt 3.14.1 and Oxlint 1.95.0) are installed in runner temp and SHA256-verified.

Optional workflow inputs:
- shell-format: true — enforce shfmt formatting, not just syntax. Enable only after normalizing each consumer.
- python-quality: true — run the existing strict rust-skills2 Ruff + ty policy for Python-first projects, without the Rust-only restriction on non-CI Python source. Rust callers already running strict Rust must not duplicate this pass.
- shell: false, javascript: false, wgsl: false — skip a module when the caller already has equivalent native checks, not as an unrecorded lint exemption.

The detector recognizes Bash/POSIX extensions and extensionless shell shebangs. ShellCheck cannot analyze Zsh; such scripts are still parsed by shfmt. Filenames with spaces are safe, and source paths are checked against the caller root. No untracked build outputs or injected provider source are analyzed.

## Assembled WGSL modules

Many Rust applications concatenate several WGSL snippets into an actual shader module. Checking each source fragment alone is incorrect. When the caller ships composed shaders, declare ordered source groups in .github/wgsl-quality.json using this schema:

    {
      "format": 1,
      "modules": [
        {"name": "compaction", "sources": ["src/gpu_instance.wgsl", "src/compact.wgsl"]}
      ],
      "negative_tests": []
    }

All referenced sources must be Git-tracked regular files in the caller checkout. Every declared group is validated as one complete shader; any unreferenced WGSL is independently validated. Deliberately invalid fixtures can be listed under negative_tests, and must actually fail validation. There are no generic ignore globs or silent exclusions. If shader text is generated dynamically, native application tests must continue to test that generated text; this source-only gate does not replace them.

The Naga validator is locked in languages/wgsl/Cargo.lock and compiled using the existing managed sccache on stable Rust only when WGSL is present. It runs in the default debug profile, because Naga source validation does not benefit from release optimizations and those can turn a small check into minutes of compiler work. Build outputs remain in runner temp.

## GitHub Actions quality

The existing workflow-concurrency.yml reusable policy now also checks actual tracked caller workflows using actionlint 1.7.12 in the same runner. Its separate ShellCheck and Python integrations are disabled to avoid duplicated analysis. Narrow false-positive exceptions cover GitHub hosted ubuntu-26.04 and the currently unsupported reusable-workflow fields job.workflow_repository / job.workflow_sha; the local-ci runner label is explicitly known. All other expression, workflow metadata and YAML findings remain fatal.

No project C/C++ compilation, Java PMD, TypeScript application typechecking, runtime dependency installation, Rust lint policy or external Cargo quarantine behavior changes.
