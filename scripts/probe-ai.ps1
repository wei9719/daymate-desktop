# Explicit, bounded cloud diagnostics. Never launches DayMate or opens its database.
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('siliconflow', 'sensenova')]
    [string]$Provider,
    [ValidateSet('models', 'text')]
    [string]$Operation = 'models',
    [string]$Model = ''
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This diagnostic reads Windows Credential Manager.' }
if ($Operation -eq 'text' -and ($Model.Length -eq 0 -or $Model.Length -gt 200 -or $Model -match '[\x00-\x1f\x7f]')) {
    throw 'An explicit model identifier is required for the one-request text test.'
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DayMateProbeCredential {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential {
        public uint Flags, Type;
        public string TargetName, Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist, AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias, UserName;
    }
    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr pointer);
    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr pointer);
    public static byte[] Read(string provider) {
        IntPtr pointer;
        if (!CredRead(provider + ".com.daymate.desktop.ai", 1, 0, out pointer))
            throw new InvalidOperationException("No readable DayMate credential for this provider.");
        try {
            var credential = Marshal.PtrToStructure<Credential>(pointer);
            if (credential.CredentialBlobSize > 2560)
                throw new InvalidOperationException("Invalid credential size.");
            var bytes = new byte[credential.CredentialBlobSize];
            Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
            return bytes;
        } finally { CredFree(pointer); }
    }
}
'@

