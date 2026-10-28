# Git Path Preview

[![Tests](https://github.com/kiaqyn/git-path-preview/actions/workflows/test.yml/badge.svg)](https://github.com/kiaqyn/git-path-preview/actions/workflows/test.yml)

[中文说明](README.zh-CN.md)

Preview path lengths and common Windows filename incompatibilities in a Git commit for a **specific Windows checkout destination**. This is an experimental, read-only tool, not a guarantee that a checkout will succeed.

## Requirements

Node.js 20+ and Git 2.45 or newer, available on PATH. No npm packages are needed. Git 2.45 is the baseline for the `--no-lazy-fetch` option used to prevent implicit downloads; earlier Git versions with the corresponding backport may work but have not been verified.

From a source checkout, run:

```powershell
node preview.mjs C:\path\to\repo C:\target\checkout
node preview.mjs C:\path\to\repo C:\target\checkout --ref main --threshold 260 --json
node preview.mjs https://github.com/OWNER/REPO.git C:\target\checkout --remote
node --test test.mjs
```

The destination is the full path of the intended checkout, not its parent. Local mode disables Git's on-demand fetching and does not clone, fetch, modify configuration, or create a working tree. If a partial clone lacks required tree objects, the scan fails rather than silently downloading them; obtain the necessary objects separately using a method you trust. Remote mode makes a shallow bare clone of the default branch in a new temporary directory and removes it after inspection; it does not create a working checkout or alter Git configuration. It requires network access, contacts the specified server, and may still transfer substantial data if the server does not support filtering. Remote mode has a 120-second timeout and accepts only HTTPS URLs without embedded credentials or query strings. It does not prompt for credentials, so it is intended for public repositories. Use a local repository to inspect other refs.

Before cloning, the tool asks Git to resolve `url.*.insteadOf` rewrites without contacting the remote and rejects a changed URL, even when the rewrite also points to HTTPS. Review your Git configuration or use a local repository if your setup relies on rewriting. This is a preflight check, not network isolation: Git configuration may change between the check and clone, and Git can still use configured proxies or follow HTTP redirects.

Exit codes: 0 = no warning, 1 = at least one warning or finding, 2 = input or Git error. Text output lists every long-path warning, or the ten longest paths when there are no length warnings. The JSON output contains all long-path warnings, filename findings and the ten longest paths. Findings cover common reserved device names, invalid characters, trailing dots/spaces, long path components, and case-only collisions including directory prefixes.

The `git_metadata_name` finding flags exact `.git` and `git~1` path components, ignoring case. Git for Windows rejects these in the tested checkout configuration with `core.protectNTFS=true`. The check is conservative and does not cover all Git metadata aliases or all configurations.

The `git_ntfs_device_name` finding flags `LPT0`, `CONIN$`, and `CONOUT$` stems, including extensions, ignoring case. Git for Windows rejected the tested examples with `core.protectNTFS=true`; behavior can differ with other Git and filesystem settings. A warning is not proof of failure in every configuration.

The destination is normalized, and directory components after the drive or UNC share are rejected if they contain Windows-invalid characters such as `|` or `:`. This is input validation, not a filesystem probe: it does not validate the UNC server/share, existence, permissions, or all special naming behavior.

Reports include the immutable Git tree object ID actually inspected. A branch name such as `HEAD` may move between runs; the tree ID identifies the exact set of paths examined. Local `--ref` may refer to a commit, tag or tree.

The command refuses to run if `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES` or `GIT_NAMESPACE` is set. These inherited Git environment overrides can change repository, object or ref lookup; run in a shell without them. This restriction also applies to remote mode. See the [Git environment reference](https://git-scm.com/docs/git#_environment_variables).

The tool deliberately ignores Git replacement refs (`refs/replace`) when resolving and reading objects so the output describes the original object associated with the reported ID. If the local repository uses replacements, a normal local Git checkout may apply those replacements and can behave differently. Text and JSON reports state that replacements were ignored.

## Install from GitHub Release on Windows

Download `git-path-preview-0.1.0.tgz` from [v0.1.0](https://github.com/kiaqyn/git-path-preview/releases/tag/v0.1.0), check it against the attached `SHA256SUMS.txt`, and use the local archive instructions below. Node.js 20+ and Git 2.45+ are required. This package is distributed through GitHub Releases, not the npm registry.

## Install a local package archive on Windows

The archive is a local file, not an npm registry release. With Node.js and Git installed, open PowerShell in a directory where you want the local installation and run (replace the example paths):

```powershell
npm install --offline --no-audit --no-fund "C:\path to\git-path-preview-0.1.0.tgz"
node .\node_modules\git-path-preview\preview.mjs "C:\path to\repo" "C:\target checkout" --json
$LASTEXITCODE
```

The install is local and does not add a global command. Use the direct `node` invocation above in PowerShell: npm also generates a `.cmd` wrapper, but PowerShell's invocation of that wrapper can interpret characters such as `&` and `|` in arguments as shell syntax. `--offline` prevents npm from downloading packages, but using the tool's `--remote` option still accesses the remote Git server. Exit code 1 means warnings were found; 2 means an error. The archive includes the executable and documentation, but not `test.mjs`; run the tests from the source directory. To build an archive from source, run `npm pack` there. The package is marked private to prevent accidental registry publication; no registry release has been made.

## Limitations

- 260 is a conservative configurable warning threshold measured in UTF-16 code units, not a universal success/failure boundary. Behavior depends on Git, Windows, application and filesystem settings, and directory creation may have different constraints. Windows device namespace paths such as `\\?\C:\...` are not accepted.
- Checks only names in the selected commit. Submodule contents, generated files, untracked files and later commits are not checked. Git LFS content is not fetched. Invalid UTF-8 paths result in an error rather than a misleading length.
- Case comparison uses JavaScript lowercase as an approximation, not the exact behavior of every Windows filesystem. The 255-unit component warning is heuristic. This does not cover all Git/NTFS protections, Unicode equivalence, filesystem behavior, symlinks, permissions or application-specific behavior. A clean report does not imply checkout will succeed.
- File paths in output may be sensitive; review before sharing.

## Existing projects and evidence

Git for Windows documents [long path limitations](https://gitforwindows.org/faq.html); a [GitHub Desktop report](https://github.com/desktop/desktop/issues/17882) describes a failed checkout. Existing tools include [git-path-audit](https://github.com/bunta-expert/git-path-audit), [winpathlint](https://pkg.go.dev/github.com/otrumb/winpathlint), and [gclo](https://github.com/KofTwentyTwo/gclo). This prototype explores destination-specific length estimates; it does not establish unmet demand or superiority.

As documented for [git-path-audit v0.0.1](https://github.com/bunta-expert/git-path-audit/blob/v0.0.1/README.md), it scans index, staged changes, or a selected tree and covers Unicode normalization and review-safety rules; its documented exclusions include path-length policies. This tool estimates length against a user-specified Windows destination and can scan a remote default branch, but it does not implement those broader Unicode rules or staged/index scans. [winpathlint v0.2.0](https://github.com/otrumb/winpathlint/blob/v0.2.0/README.md) scans the index and applies a repository-relative length budget; it documents no revision or remote mode. `gclo` primarily clones and updates many repositories and is not a like-for-like path auditor. These are documentation-based comparisons, not independent comparative tests or evidence of demand.

See [VALIDATION.md](VALIDATION.md) for a dated real-world repository check and its limits.

## License

No project license has been selected. See [NOTICE.md](NOTICE.md).
