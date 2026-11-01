# Local release flow

This repository intentionally has no remote. `dev` is the working branch and
`release` is the stable branch. Releases are tagged locally.

## Branches

- `dev` — day-to-day changes, tests, and version bumps.
- `release` — only commits merged from `dev` that are ready to ship.

## One-time setup

```powershell
git init -b dev
git add -A
git commit -m "chore: initial FocusFlow dev branch"
git checkout -b release
git checkout dev
```

## Normal release

1. Update `manifest.json` and `package.json` to the same semver.
2. Add a matching `## [x.y.z] - YYYY-MM-DD` section to `CHANGELOG.md`.
3. Run checks:
   ```powershell
   node tests/all.mjs
   node tools/check.mjs
   ```
4. Commit on `dev`:
   ```powershell
   git add -A
   git commit -m "feat: ..."
   ```
5. Merge into `release`, tag, and return to `dev`:
   ```powershell
   .\tools\release.ps1
   ```
   The script validates the version/changelog, requires a clean tree, merges
   `dev` into `release` with `--no-ff`, and creates `vX.Y.Z`.
6. No remote push is performed. The release exists as a local branch + tag.

## Hotfix

```powershell
git checkout release
# edit, bump patch version, add changelog entry, commit
git tag -a vX.Y.Z -m "release: vX.Y.Z"
git checkout dev
git merge --no-ff release
```

## Rollback

```powershell
git checkout release
git reset --hard vPREVIOUS
```

Do not force-push; there is no remote.
