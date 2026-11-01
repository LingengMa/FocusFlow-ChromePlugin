param(
  [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$manifest = Get-Content 'manifest.json' -Raw -Encoding UTF8 | ConvertFrom-Json
$package = Get-Content 'package.json' -Raw -Encoding UTF8 | ConvertFrom-Json
$version = if ($Version) { $Version } else { [string]$manifest.version }

if ([string]$manifest.version -ne $version -or [string]$package.version -ne $version) {
  throw "manifest/package version mismatch (manifest=$($manifest.version), package=$($package.version), requested=$version)"
}

$changelog = Get-Content 'CHANGELOG.md' -Raw -Encoding UTF8
if ($changelog -notmatch "(?m)^##\s+\[$([regex]::Escape($version))\]") {
  throw "CHANGELOG.md has no '## [$version]' section"
}

if (git status --porcelain) {
  throw 'Working tree is not clean. Commit changes on dev first.'
}

if (-not (git rev-parse --verify dev 2>$null)) {
  throw 'dev branch does not exist'
}
if (-not (git rev-parse --verify release 2>$null)) {
  git checkout -b release dev | Out-Null
}

$tag = "v$version"
if (git tag --list $tag) {
  throw "tag $tag already exists"
}

git checkout dev | Out-Null
$previous = git rev-parse --abbrev-ref HEAD
try {
  git checkout release | Out-Null
  git merge --no-ff dev -m "release: $tag" | Out-Null
  git tag -a $tag -m "release: $version"
  Write-Host "Released $tag on local release branch (no remote push)."
} finally {
  git checkout dev | Out-Null
}