$base = if ($Provider -eq 'siliconflow') { 'https://api.siliconflow.cn/v1' } else { 'https://token.sensenova.cn/v1' }
$bytes = $null
$key = $null
$record = $null
$client = $null
$request = $null
$response = $null
$phase = 'credential'
try {
    $bytes = [DayMateProbeCredential]::Read($Provider)
    $encoded = [Text.Encoding]::UTF8.GetString($bytes)
    if ($encoded.StartsWith('DayMateAIKey:')) {
        $prefix = "DayMateAIKey:v1`n"
        if (-not $encoded.StartsWith($prefix)) { throw 'Unsupported credential version.' }
        $record = $encoded.Substring($prefix.Length) | ConvertFrom-Json
        if ($record.provider -cne $Provider -or $record.endpoint -cne "$base/chat/completions") {
            throw 'Credential destination mismatch; no network request was sent.'
        }
        $key = $record.key
    } else {
        # Legacy keyring passwords are UTF-16 and may only target official endpoints.
        $key = [Text.Encoding]::Unicode.GetString($bytes)
    }
    if ($key -notmatch '^[\x21-\x7e]{1,2048}$') { throw 'Invalid saved credential.' }
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.UseCookies = $false
    $client = [Net.Http.HttpClient]::new($handler)
    $senseReasoning = $Provider -eq 'sensenova' -and $Model -eq 'sensenova-6.8-flash-lite'
    $timeoutSeconds = if ($senseReasoning) { 60 } else { 30 }
    $client.Timeout = [TimeSpan]::FromSeconds($timeoutSeconds)
    $url = if ($Operation -eq 'models') {
        if ($Provider -eq 'siliconflow') { "$base/models?sub_type=chat" } else { "$base/models" }
    } else { "$base/chat/completions" }
    $method = if ($Operation -eq 'models') { [Net.Http.HttpMethod]::Get } else { [Net.Http.HttpMethod]::Post }
    $request = [Net.Http.HttpRequestMessage]::new($method, $url)
    $request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $key)
    if ($Operation -eq 'text') {
        $body = @{
            model = $Model
            messages = @(@{ role = 'user'; content = '只回复一句不超过20字的原创中文鼓励，不引用名人，不要解释。' })
            max_tokens = 128
            temperature = 0.2
        }
        if ($senseReasoning) { $body.max_tokens = 2000 }
        if ($Provider -eq 'siliconflow' -and $Model -in @('Qwen/Qwen3-8B', 'Qwen/Qwen3-14B', 'Qwen/Qwen3-32B', 'Qwen/Qwen3-235B-A22B')) { $body.enable_thinking = $false }
        $request.Content = [Net.Http.StringContent]::new(($body | ConvertTo-Json -Depth 5 -Compress), [Text.Encoding]::UTF8, 'application/json')
    }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $phase = 'connect'
    # Exactly one attempt; do not repeat potentially billable generations.
    $response = $client.SendAsync($request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    $status = [int]$response.StatusCode
    if (-not $response.IsSuccessStatusCode) {
        [pscustomobject]@{ provider = $Provider; operation = $Operation; status = $status; success = $false } | ConvertTo-Json -Compress
        exit 1
    }
    $phase = 'read-response'
    $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $memory = [IO.MemoryStream]::new()
    $buffer = [byte[]]::new(8192)
    $deadline = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($timeoutSeconds))
    try {
        while (($count = $stream.ReadAsync($buffer, 0, $buffer.Length, $deadline.Token).GetAwaiter().GetResult()) -gt 0) {
            if ($memory.Length + $count -gt 262144) { throw 'Response exceeded the diagnostic size limit.' }
            $memory.Write($buffer, 0, $count)
        }
        $phase = 'parse-json'
        $payload = [Text.Encoding]::UTF8.GetString($memory.ToArray()) | ConvertFrom-Json
    } finally { $deadline.Dispose(); $memory.Dispose(); $stream.Dispose() }
    if ($Operation -eq 'models') {
        $ids = @($payload.data | ForEach-Object { $_.id } | Where-Object { $_ -is [string] -and $_.Length -le 200 -and $_ -notmatch '[\x00-\x1f\x7f]' } | Sort-Object -Unique)
        if ($ids.Count -eq 0) { throw 'Response did not contain model identifiers.' }
        [pscustomobject]@{ provider = $Provider; operation = $Operation; status = $status; success = $true; modelCount = $ids.Count; relevantModels = @($ids | Where-Object { $_ -match '(?i)qwen|sensenova|sensechat|image|nova' } | Select-Object -First 45) } | ConvertTo-Json -Depth 3 -Compress
    } else {
        $phase = 'validate-text'
        $content = $payload.choices[0].message.content
        if ($content -isnot [string] -or [string]::IsNullOrWhiteSpace($content) -or $payload.choices[0].finish_reason -eq 'length') {
            $shape = @($payload.PSObject.Properties.Name | Where-Object { $_ -cin @('id', 'request_id', 'model', 'object', 'created', 'choices', 'usage', 'error') })
            $choiceShape = @($payload.choices[0].PSObject.Properties.Name | Where-Object { $_ -cin @('index', 'message', 'finish_reason') })
            $messageShape = @($payload.choices[0].message.PSObject.Properties.Name | Where-Object { $_ -cin @('role', 'content', 'reasoning', 'reasoning_content', 'refusal') })
            [pscustomobject]@{ provider = $Provider; operation = $Operation; status = $status; success = $false; reason = 'no-usable-text'; fields = $shape; choiceFields = $choiceShape; messageFields = $messageShape; reasoningPresent = [bool]($payload.choices[0].message.reasoning_content -or $payload.choices[0].message.reasoning); outputLimitReached = $payload.choices[0].finish_reason -eq 'length' } | ConvertTo-Json -Depth 3 -Compress
            exit 1
        }
        # Do not print raw provider output, billing details, prompts, or credentials.
        [pscustomobject]@{ provider = $Provider; operation = $Operation; model = $Model; status = $status; success = $true; textCharacters = $content.Length; elapsedMilliseconds = $watch.ElapsedMilliseconds } | ConvertTo-Json -Compress
    }
} catch {
    [pscustomobject]@{ provider = $Provider; operation = $Operation; success = $false; phase = $phase; reason = 'diagnostic-failed-no-private-details-logged' } | ConvertTo-Json -Compress
    exit 1
} finally {
    if ($response) { $response.Dispose() }
    if ($request) { $request.Dispose() }
    if ($client) { $client.Dispose() }
    if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    $key = $null
    $record = $null
    $encoded = $null
}
