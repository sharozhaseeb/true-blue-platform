param(
  [Parameter(Mandatory = $true)]
  [string]$BaseUrl,

  [string]$CookieFile,
  [string]$BearerToken,

  [Parameter(Mandatory = $true)]
  [string]$PdfPath,

  [string]$OutputPath = ".\m4-e2e-report.json",
  [switch]$ExpectVectorRetrieval,
  [int]$TimeoutSeconds = 300
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $PdfPath)) {
  throw "PDF fixture not found: $PdfPath"
}

function Join-Url([string]$Root, [string]$Path) {
  return $Root.TrimEnd("/") + "/" + $Path.TrimStart("/")
}

function Get-CookieHeader([string]$Path) {
  if (-not $Path) {
    return $null
  }
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Cookie file not found: $Path"
  }

  $lines = Get-Content -LiteralPath $Path | Where-Object {
    $_ -and -not $_.StartsWith("#")
  }
  $pairs = foreach ($line in $lines) {
    $parts = $line -split "`t"
    if ($parts.Length -ge 7) {
      "$($parts[5])=$($parts[6])"
    } else {
      $line.Trim()
    }
  }

  return ($pairs | Where-Object { $_ }) -join "; "
}

function Get-AuthHeaders {
  $headers = @{}
  if ($BearerToken) {
    $headers["Authorization"] = "Bearer $BearerToken"
  }
  $cookieHeader = Get-CookieHeader $CookieFile
  if ($cookieHeader) {
    $headers["Cookie"] = $cookieHeader
  }
  return $headers
}

