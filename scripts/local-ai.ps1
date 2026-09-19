#requires -Version 5.1
param(
  [ValidateSet('start', 'status', 'stop')][string]$Action = 'status',
  [string]$PythonPath,
  [string]$ModelPath,
  [string]$RuntimeDir,
  [ValidateRange(1024, 65535)][int]$Port = 8765
)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
if (-not $RuntimeDir) { $RuntimeDir = Join-Path (Split-Path -Parent $project) 'runtime\local-ai' }
$RuntimeDir = [IO.Path]::GetFullPath($RuntimeDir).TrimEnd('\', '/')
$statePath = Join-Path $RuntimeDir 'process.json'

function Get-LauncherMutexName {
  param([string]$Directory)
  $canonical = [IO.Path]::GetFullPath($Directory).TrimEnd('\', '/').ToUpperInvariant()
  $hash = [Security.Cryptography.SHA256]::Create()
  try { $digest = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical))).Replace('-', '') }
  finally { $hash.Dispose() }
  return "Local\DayMateLauncher_$digest"
}

function Get-StateStartTicks {
  param($State)
  try {
    if ($State.startedAtUtcTicks) {
      $value = [string]$State.startedAtUtcTicks
      if ($value -notmatch '^[0-9]{1,19}$') { return $null }
      $ticks = [long]$value
      if ($ticks -le 0 -or $ticks -gt [DateTime]::MaxValue.Ticks) { return $null }
      return $ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
    }
    # Recent PowerShell versions restore JSON ISO dates as DateTime, not strings.
    if ($State.startedAtUtc -is [DateTime]) {
      return $State.startedAtUtc.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
    }
    if ($State.startedAtUtc -is [string] -and $State.startedAtUtc) {
      $date = [DateTimeOffset]::Parse($State.startedAtUtc, [Globalization.CultureInfo]::InvariantCulture)
      return $date.UtcDateTime.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
    }
  } catch { return $null }
  return $null
}

function Test-OwnedCommandLine {
  param([string]$CommandLine, [string]$Directory)
  if ($CommandLine -notmatch '^\s*(?:"[^"]+"|\S+)\s+(?:-B\s+)?-m\s+local_ai\.server(?:\s|$)') { return $false }
  $arguments = [regex]::Matches($CommandLine, '(?:^|\s)--runtime-dir\s+(?:"([^"]+)"|([^\s"]+))(?=\s|$)')
  if ($arguments.Count -ne 1) { return $false }
  $value = if ($arguments[0].Groups[1].Success) { $arguments[0].Groups[1].Value } else { $arguments[0].Groups[2].Value }
  try {
    $actual = [IO.Path]::GetFullPath($value).TrimEnd('\', '/')
    $expected = [IO.Path]::GetFullPath($Directory).TrimEnd('\', '/')
    return [string]::Equals($actual, $expected, [StringComparison]::OrdinalIgnoreCase)
  } catch { return $false }
}

function Write-StateAtomically {
  param([string]$Path, $Record)
  $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    [IO.File]::WriteAllText($temporary, ($Record | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) }
    else { [IO.File]::Move($temporary, $Path) }
  } finally {
    if ([IO.File]::Exists($temporary)) { Remove-Item -LiteralPath $temporary -ErrorAction Stop }
  }
}

function Read-Status {
  param([int]$TargetPort)
  # A per-client proxy override; never alter the user's system proxy.
  Add-Type -AssemblyName System.Net.Http
  $handler = New-Object Net.Http.HttpClientHandler
  $handler.UseProxy = $false
  $client = New-Object Net.Http.HttpClient($handler)
  $client.Timeout = [TimeSpan]::FromSeconds(3)
  $client.MaxResponseContentBufferSize = 65536
  $client.DefaultRequestHeaders.Add('X-DayMate-Local', '1')
  try {
    $body = $client.GetStringAsync("http://127.0.0.1:$TargetPort/v1/health").GetAwaiter().GetResult()
    $status = $body | ConvertFrom-Json
    if ($status.state -notin @('loading', 'ready', 'busy', 'error') -or $status.model -ne 'Qwen2.5-1.5B-Instruct') { throw 'Unexpected local service.' }
    return $status
  } finally { $client.Dispose(); $handler.Dispose() }
}

function Owned-Process {
  param($State)
  $ticks = Get-StateStartTicks $State
  if (-not $State -or $State.pid -le 0 -or -not $ticks -or -not $State.python) { return $null }
  $process = $null
  try {
    $process = Get-Process -Id $State.pid -ErrorAction SilentlyContinue
    if (-not $process) { return $null }
    # Retain a handle before identity checks; never later terminate by PID.
    $null = $process.Handle
    if ($process.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) -ne $ticks) { throw 'Identity changed.' }
    $details = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)"
    if (-not $details -or $details.ExecutablePath -ine $State.python -or $process.HasExited) { throw 'Identity changed.' }
    if (-not (Test-OwnedCommandLine $details.CommandLine $RuntimeDir)) { throw 'Runtime does not match.' }
    return $process
  } catch {
    if ($process) { $process.Dispose() }
    return $null
  }
}

