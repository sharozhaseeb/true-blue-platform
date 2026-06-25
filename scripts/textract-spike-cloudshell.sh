#!/usr/bin/env bash
set -euo pipefail

PDF_PATH="${1:-}"
REGION="${2:-us-east-1}"

if [[ -z "$PDF_PATH" || ! -f "$PDF_PATH" ]]; then
  echo "Usage: bash textract-spike-cloudshell.sh <pdf-path> [region]" >&2
  exit 1
fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STAMP="$(date +%Y%m%d%H%M%S)"
BUCKET="trueblue-textract-spike-${ACCOUNT_ID}-${STAMP}"
SAFE_NAME="$(basename "$PDF_PATH" | tr -c 'A-Za-z0-9._-' '_')"
KEY="inputs/${SAFE_NAME}"
JOB_TAG="trueblue-spike-${STAMP}"
CLIENT_TOKEN="trueblue-spike-${STAMP}"
OUT_DIR="textract-spike-${STAMP}"

mkdir -p "$OUT_DIR"

echo "Account: $ACCOUNT_ID"
echo "Region: $REGION"
echo "Bucket: $BUCKET"
echo "PDF: $PDF_PATH"

if [[ "$REGION" == "us-east-1" ]]; then
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
else
  aws s3api create-bucket \
    --bucket "$BUCKET" \
    --region "$REGION" \
    --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
fi

aws s3api put-public-access-block \
  --bucket "$BUCKET" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" >/dev/null

aws s3api put-bucket-encryption \
  --bucket "$BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' >/dev/null

aws s3 cp "$PDF_PATH" "s3://$BUCKET/$KEY" --region "$REGION" >/dev/null

JOB_ID="$(
  aws textract start-document-analysis \
    --region "$REGION" \
    --document-location "S3Object={Bucket=$BUCKET,Name=$KEY}" \
    --feature-types FORMS TABLES LAYOUT \
    --client-request-token "$CLIENT_TOKEN" \
    --job-tag "$JOB_TAG" \
    --query JobId \
    --output text
)"

echo "JobId: $JOB_ID"
echo "$JOB_ID" > "$OUT_DIR/job-id.txt"

for attempt in $(seq 1 120); do
  STATUS="$(
    aws textract get-document-analysis \
      --region "$REGION" \
      --job-id "$JOB_ID" \
      --max-results 1 \
      --query JobStatus \
      --output text
  )"

  echo "Attempt $attempt: $STATUS"

  case "$STATUS" in
    SUCCEEDED)
      break
      ;;
    FAILED|PARTIAL_SUCCESS)
      echo "Textract job ended with status: $STATUS" >&2
      aws textract get-document-analysis \
        --region "$REGION" \
        --job-id "$JOB_ID" \
        --max-results 1 \
        --output json > "$OUT_DIR/status.json"
      exit 2
      ;;
  esac

  sleep 10
done

PAGE=1
NEXT_TOKEN=""

while true; do
  PAGE_FILE="$OUT_DIR/page-${PAGE}.json"

  if [[ -z "$NEXT_TOKEN" ]]; then
    aws textract get-document-analysis \
      --region "$REGION" \
      --job-id "$JOB_ID" \
      --output json > "$PAGE_FILE"
  else
    aws textract get-document-analysis \
      --region "$REGION" \
      --job-id "$JOB_ID" \
      --next-token "$NEXT_TOKEN" \
      --output json > "$PAGE_FILE"
  fi

  NEXT_TOKEN="$(
    python3 - "$PAGE_FILE" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)

print(payload.get("NextToken", ""))
PY
  )"

  [[ -z "$NEXT_TOKEN" ]] && break
  PAGE=$((PAGE + 1))
done

python3 - "$OUT_DIR" "$PDF_PATH" "$BUCKET" "$KEY" "$JOB_ID" "$REGION" <<'PY'
import glob
import json
import os
import re
import statistics
import sys
from collections import Counter

out_dir, pdf_path, bucket, key, job_id, region = sys.argv[1:]
blocks = []