function Invoke-Json([string]$Method, [string]$Path, $Body = $null) {
  $headers = Get-AuthHeaders
  $headers["Accept"] = "application/json"
  $uri = Join-Url $BaseUrl $Path
  if ($null -eq $Body) {
    return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers
  }

  return Invoke-RestMethod `
    -Method $Method `
    -Uri $uri `
    -Headers $headers `
    -ContentType "application/json" `
    -Body ($Body | ConvertTo-Json -Depth 20)
}

function Upload-Pdf([string]$Path) {
  Add-Type -AssemblyName System.Net.Http
  $client = [System.Net.Http.HttpClient]::new()
  try {
    foreach ($entry in (Get-AuthHeaders).GetEnumerator()) {
      [void]$client.DefaultRequestHeaders.TryAddWithoutValidation($entry.Key, $entry.Value)
    }
    [void]$client.DefaultRequestHeaders.TryAddWithoutValidation("Accept", "application/json")

    $content = [System.Net.Http.MultipartFormDataContent]::new()
    $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $Path).Path)
    $fileContent = [System.Net.Http.ByteArrayContent]::new($bytes)
    $fileContent.Headers.ContentType =
      [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse("application/pdf")
    $filename = [System.IO.Path]::GetFileName($Path)
    $content.Add($fileContent, "file", $filename)

    $response = $client.PostAsync((Join-Url $BaseUrl "/api/documents/upload"), $content).Result
    $text = $response.Content.ReadAsStringAsync().Result
    if (-not $response.IsSuccessStatusCode) {
      throw "Upload failed with HTTP $([int]$response.StatusCode): $text"
    }

    return $text | ConvertFrom-Json
  } finally {
    $client.Dispose()
  }
}

function Assert-Check([bool]$Condition, [string]$Message, [System.Collections.Generic.List[string]]$Failures) {
  if (-not $Condition) {
    $Failures.Add($Message)
  }
}

$failures = [System.Collections.Generic.List[string]]::new()
$timeline = @()
$startedAt = Get-Date

$auth = Invoke-Json "GET" "/api/auth/me"
$upload = Upload-Pdf $PdfPath
$documentId = $upload.document.id
$filename = $upload.document.originalName

if (-not $documentId) {
  throw "Upload response did not include document.id"
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$document = $null
do {
  $document = Invoke-Json "GET" "/api/documents/$documentId"
  $timeline += [pscustomobject]@{
    at = (Get-Date).ToUniversalTime().ToString("o")
    status = $document.document.status
    pageCount = $document.document.pageCount
  }
  if ($document.document.status -eq "COMPLETED" -or $document.document.status -eq "FAILED") {
    break
  }
  Start-Sleep -Seconds 5
} while ((Get-Date) -lt $deadline)

Assert-Check ($document.document.status -eq "COMPLETED") "document did not reach COMPLETED" $failures

$vectorEvidence = [pscustomobject]@{
  expected = [bool]$ExpectVectorRetrieval
  checked = $false
  endpoint = "/api/internal/m4/vector-index-status?documentId=$documentId"
  ok = $false
  detail = $null
}

if ($ExpectVectorRetrieval) {
  try {
    $vectorStatus = Invoke-Json "GET" $vectorEvidence.endpoint
    $vectorEvidence.checked = $true
    $vectorEvidence.detail = $vectorStatus
    $vectorEvidence.ok =
      $vectorStatus.isActive -eq $true -or
      $vectorStatus.status -eq "ACTIVE" -or
      $vectorStatus.index.status -eq "ACTIVE"
  } catch {
    $vectorEvidence.checked = $true
    $vectorEvidence.detail =
      "No gated vector-index status endpoint was available. Use DB-side staging runbook evidence for document_vector_indexes."
  }
  Assert-Check $vectorEvidence.ok "vector retrieval was expected but active vector index evidence was not proven" $failures
}

$chatBody = @{
  requestKey = "m4-e2e-grounded-$([guid]::NewGuid().ToString("N"))"
  message = @{
    role = "user"
    content = "What filing status or taxpayer identifying detail appears in this uploaded return?"
  }
  documentFilter = @{
    documentIds = @($documentId)
  }
}
$chat = Invoke-Json "POST" "/api/chat" $chatBody

Assert-Check ($chat.output.schemaVersion -eq "trueblue.chat.output.v1") "chat output schemaVersion mismatch" $failures
Assert-Check ($chat.output.status -eq "answered") "grounded chat did not return answered status" $failures
Assert-Check (($chat.output.sources | Measure-Object).Count -ge 1) "grounded chat returned no sources" $failures
Assert-Check (($chat.output.sources | Where-Object { $_.documentId -eq $documentId } | Measure-Object).Count -ge 1) "grounded source did not reference uploaded document" $failures
Assert-Check ($null -ne $chat.output.sources[0].pageStart) "source page metadata missing" $failures
if ($ExpectVectorRetrieval) {
  Assert-Check ($chat.mode -eq "vector_retrieval") "vector retrieval expected but chat mode was not vector_retrieval" $failures
}

$unsupportedBody = @{
  requestKey = "m4-e2e-unsupported-$([guid]::NewGuid().ToString("N"))"
  message = @{
    role = "user"
    content = "What spacecraft purchase details are in this uploaded return?"
  }
  documentFilter = @{
    documentIds = @($documentId)
  }
}
$unsupported = Invoke-Json "POST" "/api/chat" $unsupportedBody
Assert-Check ($unsupported.output.status -eq "insufficient_evidence") "unsupported query did not return insufficient_evidence" $failures
Assert-Check (($unsupported.output.sources | Measure-Object).Count -eq 0) "unsupported query returned sources" $failures

$thread = Invoke-Json "GET" "/api/chat/threads/$($chat.threadId)"
$replayedAssistant = $thread.messages | Where-Object { $_.role -eq "assistant" } | Select-Object -Last 1
$replayOutputPart = $replayedAssistant.parts | Where-Object { $_.type -eq "data-output" } | Select-Object -First 1
Assert-Check ($null -ne $replayOutputPart.data.output) "thread replay did not include data-output" $failures
Assert-Check ($replayOutputPart.data.output.schemaVersion -eq "trueblue.chat.output.v1") "thread replay output schemaVersion mismatch" $failures

$report = [pscustomobject]@{
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  durationSeconds = [int]((Get-Date) - $startedAt).TotalSeconds
  stagingUrl = $BaseUrl
  uploadedDocument = [pscustomobject]@{
    id = $documentId
    filename = $filename
    finalStatus = $document.document.status
    pageCount = $document.document.pageCount
  }
  processingStatusTimeline = $timeline
  vectorReadiness = $vectorEvidence
  chatResponse = [pscustomobject]@{
    httpStatus = 200
    mode = $chat.mode
    threadId = $chat.threadId
    outputSchemaVersion = $chat.output.schemaVersion
    outputStatus = $chat.output.status
    sourceCount = ($chat.output.sources | Measure-Object).Count
  }
  unsupportedQuestion = [pscustomobject]@{
    outputStatus = $unsupported.output.status
    sourceCount = ($unsupported.output.sources | Measure-Object).Count
  }
  threadReplay = [pscustomobject]@{
    checked = $true
    hasDataOutput = $null -ne $replayOutputPart.data.output
    schemaVersion = $replayOutputPart.data.output.schemaVersion
  }
  failures = $failures
}

$report | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath $OutputPath -Encoding UTF8

if ($failures.Count -gt 0) {
  $failures | ForEach-Object { Write-Error "FAIL $_" }
  exit 1
}

Write-Host "M4 staging E2E report written to $OutputPath"
