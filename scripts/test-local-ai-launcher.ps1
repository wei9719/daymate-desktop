#requires -Version 5.1
# Pure launcher regression checks. Never execute its entry point or touch a process.
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$launcher = Join-Path $PSScriptRoot 'local-ai.ps1'
$ast = [Management.Automation.Language.Parser]::ParseFile($launcher, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$names = @('Get-LauncherMutexName', 'Get-StateStartTicks', 'Test-OwnedCommandLine', 'Write-StateAtomically')
foreach ($name in $names) {
  $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  if (-not $definition) { throw "Missing tested helper: $name" }
  Invoke-Expression $definition.Extent.Text
}
$script:checks = 0
function Assert-Check {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
  $script:checks++
}

$iso = '2026-09-20T10:30:01.1234567Z'
$expected = ([DateTimeOffset]::Parse($iso)).UtcDateTime.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
Assert-Check ((Get-StateStartTicks @{startedAtUtcTicks=$expected}) -eq $expected) 'New tick-string identity changed.'
Assert-Check ((Get-StateStartTicks @{startedAtUtc=$iso}) -eq $expected) 'Legacy ISO string identity changed.'
$restored = '{"startedAtUtc":"2026-09-20T10:30:01.1234567Z"}' | ConvertFrom-Json
Assert-Check ((Get-StateStartTicks $restored) -eq $expected) 'JSON-restored DateTime identity changed.'
Assert-Check ((Get-StateStartTicks @{startedAtUtc=[DateTimeOffset]::Parse($iso).UtcDateTime}) -eq $expected) 'Explicit DateTime identity changed.'
Assert-Check ((Get-StateStartTicks @{startedAtUtc='2026-09-20T18:30:01.1234567+08:00'}) -eq $expected) 'Time zone conversion changed identity.'
foreach ($invalid in @(@{}, @{startedAtUtc='invalid'}, @{startedAtUtcTicks='-1'}, @{startedAtUtcTicks='9999999999999999999'})) {
  Assert-Check ($null -eq (Get-StateStartTicks $invalid)) 'Invalid process identity was accepted.'
}

$project = Split-Path -Parent $PSScriptRoot
$cache = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $project) '.cache'))
$root = Join-Path $cache ('local-ai-launcher-test-' + [guid]::NewGuid().ToString('N'))
if (-not $root.StartsWith($cache + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test directory.' }
$label = [string][char]0x65E5 + [char]0x4F34
$directory = Join-Path $root "$label runtime"
$command = '"X:\Python Space\python.exe" -B -m local_ai.server --model-path "X:\models" --runtime-dir "{0}" --port 8765' -f $directory
Assert-Check (Test-OwnedCommandLine $command $directory) 'Quoted Unicode/space runtime was not recognized.'
Assert-Check (Test-OwnedCommandLine $command ($directory.ToLowerInvariant() + '\')) 'Runtime normalization differs by case/trailing slash.'
Assert-Check (-not (Test-OwnedCommandLine ($command.Replace($directory, "$directory-other")) $directory)) 'Runtime prefix was accepted as an exact match.'
Assert-Check (-not (Test-OwnedCommandLine ($command.Replace('X:\models', $directory).Replace('--runtime-dir "' + $directory + '"', '--runtime-dir "X:\different"')) $directory)) 'A matching model path was mistaken for runtime ownership.'
Assert-Check (-not (Test-OwnedCommandLine ($command.Replace('-m local_ai.server', '-m unrelated.server')) $directory)) 'Unrelated Python module was accepted.'
Assert-Check (-not (Test-OwnedCommandLine ($command + ' --runtime-dir "' + $directory + '"') $directory)) 'Duplicate runtime arguments were accepted.'
Assert-Check ((Get-LauncherMutexName $directory) -eq (Get-LauncherMutexName ($directory.ToLowerInvariant() + '\'))) 'Canonical runtime did not share a launcher lock.'
Assert-Check ((Get-LauncherMutexName $directory) -ne (Get-LauncherMutexName "$directory-other")) 'Different runtimes share a launcher lock.'

# A second runspace is a different thread, not a child process or model service.
$mutexName = Get-LauncherMutexName $directory
$mutex = New-Object Threading.Mutex($false, $mutexName)
$held = $false
$contender = [PowerShell]::Create()
try {
  $held = $mutex.WaitOne(0)
  Assert-Check $held 'Could not acquire the isolated launcher mutex.'
  $null = $contender.AddScript('param($name) $m = New-Object Threading.Mutex($false, $name); $locked = $false; try { $locked = $m.WaitOne(0); return $locked } finally { if ($locked) { $m.ReleaseMutex() }; $m.Dispose() }').AddArgument($mutexName)
  $result = $contender.Invoke()
  Assert-Check (-not $contender.HadErrors -and $result.Count -eq 1 -and $result[0] -eq $false) 'Concurrent launcher operation was not excluded.'
} finally {
  $contender.Dispose()
  if ($held) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}

New-Item -ItemType Directory -Path $root | Out-Null
$state = Join-Path $root 'process.json'
try {
  Write-StateAtomically $state @{pid=123;startedAtUtcTicks=$expected;python='fixture.exe';port=8765}
  $first = Get-Content -LiteralPath $state -Raw | ConvertFrom-Json
  Assert-Check ($first.pid -eq 123 -and (Get-StateStartTicks $first) -eq $expected) 'Initial state write was not intact.'
  Write-StateAtomically $state @{pid=456;startedAtUtcTicks=$expected;python='fixture.exe';port=8765}
  Assert-Check ((Get-Content -LiteralPath $state -Raw | ConvertFrom-Json).pid -eq 456) 'Atomic replacement did not preserve complete new state.'
  Assert-Check (@(Get-ChildItem -LiteralPath $root -Filter '*.tmp').Count -eq 0) 'Temporary state files remained.'
  $failed = $false
  try { Write-StateAtomically (Join-Path $root 'missing\process.json') @{pid=789} } catch { $failed = $true }
  Assert-Check $failed 'A failed state write was incorrectly reported as success.'
  Assert-Check ((Get-Content -LiteralPath $state -Raw | ConvertFrom-Json).pid -eq 456) 'Failed state write changed the prior record.'
} finally {
  # Only the known file and this unique empty test directory; no recursive deletion.
  if (Test-Path -LiteralPath $state -PathType Leaf) { Remove-Item -LiteralPath $state }
  Remove-Item -LiteralPath $root
}
Write-Output "PASS: $script:checks launcher helper checks; no service/GPU/process was started or stopped."
