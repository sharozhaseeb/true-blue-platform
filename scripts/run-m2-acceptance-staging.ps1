param(
  [string]$BaseUrl = "http://54.208.102.72",
  [string]$PdfDir = "C:\Users\pc\work\yan\client_shared_pdfs",
  [string]$ReportPath = "C:\Users\pc\work\yan\true-blue-platform\staging-m2-acceptance-rerun-report.json"
)

$ErrorActionPreference = "Stop"

$tempDir = Join-Path $env:TEMP ("m2-acceptance-" + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $tempDir | Out-Null

function Invoke-CurlJson {
  param([string[]]$CurlArgs)

  $bodyFile = Join-Path $tempDir (([guid]::NewGuid().ToString()) + ".body")
  $errFile = Join-Path $tempDir (([guid]::NewGuid().ToString()) + ".err")
  $statusText = & curl.exe -sS -o $bodyFile -w "%{http_code}" @CurlArgs 2> $errFile
  $body = if (Test-Path $bodyFile) { Get-Content $bodyFile -Raw } else { "" }
  $stderr = if (Test-Path $errFile) { Get-Content $errFile -Raw } else { "" }
  $json = $null

  if ($body) {
    try {
      $json = $body | ConvertFrom-Json -ErrorAction Stop
    } catch {
      $json = $null
    }
  }

  [pscustomobject]@{
    StatusCode = [int]$statusText
    Body = $body
    Json = $json
    Stderr = $stderr
  }
}

function Login {
  param([string]$CookieFile, [string]$Email, [string]$Password)

  $loginPayload = @{
    email = $Email
    password = $Password
  } | ConvertTo-Json -Compress
  $payloadFile = Join-Path $tempDir (([guid]::NewGuid().ToString()) + ".json")
  Set-Content -Path $payloadFile -Value $loginPayload -NoNewline

  Invoke-CurlJson @(
    "-c", $CookieFile,
    "-X", "POST", "$BaseUrl/api/auth/login",
    "-H", "Content-Type: application/json",
    "--data-binary", "@$payloadFile"
  )
}

function UploadFile {
  param([string]$CookieFile, [string]$FilePath)

  Invoke-CurlJson @(
    "-b", $CookieFile,
    "-X", "POST", "$BaseUrl/api/documents/upload",
    "-F", "file=@$FilePath"
  )
}

function List-Documents {
  param([string]$CookieFile, [int]$Limit = 100)

  Invoke-CurlJson @("-b", $CookieFile, "$BaseUrl/api/documents?limit=$Limit")
}

function Get-DocumentDetail {
  param([string]$CookieFile, [string]$DocumentId)

  Invoke-CurlJson @("-b", $CookieFile, "$BaseUrl/api/documents/$DocumentId")
}

function Get-DocumentChunks {
  param([string]$CookieFile, [string]$DocumentId, [int]$Limit = 500, [int]$Page = 1)

  Invoke-CurlJson @(
    "-b", $CookieFile,
    "$BaseUrl/api/documents/$($DocumentId)?chunks=true&page=$Page&limit=$Limit"
  )
}

function Delete-Document {
  param([string]$CookieFile, [string]$DocumentId)

  Invoke-CurlJson @("-b", $CookieFile, "-X", "DELETE", "$BaseUrl/api/documents/$DocumentId")
}

function Get-DocPayload {
  param($Response)

  if ($null -ne $Response.Json -and $Response.Json.PSObject.Properties.Name -contains "document") {
    return $Response.Json.document
  }

  return $Response.Json
}

function Add-Check {
  param([ref]$List, [string]$Name, [bool]$Passed, $Details)

  $List.Value += [pscustomobject]@{
    name = $Name
    passed = $Passed
    details = $Details
  }
}

function Test-Range {
  param([int]$Value, [int]$Min, [int]$Max)

  return ($Value -ge $Min -and $Value -le $Max)
}

$userCookie = Join-Path $tempDir "user.txt"
$adminCookie = Join-Path $tempDir "admin.txt"
$bestCookie = Join-Path $tempDir "best.txt"
$platformCookie = Join-Path $tempDir "platform.txt"
$createdDocs = New-Object System.Collections.Generic.List[string]
$checks = @()

$userLogin = Login -CookieFile $userCookie -Email "user@acmetax.com" -Password "FirmUser1!"
$adminLogin = Login -CookieFile $adminCookie -Email "admin@acmetax.com" -Password "FirmAdmin1!"
$bestLogin = Login -CookieFile $bestCookie -Email "admin@besttax.com" -Password "FirmAdmin1!"
$platformLogin = Login -CookieFile $platformCookie -Email "admin@trueblue.dev" -Password "Admin123!"
Add-Check ([ref]$checks) "Prereq logins succeed" (($userLogin.StatusCode -eq 200) -and ($adminLogin.StatusCode -eq 200) -and ($bestLogin.StatusCode -eq 200) -and ($platformLogin.StatusCode -eq 200)) @{
  user = $userLogin.StatusCode
  admin = $adminLogin.StatusCode
  best = $bestLogin.StatusCode
  platform = $platformLogin.StatusCode
}

# Criterion 1
$jimenezPath = Join-Path $PdfDir "2025 Tax Return Documents (Jimenez Julio).pdf"
$uploadJimenez = UploadFile -CookieFile $userCookie -FilePath $jimenezPath
$jimenezDoc = Get-DocPayload $uploadJimenez
$jimenezId = $jimenezDoc.id
if ($jimenezId) { $createdDocs.Add($jimenezId) | Out-Null }
Add-Check ([ref]$checks) "1a upload PDF returns completed document" (($uploadJimenez.StatusCode -eq 200) -and ($jimenezDoc.status -eq "COMPLETED") -and ($jimenezDoc.pageCount -eq 22) -and ($jimenezDoc.chunkCount -ge 17)) @{
  statusCode = $uploadJimenez.StatusCode
  document = $jimenezDoc
}

$listUser = List-Documents -CookieFile $userCookie -Limit 100
$userDocs = @($listUser.Json.documents)
$foundUserDoc = $userDocs | Where-Object { $_.id -eq $jimenezId }
Add-Check ([ref]$checks) "1b uploaded document appears in Acme user list" (($listUser.StatusCode -eq 200) -and ($null -ne $foundUserDoc)) @{
  statusCode = $listUser.StatusCode
  total = $listUser.Json.total
  found = ($null -ne $foundUserDoc)
}

$detailUser = Get-DocumentDetail -CookieFile $userCookie -DocumentId $jimenezId
$detailUserDoc = Get-DocPayload $detailUser
Add-Check ([ref]$checks) "1b-verify detail shows S3 storage fields" (($detailUser.StatusCode -eq 200) -and [string]::IsNullOrEmpty($detailUserDoc.s3Bucket) -eq $false -and [string]::IsNullOrEmpty($detailUserDoc.s3Key) -eq $false) @{
  statusCode = $detailUser.StatusCode
  s3Bucket = $detailUserDoc.s3Bucket
  s3Key = $detailUserDoc.s3Key
}

$listBest = List-Documents -CookieFile $bestCookie -Limit 100
$bestDocs = @($listBest.Json.documents)
$bestSeesTarget = $bestDocs | Where-Object { $_.id -eq $jimenezId }
Add-Check ([ref]$checks) "1c cross-tenant list does not expose Acme document" (($listBest.StatusCode -eq 200) -and ($null -eq $bestSeesTarget)) @{
  statusCode = $listBest.StatusCode
  total = $listBest.Json.total
  targetVisible = ($null -ne $bestSeesTarget)
}

$bestDetail = Get-DocumentDetail -CookieFile $bestCookie -DocumentId $jimenezId
Add-Check ([ref]$checks) "1d cross-tenant direct document access returns 404" (($bestDetail.StatusCode -eq 404) -and ($bestDetail.Body -match "Document not found")) @{
  statusCode = $bestDetail.StatusCode
  body = $bestDetail.Body
}

$listPlatform = List-Documents -CookieFile $platformCookie -Limit 100
$platformDocs = @($listPlatform.Json.documents)
$platformSeesTarget = $platformDocs | Where-Object { $_.id -eq $jimenezId }
Add-Check ([ref]$checks) "1e platform admin can see document across firms" (($listPlatform.StatusCode -eq 200) -and ($null -ne $platformSeesTarget)) @{
  statusCode = $listPlatform.StatusCode
  total = $listPlatform.Json.total
  targetVisible = ($null -ne $platformSeesTarget)
}

$whittakerPath = Join-Path $PdfDir "2025 Tax Return Documents (Whittaker Jordan).pdf"
$uploadAdmin = UploadFile -CookieFile $adminCookie -FilePath $whittakerPath
$adminDoc = Get-DocPayload $uploadAdmin
$adminDocId = $adminDoc.id
if ($adminDocId) { $createdDocs.Add($adminDocId) | Out-Null }
Add-Check ([ref]$checks) "1f firm admin can upload" (($uploadAdmin.StatusCode -eq 200) -and ($adminDoc.status -eq "COMPLETED")) @{
  statusCode = $uploadAdmin.StatusCode
  document = $adminDoc
}

# Criterion 2
$w2Path = Join-Path $PdfDir "W2.jpg"
$wrongType = UploadFile -CookieFile $userCookie -FilePath $w2Path
Add-Check ([ref]$checks) "2a wrong file type rejected with 415" (($wrongType.StatusCode -eq 415) -and ($wrongType.Json.message -eq "File must have a .pdf extension")) @{
  statusCode = $wrongType.StatusCode
  body = $wrongType.Body
}

$fakePdf = Join-Path $tempDir "notes.pdf"
Set-Content -Path $fakePdf -Value "not a real pdf" -NoNewline
$fakeUpload = UploadFile -CookieFile $userCookie -FilePath $fakePdf
Add-Check ([ref]$checks) "2b renamed non-PDF rejected by magic bytes" (($fakeUpload.StatusCode -eq 415) -and ($fakeUpload.Body -match "invalid magic bytes")) @{
  statusCode = $fakeUpload.StatusCode
  body = $fakeUpload.Body
}

$tooLarge = Join-Path $tempDir "too_large.pdf"
$f = New-Object byte[] (21 * 1024 * 1024)
[System.IO.File]::WriteAllBytes($tooLarge, $f)
$tooLargeUpload = UploadFile -CookieFile $userCookie -FilePath $tooLarge
Add-Check ([ref]$checks) "2c oversized file rejected with 413" (($tooLargeUpload.StatusCode -eq 413) -and ($tooLargeUpload.Body -match "20MB")) @{
  statusCode = $tooLargeUpload.StatusCode
  body = $tooLargeUpload.Body
}

$missingFile = Invoke-CurlJson @("-b", $userCookie, "-X", "POST", "$BaseUrl/api/documents/upload", "-F", "other=test")
Add-Check ([ref]$checks) "2d missing file field rejected with 400" (($missingFile.StatusCode -eq 400) -and ($missingFile.Body -match "No file provided")) @{
  statusCode = $missingFile.StatusCode
  body = $missingFile.Body
}

$noAuth = Invoke-CurlJson @("-X", "POST", "$BaseUrl/api/documents/upload", "-F", "file=@$jimenezPath")
Add-Check ([ref]$checks) "2e unauthenticated upload rejected with 401" (($noAuth.StatusCode -eq 401) -and ($noAuth.Body -match "Unauthorized")) @{
  statusCode = $noAuth.StatusCode
  body = $noAuth.Body
}

# Criterion 3
$jimenezChunks3 = Get-DocumentChunks -CookieFile $userCookie -DocumentId $jimenezId -Limit 3 -Page 1
$jimenezChunkItems3 = @($jimenezChunks3.Json.chunks)
$firstChunk3 = if ($jimenezChunkItems3.Count -gt 0) { $jimenezChunkItems3[0] } else { $null }
$chunkReadable = $false
if ($firstChunk3) {
  $chunkReadable = ($firstChunk3.content -match 'Form 1040') -and ($firstChunk3.content -match 'Julio Jimenez') -and ($firstChunk3.content -match '500-00-1003')
}
Add-Check ([ref]$checks) "3a chunk readback returns readable extracted text" (($jimenezChunks3.StatusCode -eq 200) -and ($jimenezChunks3.Json.chunkTotal -ge 1) -and ($jimenezChunkItems3.Count -ge 1) -and $chunkReadable) @{
  statusCode = $jimenezChunks3.StatusCode
  chunkTotal = $jimenezChunks3.Json.chunkTotal
  firstChunk = $firstChunk3
}

$jimenezChunksAll = Get-DocumentChunks -CookieFile $userCookie -DocumentId $jimenezId -Limit 500 -Page 1
$jimenezAllChunkItems = @($jimenezChunksAll.Json.chunks)
$jimenezJoined = ($jimenezAllChunkItems | ForEach-Object { $_.content }) -join "`n"
$valuesOk = @(
  ($jimenezJoined -match 'Julio Jimenez' -and $jimenezJoined -match '500-00-1003'),
  ($jimenezJoined -match 'GOODWILL OF CENTRAL AND COASTAL' -and $jimenezJoined -match '6,938' -and $jimenezJoined -match '56'),
  ($jimenezJoined -match 'Due date:\s*04-15-2026' -and $jimenezJoined -match 'Refund:\s*\$586')
)
Add-Check ([ref]$checks) "3b financial data and known values preserved" (($jimenezChunksAll.StatusCode -eq 200) -and -not ($valuesOk -contains $false)) @{
  statusCode = $jimenezChunksAll.StatusCode
  checks = $valuesOk
}

$expectedRanges = @{
  "2025 Tax Return Documents (Jimenez Julio).pdf" = @{ pages = 22; min = 17; max = 22 }
  "2025 Tax Return Documents (Whittaker Jordan).pdf" = @{ pages = 25; min = 20; max = 25 }
  "2025 Tax Return Documents (Crestline Financial Group LLC).pdf" = @{ pages = 41; min = 35; max = 41 }
  "2025 Tax Return Documents (ELLINGTON PETER).pdf" = @{ pages = 43; min = 37; max = 43 }
  "2025 Tax Return Documents (SMITH TALIA S and Antonio Smith).pdf" = @{ pages = 52; min = 45; max = 52 }
  "2025 Tax Return Documents (SHOEMAKER JOHNNY and ANNIE).pdf" = @{ pages = 63; min = 55; max = 63 }
}

$sampleUploads = [ordered]@{}
$sampleUploads["2025 Tax Return Documents (Jimenez Julio).pdf"] = $jimenezDoc

foreach ($name in @(
  "2025 Tax Return Documents (Whittaker Jordan).pdf",
  "2025 Tax Return Documents (Crestline Financial Group LLC).pdf",
  "2025 Tax Return Documents (ELLINGTON PETER).pdf",
  "2025 Tax Return Documents (SMITH TALIA S and Antonio Smith).pdf",
  "2025 Tax Return Documents (SHOEMAKER JOHNNY and ANNIE).pdf"
)) {
  $resp = UploadFile -CookieFile $userCookie -FilePath (Join-Path $PdfDir $name)
  $doc = Get-DocPayload $resp
  if ($doc.id) { $createdDocs.Add($doc.id) | Out-Null }
  $sampleUploads[$name] = $doc
}

$allSixOk = $true
foreach ($entry in $sampleUploads.GetEnumerator()) {
  $range = $expectedRanges[$entry.Key]
  $doc = $entry.Value
  if (-not ($doc.status -eq "COMPLETED" -and $doc.pageCount -eq $range.pages -and (Test-Range -Value $doc.chunkCount -Min $range.min -Max $range.max))) {
    $allSixOk = $false
  }
}
Add-Check ([ref]$checks) "3c all 6 sample PDFs upload and process successfully" $allSixOk @{ uploads = $sampleUploads }

# Criterion 4
$jimenezChunks5 = Get-DocumentChunks -CookieFile $userCookie -DocumentId $jimenezId -Limit 5 -Page 1
$chunk0 = if (@($jimenezChunks5.Json.chunks).Count -gt 0) { @($jimenezChunks5.Json.chunks)[0] } else { $null }
$meta = if ($chunk0) { $chunk0.metadata } else { $null }
$metaOk = $false
if ($chunk0 -and $meta) {
  $metaOk = ($null -ne $chunk0.pageNumber) -and ($null -ne $chunk0.chunkIndex) -and ($null -ne $chunk0.tokenEstimate) -and ($null -ne $meta.filename) -and ($meta.PSObject.Properties.Name -contains "formType") -and ($meta.PSObject.Properties.Name -contains "explicitFormType") -and ($meta.PSObject.Properties.Name -contains "resolvedFormType") -and ($meta.PSObject.Properties.Name -contains "formTypeSource")
}
Add-Check ([ref]$checks) "4a chunk metadata fields are present" (($jimenezChunks5.StatusCode -eq 200) -and $metaOk -and ($jimenezChunks5.Json.chunkTotal -ge 1)) @{
  statusCode = $jimenezChunks5.StatusCode
  chunk0 = $chunk0
}

$chunkRangeOk = $true
$chunkRangeSummary = [ordered]@{}
foreach ($entry in $sampleUploads.GetEnumerator()) {
  $range = $expectedRanges[$entry.Key]
  $doc = $entry.Value
  $ok = Test-Range -Value $doc.chunkCount -Min $range.min -Max $range.max
  if (-not $ok) { $chunkRangeOk = $false }
  $chunkRangeSummary[$entry.Key] = @{
    chunkCount = $doc.chunkCount
    range = "$($range.min)-$($range.max)"
    ok = $ok
  }
}
Add-Check ([ref]$checks) "4b chunk counts are reasonable versus page counts" $chunkRangeOk $chunkRangeSummary

$crestlineId = $sampleUploads["2025 Tax Return Documents (Crestline Financial Group LLC).pdf"].id
$crestlineChunks = Get-DocumentChunks -CookieFile $userCookie -DocumentId $crestlineId -Limit 500 -Page 1
$crestlineTypes = @($crestlineChunks.Json.chunks | ForEach-Object { $_.metadata.formType } | Where-Object { $null -ne $_ } | Sort-Object -Unique)
$crestlineNullCount = @($crestlineChunks.Json.chunks | Where-Object { $null -eq $_.metadata.formType }).Count
$formDetectOk = ($crestlineChunks.StatusCode -eq 200) -and ($crestlineTypes -contains "Form 1065") -and ($crestlineTypes -contains "Schedule K-1") -and ($crestlineNullCount -ge 1)
Add-Check ([ref]$checks) "4c IRS form types are detected and support pages can remain null" $formDetectOk @{
  statusCode = $crestlineChunks.StatusCode
  formTypes = $crestlineTypes
  nullChunks = $crestlineNullCount
}

$page1 = Get-DocumentChunks -CookieFile $userCookie -DocumentId $jimenezId -Limit 5 -Page 1
$page2 = Get-DocumentChunks -CookieFile $userCookie -DocumentId $jimenezId -Limit 5 -Page 2
$page1Idx = @($page1.Json.chunks | ForEach-Object { $_.chunkIndex })
$page2Idx = @($page2.Json.chunks | ForEach-Object { $_.chunkIndex })
$sharedIndexes = @($page1Idx | Where-Object { $page2Idx -contains $_ })
$paginationOk = ($page1.StatusCode -eq 200) -and ($page2.StatusCode -eq 200) -and ($page1Idx.Count -gt 0) -and ($page2Idx.Count -gt 0) -and ($sharedIndexes.Count -eq 0)
Add-Check ([ref]$checks) "4d chunk pagination returns distinct chunk windows" $paginationOk @{
  page1 = $page1Idx
  page2 = $page2Idx
  chunkTotal = $page1.Json.chunkTotal
}

# Criterion 5
$deleteOwnerUpload = UploadFile -CookieFile $userCookie -FilePath $whittakerPath
$deleteOwnerDoc = Get-DocPayload $deleteOwnerUpload
if ($deleteOwnerDoc.id) { $createdDocs.Add($deleteOwnerDoc.id) | Out-Null }
$deleteOwner = Delete-Document -CookieFile $userCookie -DocumentId $deleteOwnerDoc.id
$deleteOwnerVerify = Get-DocumentDetail -CookieFile $userCookie -DocumentId $deleteOwnerDoc.id
Add-Check ([ref]$checks) "5a owner can delete own document" (($deleteOwner.StatusCode -eq 204) -and ($deleteOwnerVerify.StatusCode -eq 404)) @{
  deleteStatus = $deleteOwner.StatusCode
  verifyStatus = $deleteOwnerVerify.StatusCode
}

$userDeleteTargetId = $sampleUploads["2025 Tax Return Documents (Crestline Financial Group LLC).pdf"].id
$adminDeleteUserDoc = Delete-Document -CookieFile $adminCookie -DocumentId $userDeleteTargetId
$adminDeleteVerify = Get-DocumentDetail -CookieFile $adminCookie -DocumentId $userDeleteTargetId
Add-Check ([ref]$checks) "5b firm admin can delete another user document" (($adminDeleteUserDoc.StatusCode -eq 204) -and ($adminDeleteVerify.StatusCode -eq 404)) @{
  deleteStatus = $adminDeleteUserDoc.StatusCode
  verifyStatus = $adminDeleteVerify.StatusCode
}

$userDeleteAdminDoc = Delete-Document -CookieFile $userCookie -DocumentId $adminDocId
Add-Check ([ref]$checks) "5c non-owner firm user is blocked from deleting admin document" (($userDeleteAdminDoc.StatusCode -eq 403) -and ($userDeleteAdminDoc.Body -match "do not have permission")) @{
  statusCode = $userDeleteAdminDoc.StatusCode
  body = $userDeleteAdminDoc.Body
}

$bestDeleteAdminDoc = Delete-Document -CookieFile $bestCookie -DocumentId $adminDocId
Add-Check ([ref]$checks) "5d cross-tenant delete returns 404" (($bestDeleteAdminDoc.StatusCode -eq 404) -and ($bestDeleteAdminDoc.Body -match "Document not found")) @{
  statusCode = $bestDeleteAdminDoc.StatusCode
  body = $bestDeleteAdminDoc.Body
}

# Cleanup
$cleanupResults = @()
foreach ($id in ($createdDocs | Select-Object -Unique)) {
  $deleteResp = Delete-Document -CookieFile $adminCookie -DocumentId $id
  $cleanupResults += [pscustomobject]@{
    id = $id
    statusCode = $deleteResp.StatusCode
  }
}

$summary = [ordered]@{
  totalChecks = $checks.Count
  passedChecks = @($checks | Where-Object { $_.passed }).Count
  failedChecks = @($checks | Where-Object { -not $_.passed }).Count
}

$report = [ordered]@{
  generatedAt = (Get-Date).ToString("o")
  baseUrl = $BaseUrl
  summary = $summary
  checks = $checks
  cleanup = $cleanupResults
}

$report | ConvertTo-Json -Depth 8 | Set-Content -Path $ReportPath

$checks | ForEach-Object {
  if ($_.passed) {
    Write-Output ("PASS " + $_.name)
  } else {
    Write-Output ("FAIL " + $_.name)
  }
}

Write-Output ("Report: " + $ReportPath)
Write-Output ("Summary: " + ($summary | ConvertTo-Json -Compress))

Remove-Item -Recurse -Force $tempDir
