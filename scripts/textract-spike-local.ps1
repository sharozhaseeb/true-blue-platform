param(
  [Parameter(Mandatory = $true)]
  [string]$PdfPath,

  [string]$Region = "us-east-1",

  [string]$OutputRoot = (Join-Path (Get-Location) "textract-spike-output"),

  [switch]$KeepS3
)

$ErrorActionPreference = "Stop"
$env:PYTHONIOENCODING = "utf-8"
$env:AWS_CLI_FILE_ENCODING = "UTF-8"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Invoke-AwsJson {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  $output = & aws @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "AWS command failed: aws $($Arguments -join ' ')"
  }

  return ($output | ConvertFrom-Json)
}

function Invoke-AwsText {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  $output = & aws @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "AWS command failed: aws $($Arguments -join ' ')"
  }

  return (($output | Out-String).Trim())
}

function Redact-TaxIdentifier {
  param([AllowNull()][string]$Text)

  if ($null -eq $Text) {
    return $null
  }

  $redacted = $Text -replace '\b\d{3}-\d{2}-\d{4}\b', '[REDACTED-SSN]'
  $redacted = $redacted -replace '\b\d{2}-\d{7}\b', '[REDACTED-EIN]'
  return $redacted
}

function Get-ChildIds {
  param([Parameter(Mandatory = $true)]$Block)

  $ids = @()
  foreach ($relationship in @($Block.Relationships)) {
    if ($relationship.Type -eq "CHILD") {
      $ids += @($relationship.Ids)
    }
  }

  return $ids
}

function Get-BlockText {
  param(
    [Parameter(Mandatory = $true)]$Block,
    [Parameter(Mandatory = $true)]$BlocksById
  )

  $parts = @()

  foreach ($childId in (Get-ChildIds -Block $Block)) {
    if (-not $BlocksById.ContainsKey($childId)) {
      continue
    }

    $child = $BlocksById[$childId]
    if ($child.BlockType -eq "WORD") {
      $parts += $child.Text
    } elseif ($child.BlockType -eq "SELECTION_ELEMENT") {
      $parts += "[$($child.SelectionStatus)]"
    }
  }

  return (($parts | Where-Object { $_ }) -join " ").Trim()
}

if (-not (Test-Path -LiteralPath $PdfPath)) {
  throw "PDF path does not exist: $PdfPath"
}

if (-not (Test-Path -LiteralPath $OutputRoot)) {
  New-Item -ItemType Directory -Path $OutputRoot | Out-Null
}

$identity = Invoke-AwsJson -Arguments @("sts", "get-caller-identity", "--region", $Region)
$accountId = $identity.Account
$stamp = Get-Date -Format "yyyyMMddHHmmss"
$bucket = "trueblue-textract-spike-$accountId-$stamp"
$safeName = [IO.Path]::GetFileName($PdfPath) -replace '[^A-Za-z0-9._-]', '_'
$key = "inputs/$safeName"
$jobTag = "trueblue-spike-$stamp"
$clientToken = "trueblue-spike-$stamp"
$outDir = Join-Path $OutputRoot "textract-spike-$stamp"
$bucketCreated = $false

New-Item -ItemType Directory -Path $outDir | Out-Null

