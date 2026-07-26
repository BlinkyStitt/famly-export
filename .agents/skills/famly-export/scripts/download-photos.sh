#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: download-photos.sh <photos.json> <output-root> [concurrency]" >&2
}

if [[ $# -lt 2 || $# -gt 3 ]]; then
  usage
  exit 2
fi

manifest_path=$1
output_root=$2
concurrency=${3:-8}
metadata_dir="$output_root/metadata"
photo_root="$output_root/photos"

if [[ ! -f "$manifest_path" ]]; then
  echo "Photo manifest not found: $manifest_path" >&2
  exit 1
fi

if [[ ! "$concurrency" =~ ^[0-9]+$ ]] ||
  [[ "$concurrency" -lt 1 ]] ||
  [[ "$concurrency" -gt 32 ]]; then
  echo "Concurrency must be an integer from 1 through 32" >&2
  exit 2
fi

for required_command in jq curl xargs shasum file sips; do
  command -v "$required_command" >/dev/null || {
    echo "$required_command is required" >&2
    exit 1
  }
done

mkdir -p "$metadata_dir" "$photo_root"

jq -e '
  type == "array" and
  length > 0 and
  all(.[];
    (.imageId | type == "string") and
    (.sourceUrl | startswith("https://img.famly.co/")) and
    (
      .relativePath
      | test("^photos/[0-9]{4}/[0-9A-Za-z._-]+\\.(jpg|jpeg|png|gif)$")
    )
  )
' "$manifest_path" >/dev/null || {
  echo "Photo manifest failed URL or path validation" >&2
  exit 1
}

# The snippet runs in each child shell; expansion must happen there.
# shellcheck disable=SC2016
download_one='
  photo_url=$1
  photo_path=$2
  mkdir -p "$(dirname "$photo_path")"
  if [[ ! -s "$photo_path" ]]; then
    curl \
      --fail \
      --location \
      --silent \
      --show-error \
      --retry 3 \
      --retry-all-errors \
      --connect-timeout 15 \
      --max-time 180 \
      --output "$photo_path.part" \
      "$photo_url" &&
      mv "$photo_path.part" "$photo_path"
  fi
'

if ! jq -j --arg root "$output_root" '
  .[]
  | .sourceUrl, "\u0000", ($root + "/" + .relativePath), "\u0000"
' "$manifest_path" |
  xargs -0 -n 2 -P "$concurrency" bash -c "$download_one" _; then
  echo "One or more photo downloads failed; partial files were retained" >&2
  exit 1
fi

expected_count=$(jq 'length' "$manifest_path")
missing_count=0

while IFS= read -r relative_path; do
  if [[ ! -s "$output_root/$relative_path" ]]; then
    echo "Missing photo: $relative_path" >&2
    missing_count=$((missing_count + 1))
  fi
done < <(jq -r '.[].relativePath' "$manifest_path")

partial_count=$(find "$photo_root" -type f -name '*.part' | wc -l | tr -d ' ')
actual_count=$((expected_count - missing_count))

if [[ "$missing_count" -ne 0 || "$partial_count" -ne 0 ]]; then
  echo "Validation failed: expected=$expected_count actual=$actual_count partials=$partial_count" >&2
  exit 1
fi

mime_failures=0
while IFS=$'\t' read -r relative_path extension; do
  mime_type=$(file -b --mime-type "$output_root/$relative_path")
  case "$extension:$mime_type" in
    jpg:image/jpeg | jpeg:image/jpeg | png:image/png | gif:image/gif)
      ;;
    *)
      echo "Unexpected photo type: $relative_path ($mime_type)" >&2
      mime_failures=$((mime_failures + 1))
      ;;
  esac
done < <(
  jq -r '
    .[]
    | [
        .relativePath,
        (.relativePath | split(".")[-1] | ascii_downcase)
      ]
    | @tsv
  ' "$manifest_path"
)

if [[ "$mime_failures" -ne 0 ]]; then
  echo "Photo type validation failed for $mime_failures file(s)" >&2
  exit 1
fi

decodable_count=$(jq '
  [
    .[]
    | select(
        (.relativePath | ascii_downcase | endswith(".jpg")) or
        (.relativePath | ascii_downcase | endswith(".jpeg")) or
        (.relativePath | ascii_downcase | endswith(".png"))
      )
  ]
  | length
' "$manifest_path")

if [[ "$decodable_count" -gt 0 ]]; then
  jq -j --arg root "$output_root" '
    .[]
    | select(
        (.relativePath | ascii_downcase | endswith(".jpg")) or
        (.relativePath | ascii_downcase | endswith(".jpeg")) or
        (.relativePath | ascii_downcase | endswith(".png"))
      )
    | ($root + "/" + .relativePath), "\u0000"
  ' "$manifest_path" |
    xargs -0 -n 1 -P "$concurrency" \
      sips -g pixelWidth -g pixelHeight >/dev/null
fi

decoder_status="passed (JPEG/PNG decoded; GIF type validated)"

checksums_tmp="$metadata_dir/photo-checksums.sha256.tmp"
(
  cd "$output_root"
  jq -r '.[].relativePath' "$manifest_path" |
    LC_ALL=C sort |
    xargs -n 50 shasum -a 256
) >"$checksums_tmp"
mv "$checksums_tmp" "$metadata_dir/photo-checksums.sha256"

summary_path="$metadata_dir/export-summary.json"
if [[ -f "$summary_path" ]]; then
  summary_tmp="$summary_path.tmp"
  jq \
    --argjson downloaded "$actual_count" \
    --argjson partials "$partial_count" \
    --arg decoder "$decoder_status" '
      .downloadedPhotos = $downloaded
      | .partialDownloads = $partials
      | .decoderValidation = $decoder
    ' "$summary_path" >"$summary_tmp"
  mv "$summary_tmp" "$summary_path"
fi

size=$(du -sh "$photo_root" | awk '{print $1}')
printf 'expected=%s\nactual=%s\npartials=%s\ndecoder=%s\nsize=%s\nchecksums=%s\n' \
  "$expected_count" \
  "$actual_count" \
  "$partial_count" \
  "$decoder_status" \
  "$size" \
  "$metadata_dir/photo-checksums.sha256"
