[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Repository,
    [Parameter(Mandatory)] [string] $Tag,
    [string] $OutputDirectory,
    [string] $SigningDirectory = (Join-Path $env:LOCALAPPDATA 'Nexus Release Signing'),
    [string] $TauriCli,
    [string] $GitHubCli = 'gh',
    [switch] $PrepareOnly,
    [switch] $Publish
)

$ErrorActionPreference = 'Stop'
if ($PrepareOnly -and $Publish) { throw 'Choose either -PrepareOnly or -Publish.' }
if ($Tag -notmatch '^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$') {
    throw 'Use a stable tag such as v0.10.45.'
}
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$helper = Join-Path $PSScriptRoot 'prepare-release.mjs'
$version = $Tag.Substring(1)
$target = 'x86_64-pc-windows-msvc'
if (!$OutputDirectory) { $OutputDirectory = Join-Path $root "dist/release-$Tag" }
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
$overlay = Join-Path $output 'updater-overlay.json'
$publicKey = Join-Path $SigningDirectory 'nexus-assets.key.pub'
$privateKey = Join-Path $SigningDirectory 'nexus-assets.key'
$password = Join-Path $SigningDirectory 'nexus-assets.pass'

$previousEnvironment = @{}
foreach ($name in @('GITHUB_REPOSITORY', 'GITHUB_REF_NAME', 'NEXUS_UPDATER_PUBLIC_KEY',
                    'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD')) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

Push-Location -LiteralPath $root
try {
    $env:GITHUB_REPOSITORY = $Repository
    $env:GITHUB_REF_NAME = $Tag
    $env:NEXUS_UPDATER_PUBLIC_KEY = [System.IO.File]::ReadAllText($publicKey).Trim()
    & node $helper config $overlay
    if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the release updater configuration.' }
    if ($PrepareOnly) {
        Write-Output "Updater configuration: $overlay"
        return
    }

    $cli = if ($TauriCli) { (Get-Command $TauriCli -ErrorAction Stop).Source } else { 'cargo' }
    $cliVersion = (& $cli tauri --version) -join ' '
    if ($LASTEXITCODE -ne 0 -or $cliVersion -notmatch '\b(2\.\d+\.\d+)\b' -or
            [version]$Matches[1] -lt [version]'2.12.6') {
        throw 'Install Tauri CLI 2.12.6 or newer and retry.'
    }
    $metadata = & cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1 --no-deps --locked
    if ($LASTEXITCODE -ne 0) { throw 'Cargo could not resolve the locked release source.' }
    $targetDirectory = ($metadata | ConvertFrom-Json).target_directory
    $config = Get-Content -LiteralPath 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json
    $bundles = Join-Path $targetDirectory "$target/release/bundle/nsis"
    $bundle = Join-Path $bundles "$($config.productName)_${version}_x64-setup.exe"
    if (!(Test-Path -LiteralPath $privateKey -PathType Leaf)) { throw 'The local Tauri signing key is missing.' }

    try {
        $env:TAURI_SIGNING_PRIVATE_KEY = [System.IO.Path]::GetFullPath($privateKey)
        $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = if (Test-Path -LiteralPath $password -PathType Leaf) {
            [System.IO.File]::ReadAllText($password).TrimEnd("`r", "`n")
        } else { '' }
        & $cli tauri build --config $overlay --target $target --bundles nsis --ci -- --locked
        if ($LASTEXITCODE -ne 0) { throw 'The signed Windows installer build failed.' }
    } finally {
        [Environment]::SetEnvironmentVariable('TAURI_SIGNING_PRIVATE_KEY', $previousEnvironment['TAURI_SIGNING_PRIVATE_KEY'], 'Process')
        [Environment]::SetEnvironmentVariable('TAURI_SIGNING_PRIVATE_KEY_PASSWORD', $previousEnvironment['TAURI_SIGNING_PRIVATE_KEY_PASSWORD'], 'Process')
    }

    $installerName = "nexus-assets-${version}-windows-x64-setup.exe"
    $installer = Join-Path $output $installerName
    $latest = Join-Path $output 'latest.json'
    Copy-Item -LiteralPath $bundle -Destination $installer -Force
    Copy-Item -LiteralPath "$bundle.sig" -Destination "$installer.sig" -Force
    $platform = @{
        signature = [System.IO.File]::ReadAllText("$installer.sig").Trim()
        url = "https://github.com/$Repository/releases/download/$Tag/$installerName"
    }
    $manifest = @{
        version = $version
        notes = "Nexus Assets $Tag"
        pub_date = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
        platforms = @{'windows-x86_64' = $platform; 'windows-x86_64-nsis' = $platform}
    }
    [System.IO.File]::WriteAllText($latest, (ConvertTo-Json -InputObject $manifest -Depth 4) + "`n")
    & node $helper verify $latest
    if ($LASTEXITCODE -ne 0) { throw 'The local update manifest did not pass verification.' }
    $releaseFiles = @($installer, "$installer.sig", $latest)
    $releaseFiles | Write-Output
    if (!$Publish) { return }

    $gh = (Get-Command $GitHubCli -ErrorAction Stop).Source
    $repositoryInfo = & $gh repo view $Repository --json visibility | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $repositoryInfo.visibility -ne 'PUBLIC') {
        throw 'The updater requires an accessible public GitHub repository.'
    }
    $draftJson = & $gh release view $Tag --repo $Repository --json isDraft 2>$null
    if ($LASTEXITCODE -eq 0) {
        if (!(($draftJson | ConvertFrom-Json).isDraft)) { throw 'This tag already has a published release.' }
    } else {
        & $gh release create $Tag --repo $Repository --verify-tag --draft --title "Nexus Assets $Tag" --generate-notes
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the GitHub release draft. Push the release tag first.' }
    }
    & $gh release upload $Tag @releaseFiles --repo $Repository --clobber
    if ($LASTEXITCODE -ne 0) { throw 'The release assets could not be uploaded.' }
    $draft = & $gh release view $Tag --repo $Repository --json isDraft,assets | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or !$draft.isDraft) { throw 'Could not verify the GitHub release draft.' }
    foreach ($file in $releaseFiles) {
        $local = Get-Item -LiteralPath $file
        $asset = $draft.assets | Where-Object { $_.name -eq $local.Name }
        if (!$asset -or $asset.size -ne $local.Length) { throw "The uploaded asset did not match $($local.Name)." }
        if ($asset.digest -and $asset.digest -ne "sha256:$((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash)") {
            throw "The uploaded checksum did not match $($local.Name)."
        }
    }
    & $gh release edit $Tag --repo $Repository --draft=false --latest
    if ($LASTEXITCODE -ne 0) { throw 'The release draft was saved but could not be published.' }
} finally {
    foreach ($name in $previousEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
    }
    Pop-Location
}