for path in sorted(glob.glob(os.path.join(out_dir, "page-*.json"))):
    with open(path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
        blocks.extend(payload.get("Blocks", []))

by_id = {block.get("Id"): block for block in blocks if block.get("Id")}
counts = Counter(block.get("BlockType", "UNKNOWN") for block in blocks)
confidences = [block["Confidence"] for block in blocks if isinstance(block.get("Confidence"), (int, float))]
pages = sorted({block.get("Page") for block in blocks if block.get("Page")})

def child_ids(block):
    ids = []
    for relationship in block.get("Relationships", []):
        if relationship.get("Type") == "CHILD":
            ids.extend(relationship.get("Ids", []))
    return ids

def text_for(block):
    parts = []
    for child_id in child_ids(block):
        child = by_id.get(child_id)
        if not child:
            continue
        if child.get("BlockType") == "WORD":
            parts.append(child.get("Text", ""))
        elif child.get("BlockType") == "SELECTION_ELEMENT":
            parts.append(f"[{child.get('SelectionStatus', 'UNKNOWN')}]")
    return " ".join(part for part in parts if part).strip()

def redact(text):
    if not isinstance(text, str):
        return text
    text = re.sub(r"\b\d{3}-\d{2}-\d{4}\b", "[REDACTED-SSN]", text)
    text = re.sub(r"\b\d{2}-\d{7}\b", "[REDACTED-EIN]", text)
    return text

key_values = []
for block in blocks:
    if block.get("BlockType") != "KEY_VALUE_SET":
        continue
    if "KEY" not in block.get("EntityTypes", []):
        continue

    key_text = text_for(block)
    value_texts = []
    for relationship in block.get("Relationships", []):
        if relationship.get("Type") != "VALUE":
            continue
        for value_id in relationship.get("Ids", []):
            value = by_id.get(value_id)
            if value:
                value_texts.append(text_for(value))

    key_values.append({
        "page": block.get("Page"),
        "key": redact(key_text),
        "value": redact(" ".join(value_texts).strip()),
        "confidence": block.get("Confidence"),
        "blockId": block.get("Id"),
    })

tables = []
for block in blocks:
    if block.get("BlockType") != "TABLE":
        continue
    cells = [by_id.get(cell_id) for cell_id in child_ids(block)]
    cells = [cell for cell in cells if cell and cell.get("BlockType") == "CELL"]
    tables.append({
        "page": block.get("Page"),
        "confidence": block.get("Confidence"),
        "cellCount": len(cells),
        "rows": max([cell.get("RowIndex", 0) for cell in cells] or [0]),
        "columns": max([cell.get("ColumnIndex", 0) for cell in cells] or [0]),
        "blockId": block.get("Id"),
    })

selection_elements = [
    {
        "page": block.get("Page"),
        "status": block.get("SelectionStatus"),
        "confidence": block.get("Confidence"),
        "blockId": block.get("Id"),
    }
    for block in blocks
    if block.get("BlockType") == "SELECTION_ELEMENT"
]

summary = {
    "pdf": os.path.basename(pdf_path),
    "region": region,
    "bucket": bucket,
    "s3Key": key,
    "jobId": job_id,
    "pageCount": len(pages),
    "blockCount": len(blocks),
    "blockTypeCounts": dict(sorted(counts.items())),
    "confidence": {
        "min": min(confidences) if confidences else None,
        "avg": statistics.fmean(confidences) if confidences else None,
        "median": statistics.median(confidences) if confidences else None,
    },
    "keyValueCount": len(key_values),
    "tableCount": len(tables),
    "selectionElementCount": len(selection_elements),
    "sampleKeyValues": key_values[:40],
    "sampleTables": tables[:20],
    "sampleSelectionElements": selection_elements[:30],
}

with open(os.path.join(out_dir, "summary.json"), "w", encoding="utf-8") as handle:
    json.dump(summary, handle, indent=2)

print(json.dumps(summary, indent=2))
PY

echo "Wrote spike output to: $OUT_DIR"
