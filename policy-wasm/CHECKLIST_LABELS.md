# Generic PR checklist/label mapping policy

This reusable composite action checks one checkout PR template against one
GitHub Actions labeler workflow. All decisions run in the existing Rust/WASI
shared policy module, with read-only access to the caller checkout through the
sandboxed shared workspace bridge.

The caller supplies:
- Template Markdown path, default .github/PULL_REQUEST_TEMPLATE.md.
- Labeler workflow YAML path.
- Exact second-level Markdown checklist section heading.
- The name of a JavaScript constant that contains a strict JSON array literal.

The map is written once as a JavaScript JSON literal in an existing
github-script step. Each element has text (checklist wording), label (GitHub
label name), and color (six hexadecimal digits). Strict JSON syntax prevents
ambiguous dynamic JavaScript object construction: no unquoted property keys,
computed labels, trailing commas, or arbitrary functions in the map. Other
project-specific script behavior remains untouched.

The guest locates exactly one GitHub Actions with.script scalar containing
the named constant, parses its JSON literal and compares exact text sets with
a simple Markdown checklist section. It rejects duplicate labels (case-insensitive)/checkboxes,
invalid map records, missing mappings, unrecognized checklist syntax,
ambiguous workflow definitions, checkout escapes and zero-item sections.

A caller uses the shared pinned composite action:

~~~yaml
- uses: codeandsolder/ci-workflows/.github/actions/pr-checklist-labels@COMMIT
  with:
    template: .github/PULL_REQUEST_TEMPLATE.md
    workflow: .github/workflows/pr-tags.yml
    section: Type of change
    mapping-variable: TYPE_LABELS
~~~

This policy validates declarative cross-file consistency, not the project
specific actions performed when applying labels. Network writes remain in
the trusted GitHub labeler action, not in WASI. The shared test suite covers
both the freshly compiled and digest-pinned bundled modules on Linux/macOS/
Windows; tests include positive parity, drift, malformed JSON and invalid
mappings.