function Stop-OwnedProcessTree {
  param([System.Diagnostics.Process]$RootProcess)
  $null = $RootProcess.Handle
  $owned = [Collections.Generic.List[object]]::new()
  $owned.Add(@{process=$RootProcess; ticks=$RootProcess.StartTime.ToUniversalTime().Ticks; depth=0})
  try {
    # venv python.exe may be a redirector: verified descendants own the GPU.
    for ($index = 0; $index -lt $owned.Count; $index++) {
      $parent = $owned[$index]
      if ($parent.process.HasExited) { continue }
      $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($parent.process.Id)")
      foreach ($details in $children) {
        $child = $null
        try {
          $child = Get-Process -Id $details.ProcessId -ErrorAction Stop
          $null = $child.Handle
          $ticks = $child.StartTime.ToUniversalTime().Ticks
          $fresh = Get-CimInstance Win32_Process -Filter "ProcessId = $($child.Id)"
          if ($child.HasExited -or $parent.process.HasExited -or -not $fresh -or $fresh.ParentProcessId -ne $parent.process.Id -or $ticks -lt $parent.ticks) { throw 'Descendant identity changed.' }
          if ($owned | Where-Object { $_.process.Id -eq $child.Id }) { throw 'Duplicate process.' }
          $owned.Add(@{process=$child; ticks=$ticks; depth=($parent.depth + 1)})
          $child = $null
        } catch {
          if ($child) { $child.Dispose() }
          # Do not kill the parent and orphan a live descendant we could not verify.
          $remaining = Get-CimInstance Win32_Process -Filter "ProcessId = $($details.ProcessId)"
          if ($remaining -and $remaining.ParentProcessId -eq $parent.process.Id -and -not $parent.process.HasExited) { throw 'Could not safely verify a live service descendant. No termination has started.' }
        }
      }
    }
    foreach ($entry in ($owned | Sort-Object { $_.depth } -Descending)) {
      if (-not $entry.process.HasExited) {
        if ($entry.process.StartTime.ToUniversalTime().Ticks -ne $entry.ticks) { throw 'Refusing to stop a changed process identity.' }
        try { $entry.process.Kill() }
        catch { if (-not $entry.process.HasExited) { throw } }
      }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    foreach ($entry in $owned) {
      $remaining = [Math]::Max(0, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds)
      if (-not $entry.process.WaitForExit($remaining)) { throw 'An owned service process did not exit within 10 seconds.' }
    }
  } finally {
    foreach ($entry in $owned) { if ($entry.depth -gt 0) { $entry.process.Dispose() } }
  }
}

$mutex = New-Object Threading.Mutex($false, (Get-LauncherMutexName $RuntimeDir))
$locked = $false
try {
  try { $locked = $mutex.WaitOne([TimeSpan]::FromSeconds(10)) }
  catch [Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { throw 'Another launcher operation is in progress. Retry shortly.' }
  $state = $null
  if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($state.port -ge 1024 -and $state.port -le 65535) { $Port = [int]$state.port }
  }
  if ($Action -eq 'status') {
    try { Read-Status $Port | ConvertTo-Json }
    catch { Write-Output 'Local model service is not reachable; start it first or inspect its fixed-status logs.'; exit 1 }
    exit 0
  }
  if ($Action -eq 'stop') {
    $owned = Owned-Process $state
    if (-not $owned) { throw 'No matching owned service process. No process was stopped.' }
    try { Stop-OwnedProcessTree $owned } finally { $owned.Dispose() }
    Remove-Item -LiteralPath $statePath
    Write-Output 'Stopped the verified DayMate local service and its confirmed descendants; no unrelated process was stopped.'
    exit 0
  }
  $existing = Owned-Process $state
  if ($existing) {
    try { Read-Status $Port | ConvertTo-Json } finally { $existing.Dispose() }
    Write-Output 'The owned service is already running; no second model was loaded.'
    exit 0
  }
  if (-not $PythonPath -or -not $ModelPath) { throw 'start requires -PythonPath and -ModelPath. Nothing will be downloaded.' }
  $PythonPath = (Get-Item -LiteralPath $PythonPath -ErrorAction Stop).FullName
  $ModelPath = (Get-Item -LiteralPath $ModelPath -ErrorAction Stop).FullName
  if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf) -or [IO.Path]::GetExtension($PythonPath) -ine '.exe') { throw 'Use an existing Python .exe, not a shell shim or batch file.' }
  if (-not (Test-Path -LiteralPath (Join-Path $ModelPath 'config.json') -PathType Leaf)) { throw 'Model config.json is missing.' }
  if ($PythonPath.Contains('"') -or $ModelPath.Contains('"') -or $RuntimeDir.Contains('"')) { throw 'Quotes are not permitted in runtime paths.' }
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw 'The port is already in use; no process was stopped or model loaded.' }
  New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
  $tempDir = Join-Path $RuntimeDir 'tmp'
  New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
  $stdout = Join-Path $RuntimeDir 'service.stdout.log'
  $stderr = Join-Path $RuntimeDir 'service.stderr.log'
  $old = @{}
  $environment = @{PYTHONDONTWRITEBYTECODE='1';TEMP=$tempDir;TMP=$tempDir;HF_HUB_OFFLINE='1';TRANSFORMERS_OFFLINE='1';HF_HUB_DISABLE_TELEMETRY='1'}
  foreach ($name in $environment.Keys) { $old[$name] = [Environment]::GetEnvironmentVariable($name, 'Process'); [Environment]::SetEnvironmentVariable($name, $environment[$name], 'Process') }
  $process = $null
  $recorded = $false
  try {
    $arguments = '-B -m local_ai.server --model-path "{0}" --runtime-dir "{1}" --port {2}' -f $ModelPath.TrimEnd('\'), $RuntimeDir.TrimEnd('\'), $Port
    $process = Start-Process -FilePath $PythonPath -ArgumentList $arguments -WorkingDirectory $project -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $null = $process.Handle
    $record = @{pid=$process.Id;startedAtUtcTicks=$process.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture);python=$PythonPath;port=$Port}
    Write-StateAtomically $statePath $record
    $recorded = $true
    for ($i=0; $i -lt 12; $i++) {
      if ($process.HasExited) { throw 'The local service exited during startup. Check the local status logs.' }
      try { Read-Status $Port | ConvertTo-Json; Write-Output 'Service started. Model loading continues in the background; check status before generating.'; exit 0 }
      catch { Start-Sleep -Milliseconds 250 }
    }
    Write-Output 'Service process started; initialization is still in progress. Use -Action status shortly.'
  } catch {
    # Roll back only the child handle this invocation created, never a name/PID.
    if ($process -and -not $process.HasExited) { Stop-OwnedProcessTree $process }
    if ($recorded -and (Test-Path -LiteralPath $statePath -PathType Leaf)) { Remove-Item -LiteralPath $statePath }
    throw
  } finally {
    if ($process) { $process.Dispose() }
    foreach ($name in $old.Keys) { [Environment]::SetEnvironmentVariable($name, $old[$name], 'Process') }
  }
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