try {
  Write-Host "Account: $accountId"
  Write-Host "Arn: $($identity.Arn)"
  Write-Host "Region: $Region"
  Write-Host "Bucket: $bucket"
  Write-Host "PDF: $PdfPath"
  Write-Host "Output: $outDir"

  if ($Region -eq "us-east-1") {
    & aws s3api create-bucket --bucket $bucket --region $Region | Out-Null
  } else {
    & aws s3api create-bucket --bucket $bucket --region $Region --create-bucket-configuration "LocationConstraint=$Region" | Out-Null
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to create S3 bucket: $bucket"
  }
  $bucketCreated = $true

  & aws s3api put-public-access-block `
    --bucket $bucket `
    --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to apply S3 public access block."
  }

  $encryptionConfigPath = Join-Path $outDir "bucket-encryption.json"
  @'
{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}
'@ | Set-Content -Path $encryptionConfigPath -NoNewline

  & aws s3api put-bucket-encryption `
    --bucket $bucket `
    --server-side-encryption-configuration "file://$encryptionConfigPath" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to apply S3 encryption."
  }

  & aws s3 cp $PdfPath "s3://$bucket/$key" --region $Region | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to upload PDF to S3."
  }

  $jobId = Invoke-AwsText -Arguments @(
    "textract", "start-document-analysis",
    "--region", $Region,
    "--document-location", "S3Object={Bucket=$bucket,Name=$key}",
    "--feature-types", "FORMS", "TABLES", "LAYOUT",
    "--client-request-token", $clientToken,
    "--job-tag", $jobTag,
    "--query", "JobId",
    "--output", "text"
  )

  Set-Content -Path (Join-Path $outDir "job-id.txt") -Value $jobId
  Write-Host "JobId: $jobId"

  $statusPayload = $null
  for ($attempt = 1; $attempt -le 120; $attempt++) {
    $statusPayload = Invoke-AwsJson -Arguments @(
      "textract", "get-document-analysis",
      "--region", $Region,
      "--job-id", $jobId,
      "--max-results", "1",
      "--output", "json"
    )
    $status = $statusPayload.JobStatus
    Write-Host "Attempt ${attempt}: $status"

    if ($status -eq "SUCCEEDED") {
      break
    }

    if (($status -eq "FAILED") -or ($status -eq "PARTIAL_SUCCESS")) {
      $statusPayload | ConvertTo-Json -Depth 30 | Set-Content -Path (Join-Path $outDir "status.json")
      throw "Textract job ended with status: $status"
    }

    Start-Sleep -Seconds 10
  }

  if ($statusPayload.JobStatus -ne "SUCCEEDED") {
    throw "Textract job did not complete within polling window."
  }

  $pageIndex = 1
  $nextToken = $null
  $allBlocks = @()

  do {
    $args = @(
      "textract", "get-document-analysis",
      "--region", $Region,
      "--job-id", $jobId,
      "--output", "json"
    )

    if ($nextToken) {
      $args += @("--next-token", $nextToken)
    }

    $pagePayload = Invoke-AwsJson -Arguments $args
    $pagePath = Join-Path $outDir ("page-{0}.json" -f $pageIndex)
    $pagePayload | ConvertTo-Json -Depth 100 | Set-Content -Path $pagePath

    $allBlocks += @($pagePayload.Blocks)
    $nextToken = $pagePayload.NextToken
    $pageIndex++
  } while ($nextToken)

  $blocksById = @{}
  foreach ($block in $allBlocks) {
    if ($block.Id) {
      $blocksById[$block.Id] = $block
    }
  }

  $blockTypeCounts = @{}
  foreach ($block in $allBlocks) {
    $type = if ($block.BlockType) { $block.BlockType } else { "UNKNOWN" }
    if (-not $blockTypeCounts.ContainsKey($type)) {
      $blockTypeCounts[$type] = 0
    }
    $blockTypeCounts[$type]++
  }

  $confidences = @($allBlocks | Where-Object { $null -ne $_.Confidence } | ForEach-Object { [double]$_.Confidence })
  $pages = @($allBlocks | Where-Object { $null -ne $_.Page } | ForEach-Object { [int]$_.Page } | Sort-Object -Unique)

  $keyValues = @()
  foreach ($block in $allBlocks) {
    if ($block.BlockType -ne "KEY_VALUE_SET") {
      continue
    }
    if (@($block.EntityTypes) -notcontains "KEY") {
      continue
    }

    $keyText = Get-BlockText -Block $block -BlocksById $blocksById
    $valueTexts = @()

    foreach ($relationship in @($block.Relationships)) {
      if ($relationship.Type -ne "VALUE") {
        continue
      }
      foreach ($valueId in @($relationship.Ids)) {
        if ($blocksById.ContainsKey($valueId)) {
          $valueTexts += Get-BlockText -Block $blocksById[$valueId] -BlocksById $blocksById
        }
      }
    }

    $keyValues += [pscustomobject]@{
      page = $block.Page
      key = Redact-TaxIdentifier $keyText
      value = Redact-TaxIdentifier (($valueTexts | Where-Object { $_ }) -join " ")
      confidence = $block.Confidence
      blockId = $block.Id
    }
  }

  $tables = @()
  foreach ($block in $allBlocks) {
    if ($block.BlockType -ne "TABLE") {
      continue
    }

    $cells = @()
    foreach ($cellId in (Get-ChildIds -Block $block)) {
      if ($blocksById.ContainsKey($cellId) -and $blocksById[$cellId].BlockType -eq "CELL") {
        $cells += $blocksById[$cellId]
      }
    }

    $maxRow = 0
    $maxColumn = 0
    foreach ($cell in $cells) {
      if ([int]$cell.RowIndex -gt $maxRow) { $maxRow = [int]$cell.RowIndex }
      if ([int]$cell.ColumnIndex -gt $maxColumn) { $maxColumn = [int]$cell.ColumnIndex }
    }

    $tables += [pscustomobject]@{
      page = $block.Page
      confidence = $block.Confidence
      cellCount = $cells.Count
      rows = $maxRow
      columns = $maxColumn
      blockId = $block.Id
    }
  }

  $selectionElements = @(
    $allBlocks |
      Where-Object { $_.BlockType -eq "SELECTION_ELEMENT" } |
      Select-Object @{ Name = "page"; Expression = { $_.Page } },
        @{ Name = "status"; Expression = { $_.SelectionStatus } },
        @{ Name = "confidence"; Expression = { $_.Confidence } },
        @{ Name = "blockId"; Expression = { $_.Id } }
  )

  $summary = [pscustomobject]@{
    pdf = [IO.Path]::GetFileName($PdfPath)
    region = $Region
    bucket = $bucket
    s3Key = $key
    jobId = $jobId
    pageCount = $pages.Count
    blockCount = $allBlocks.Count
    blockTypeCounts = $blockTypeCounts
    confidence = [pscustomobject]@{
      min = if ($confidences.Count) { ($confidences | Measure-Object -Minimum).Minimum } else { $null }
      avg = if ($confidences.Count) { ($confidences | Measure-Object -Average).Average } else { $null }
      max = if ($confidences.Count) { ($confidences | Measure-Object -Maximum).Maximum } else { $null }
    }
    keyValueCount = $keyValues.Count
    tableCount = $tables.Count
    selectionElementCount = $selectionElements.Count
    sampleKeyValues = @($keyValues | Select-Object -First 40)
    sampleTables = @($tables | Select-Object -First 20)
    sampleSelectionElements = @($selectionElements | Select-Object -First 30)
  }

  $summaryPath = Join-Path $outDir "summary.json"
  $summary | ConvertTo-Json -Depth 100 | Set-Content -Path $summaryPath
  $summary | ConvertTo-Json -Depth 100

  Write-Host "Wrote spike output to: $outDir"
  Write-Host "Summary: $summaryPath"
  Write-Host "Raw Textract page JSON files contain sensitive document data. Do not commit them."
} finally {
  if ($bucketCreated -and -not $KeepS3) {
    Write-Host "Cleaning up S3 object and bucket: $bucket"
    & aws s3 rm "s3://$bucket/$key" --region $Region | Out-Null
    & aws s3api delete-bucket --bucket $bucket --region $Region | Out-Null
  }
}
