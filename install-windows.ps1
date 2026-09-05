[CmdletBinding()]
param(
    [switch]$Plan,
    [switch]$Yes,
    [string]$Distribution = "Ubuntu-24.04",
    [string]$Ref = "main"
)

$ErrorActionPreference = "Stop"

function Stop-Install([string]$Message, [int]$Code = 2) {
    Write-Error $Message
    exit $Code
}

if (-not $IsWindows -and $PSVersionTable.PSEdition -eq "Core") {
    Stop-Install "Windows is required."
}
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    Stop-Install "Windows is required."
}

$build = [Environment]::OSVersion.Version.Build
if ($build -lt 19041) {
    Stop-Install "Windows 10 build 19041 or Windows 11 is required (detected build $build)."
}
Write-Host "PASS supported Windows build $build"

if (-not [Environment]::Is64BitOperatingSystem) {
    Stop-Install "A 64-bit Windows installation is required."
}
Write-Host "PASS 64-bit Windows"

$memoryGb = [math]::Floor((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
if ($memoryGb -lt 4) {
    Stop-Install "At least 4 GB RAM is required ($memoryGb GB detected)."
}
Write-Host "PASS memory ${memoryGb}GB"

$wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
if ($wsl) {
    Write-Host "PASS WSL command available"
} else {
    Write-Host "NOTE WSL2 and $Distribution will be installed"
}

if ($Plan) {
    Write-Host "PLAN install Area51 in WSL2 distribution $Distribution from $Ref"
    Write-Host "PLAN runtime Docker; isolation local; Incus VM isolation requires a Linux host"
    exit 0
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Stop-Install "Run this command from PowerShell as Administrator."
}

if (-not $Yes) {
    $answer = Read-Host "Install WSL2, $Distribution, Docker, and Area51? [y/N]"
    if ($answer -notmatch '^[Yy]') {
        Write-Host "Cancelled."
        exit 1
    }
}

$wslReady = $false
if ($wsl) {
    & wsl.exe --status *> $null
    $wslReady = $LASTEXITCODE -eq 0
}

if (-not $wslReady) {
    & wsl.exe --install -d $Distribution --no-launch
    if ($LASTEXITCODE -ne 0) {
        Stop-Install "WSL installation failed."
    }
    Write-Host "WSL was installed. Restart Windows, initialize $Distribution, then run this same command again."
    exit 3010
}

& wsl.exe --set-default-version 2
if ($LASTEXITCODE -ne 0) {
    Stop-Install "Could not set WSL2 as the default. Run 'wsl --update' and try again."
}

$installed = @(& wsl.exe --list --quiet 2>$null | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($installed -notcontains $Distribution) {
    & wsl.exe --install -d $Distribution --no-launch
    if ($LASTEXITCODE -ne 0) {
        Stop-Install "Could not install WSL distribution $Distribution."
    }
    Write-Host "$Distribution was installed. Launch it once to create your Linux user, then run this same command again."
    exit 3010
}

& wsl.exe --set-version $Distribution 2
if ($LASTEXITCODE -ne 0) {
    Stop-Install "Could not configure $Distribution as WSL2."
}

$linuxUid = (& wsl.exe -d $Distribution -- id -u 2>$null | Out-String).Trim()
if (-not $linuxUid -or $linuxUid -eq "0") {
    Stop-Install "Launch $Distribution once, create a regular Linux user, make it the default, and rerun this command."
}
Write-Host "PASS regular WSL user"

if ($Ref -notmatch '^[A-Za-z0-9._/-]+$') {
    Stop-Install "Ref contains unsupported characters."
}
$url = "https://raw.githubusercontent.com/aviatam/area51/$Ref/install-wsl.sh"
$yesArg = if ($Yes) { " --yes" } else { "" }
$installCommand = "curl -fsSL '$url' | bash -s -- --ref '$Ref'$yesArg"

& wsl.exe -d $Distribution -- bash -lc $installCommand
$installExit = $LASTEXITCODE
if ($installExit -eq 3) {
    Write-Host "Restarting $Distribution once to activate systemd..."
    & wsl.exe --terminate $Distribution
    if ($LASTEXITCODE -ne 0) {
        Stop-Install "Could not restart $Distribution after enabling systemd."
    }
    & wsl.exe -d $Distribution -- bash -lc $installCommand
    $installExit = $LASTEXITCODE
}
if ($installExit -ne 0) {
    Stop-Install "Area51 installation inside WSL2 failed." $installExit
}

Write-Host "Area51 Windows/WSL2 deployment complete."
Write-Host "Open it with: wsl -d $Distribution"
Write-Host "Runtime: Docker in WSL2; production Incus/KVM isolation remains Linux-host only."
