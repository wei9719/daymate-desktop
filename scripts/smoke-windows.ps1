#requires -Version 7.0
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [ValidateSet('fresh', 'legacy-v4')]
  [string]$DataScenario = 'fresh'
)

$ErrorActionPreference = 'Stop'

# Never install or launch a test copy on a developer's computer or a self-hosted runner.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'This installation smoke test only runs on GitHub-hosted Windows runners.'
}
if (-not $env:RUNNER_TEMP -or -not [System.IO.Path]::IsPathFullyQualified($env:RUNNER_TEMP)) {
  throw 'RUNNER_TEMP must be an absolute path.'
}

$installer = (Get-Item -LiteralPath $InstallerPath -ErrorAction Stop).FullName
$runnerTemp = [System.IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\', '/')
$smokeRoot = Join-Path $runnerTemp ('daymate-smoke-' + [guid]::NewGuid().ToString('N'))
if (-not $smokeRoot.StartsWith($runnerTemp + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'The smoke test directory must be inside RUNNER_TEMP.'
}
if (Get-Process -Name 'daymate-desktop' -ErrorAction SilentlyContinue) {
  throw 'An existing DayMate process would interfere with the isolated test; it will not be stopped.'
}

$installRoot = Join-Path $smokeRoot '日伴 安装'
$dataRoot = Join-Path $smokeRoot '用户 数据'
$database = Join-Path $dataRoot 'daymate.sqlite3'
$executable = Join-Path $installRoot 'daymate-desktop.exe'
New-Item -ItemType Directory -Path $smokeRoot, $dataRoot | Out-Null
if ($DataScenario -eq 'legacy-v4') {
  python (Join-Path $PSScriptRoot 'smoke-fixture.py') create $database
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the synthetic v4 database fixture.' }
}
$ownedProcesses = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$previousDataDir = $env:DAYMATE_DATA_DIR
$previousWebViewDataDir = $env:WEBVIEW2_USER_DATA_FOLDER

function Wait-TestProcessExit {
  param([System.Diagnostics.Process]$Process, [int]$TimeoutSeconds, [string]$Label)
  $elapsed = [System.Diagnostics.Stopwatch]::StartNew()
  while (-not $Process.WaitForExit(500)) {
    if ($elapsed.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
      throw "$Label did not exit within $TimeoutSeconds seconds."
    }
  }
  if ($Process.ExitCode -ne 0) {
    throw "$Label exited with code $($Process.ExitCode)."
  }
}

function Assert-TestProcessAlive {
  param([System.Diagnostics.Process]$Process)
  $Process.Refresh()
  if ($Process.HasExited) {
    throw "The installed DayMate process exited unexpectedly with code $($Process.ExitCode)."
  }
}

try {
  $env:DAYMATE_DATA_DIR = $dataRoot
  $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $smokeRoot 'webview'

  # NSIS requires /D to be the final argument without quotes, including paths with spaces.
  # /NS avoids creating runner desktop shortcuts; omitting /R prevents installer auto-launch.
  $installProcess = Start-Process -FilePath $installer -ArgumentList "/S /NS /D=$installRoot" -PassThru -WindowStyle Hidden
  $ownedProcesses.Add($installProcess)
  $null = $installProcess.Handle
  Wait-TestProcessExit -Process $installProcess -TimeoutSeconds 180 -Label 'NSIS installer'
  if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw 'The installer did not create daymate-desktop.exe in the requested directory.'
  }
  Write-Output 'PASS: NSIS installation completed in an isolated runner directory.'

  $first = Start-Process -FilePath $executable -WorkingDirectory $installRoot -PassThru -WindowStyle Hidden
  $ownedProcesses.Add($first)
  $null = $first.Handle
  $startup = [System.Diagnostics.Stopwatch]::StartNew()
  while (-not (Test-Path -LiteralPath $database -PathType Leaf) -or (Get-Item -LiteralPath $database).Length -lt 16) {
    Assert-TestProcessAlive -Process $first
    if ($startup.Elapsed.TotalSeconds -ge 60) {
      throw 'The installed app did not initialize its isolated SQLite database within 60 seconds.'
    }
    Start-Sleep -Milliseconds 500
  }
  $stream = [System.IO.File]::Open($database, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  try {
    $header = [byte[]]::new(16)
    if ($stream.Read($header, 0, 16) -ne 16 -or [System.Text.Encoding]::ASCII.GetString($header) -cne "SQLite format 3`0") {
      throw 'The generated database does not have a valid SQLite header.'
    }
  } finally { $stream.Dispose() }
  foreach ($second in 1..10) {
    Start-Sleep -Seconds 1
    Assert-TestProcessAlive -Process $first
  }
  Write-Output 'PASS: the installed app initialized SQLite and remained alive for 10 seconds.'

  $duplicate = Start-Process -FilePath $executable -WorkingDirectory $installRoot -PassThru -WindowStyle Hidden
  $ownedProcesses.Add($duplicate)
  $null = $duplicate.Handle
  Wait-TestProcessExit -Process $duplicate -TimeoutSeconds 15 -Label 'Second DayMate launch'
  foreach ($second in 1..5) {
    Start-Sleep -Seconds 1
    Assert-TestProcessAlive -Process $first
  }
  Write-Output 'PASS: a second launch exited successfully while the original process stayed alive.'
  if ($DataScenario -eq 'legacy-v4') {
    python (Join-Path $PSScriptRoot 'smoke-fixture.py') verify $database
    if ($LASTEXITCODE -ne 0) { throw 'The synthetic v4 data was not preserved during migration.' }
  }
  Write-Output 'Smoke test passed. UI rendering, notifications, autostart and reboot behavior are outside this test.'
} finally {
  # Keep process handles rather than matching names, so unrelated runner processes cannot be stopped.
  foreach ($ownedProcess in $ownedProcesses) {
    try {
      if (-not $ownedProcess.HasExited) {
        $ownedProcess.Kill($true)
        [void]$ownedProcess.WaitForExit(5000)
      }
    } catch {
      Write-Warning "Could not stop a test-owned process: $($_.Exception.Message)"
    } finally { $ownedProcess.Dispose() }
  }
  $env:DAYMATE_DATA_DIR = $previousDataDir
  $env:WEBVIEW2_USER_DATA_FOLDER = $previousWebViewDataDir
}
