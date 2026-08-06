#!/usr/bin/env bash
# One-shot: sets bucket-level CORS on the default bucket once Garage is reachable.
#
# There is no `garage bucket cors` CLI subcommand (checked: `garage bucket --help`
# lists alias/allow/create/delete/deny/info/inspect-object/list/set-quotas/unalias/
# website -- no cors). CORS is an S3-API-only operation (PutBucketCors), so this
# talks to the S3 endpoint directly instead of shelling out to the garage binary.
#
# Two rules, matching the spec exactly: GET for the browser origin (Log/Artifact
# reads), PUT for the Runner origin (Runner-initiated uploads via presigned URL).
set -euo pipefail

CORS_JSON=$(cat <<JSON
{
  "CORSRules": [
    {
      "AllowedOrigins": ["${WEB_ORIGIN}"],
      "AllowedMethods": ["GET"],
      "AllowedHeaders": ["*"],
      "MaxAgeSeconds": 3000
    },
    {
      "AllowedOrigins": ["${RUNNER_ORIGIN}"],
      "AllowedMethods": ["PUT"],
      "AllowedHeaders": ["*"],
      "MaxAgeSeconds": 3000
    }
  ]
}
JSON
)

aws --endpoint-url "$GARAGE_S3_ENDPOINT" s3api put-bucket-cors \
  --bucket "$GARAGE_DEFAULT_BUCKET" \
  --cors-configuration "$CORS_JSON"

echo "garage-init: CORS set on bucket ${GARAGE_DEFAULT_BUCKET} (GET <- ${WEB_ORIGIN}, PUT <- ${RUNNER_ORIGIN})"
