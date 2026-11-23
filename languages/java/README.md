# Java quality module

Runs PMD 7.29.0 with the shared high-signal ruleset from quality.xml, on Java
files tracked by the caller Git index. No caller Gradle/Maven files, compilation,
project dependencies or Java build layout are necessary. Default behavior is
blocking (zero accepted findings). The policy enforces 229 source-only rules
with category-wide coverage for Best Practices, Error Prone, Performance and
Security, plus targeted concurrency, design, code style and documentation.
The few category exceptions are documented inline in quality.xml; they target
legitimate constructs rather than hiding existing findings. PMD prints
diagnostics to the build log, and the hosted reusable workflow saves a
seven-day HTML/XML artifact on failure. There is no accepted-warning baseline.

The module does not replace a project's actual build, tests or compiler lint;
those remain the project's own quality checks.

The top-level reusable workflow .github/workflows/java-quality.yml performs
source detection first. Only repositories with a tracked .java file install a
JDK/Gradle and run PMD.

Run directly with a checked-out caller and a compatible Gradle wrapper or
suitable local Gradle installation:

  node languages/detect.mjs /path/to/caller /tmp/java-manifest.json
  gradle --no-daemon -p languages/java analyzeJava -PsourceRoot=/path/to/caller -PsourceManifest=/tmp/java-manifest.json

Java and Rust are independent language modules; the detector emits both.
Add additional language modules alongside this one, not inside a Rust job.
