#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  echo "Usage: download-media.sh <media.json> <output-root> [concurrency]" >&2
}

if [[ $# -lt 2 || $# -gt 3 ]]; then
  usage
  exit 2
fi

manifest_path=$1
output_root=$2
concurrency=${3:-8}
metadata_dir="$output_root/metadata"
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
worker_script="$script_dir/download-media-worker.mjs"
private_tree_script="$script_dir/private-tree.mjs"

if [[ ! -f "$manifest_path" ]]; then
  echo "Media manifest not found: $manifest_path" >&2
  exit 1
fi

if [[ ! "$concurrency" =~ ^[0-9]+$ ]] ||
  [[ "$concurrency" -lt 1 ]] ||
  [[ "$concurrency" -gt 32 ]]; then
  echo "Concurrency must be an integer from 1 through 32" >&2
  exit 2
fi

for required_command in node jq curl xargs shasum file sips find grep; do
  command -v "$required_command" >/dev/null || {
    echo "$required_command is required" >&2
    exit 1
  }
done

node "$private_tree_script" harden "$output_root" >/dev/null
expected_count=$(node "$worker_script" validate "$manifest_path" "$output_root")

if ! jq -j 'range(0; length) | tostring, "\u0000"' "$manifest_path" |
  xargs -0 -n 32 -P "$concurrency" \
    node "$worker_script" download "$manifest_path" "$output_root"; then
  echo "One or more media downloads failed; resumable .part files were retained when present" >&2
  exit 1
fi

missing_count=0
while IFS= read -r relative_path; do
  if [[ ! -s "$output_root/$relative_path" ]]; then
    echo "Missing or empty media file: $relative_path" >&2
    missing_count=$((missing_count + 1))
  fi
done < <(jq -r '.[].relativePath' "$manifest_path")

partial_count=0
for media_root in \
  "$output_root/photos" \
  "$output_root/videos" \
  "$output_root/files" \
  "$output_root/message-images" \
  "$output_root/messages/attachments"; do
  while IFS= read -r _part_path; do
    partial_count=$((partial_count + 1))
  done < <(find "$media_root" -type f -name '*.part')
done

if [[ "$missing_count" -ne 0 || "$partial_count" -ne 0 ]]; then
  actual_count=$((expected_count - missing_count))
  echo "Validation failed: expected=$expected_count actual=$actual_count partials=$partial_count" >&2
  exit 1
fi

mime_failures=0
while IFS=$'\t' read -r relative_path expected_mime; do
  actual_mime=$(file -b --mime-type "$output_root/$relative_path")
  case "$expected_mime:$actual_mime" in
    image/jpeg:image/jpeg | \
      image/png:image/png | \
      image/gif:image/gif | \
      image/webp:image/webp | \
      image/heic:image/heic | \
      image/heic:image/heif | \
      image/heif:image/heic | \
      image/heif:image/heif | \
      video/mp4:video/mp4 | \
      video/mp4:video/x-m4v | \
      video/mp4:application/mp4 | \
      application/pdf:application/pdf)
      ;;
    *)
      echo "Unexpected media type: $relative_path ($actual_mime; expected $expected_mime)" >&2
      mime_failures=$((mime_failures + 1))
      ;;
  esac
done < <(jq -r '.[] | [.relativePath, .expectedMime] | @tsv' "$manifest_path")

if [[ "$mime_failures" -ne 0 ]]; then
  echo "MIME validation failed for $mime_failures file(s)" >&2
  exit 1
fi

image_decoder_failures=0
while IFS= read -r relative_path; do
  if ! sips -g pixelWidth -g pixelHeight "$output_root/$relative_path" >/dev/null; then
    echo "Image decoder validation failed: $relative_path" >&2
    image_decoder_failures=$((image_decoder_failures + 1))
  fi
done < <(
  jq -r '
    .[]
    | select(
        .expectedMime == "image/jpeg" or
        .expectedMime == "image/png" or
        .expectedMime == "image/gif" or
        .expectedMime == "image/webp" or
        .expectedMime == "image/heic" or
        .expectedMime == "image/heif"
      )
    | .relativePath
  ' "$manifest_path"
)

if [[ "$image_decoder_failures" -ne 0 ]]; then
  echo "Image decoder validation failed for $image_decoder_failures file(s)" >&2
  exit 1
fi

checksums_tmp="$metadata_dir/media-checksums.sha256.tmp"
(
  cd "$output_root"
  while IFS= read -r relative_path; do
    shasum -a 256 "$relative_path"
  done < <(jq -r '.[].relativePath' "$manifest_path" | LC_ALL=C sort)
) >"$checksums_tmp"
mv "$checksums_tmp" "$metadata_dir/media-checksums.sha256"
chmod 600 "$metadata_dir/media-checksums.sha256"

total_bytes=0
while IFS= read -r relative_path; do
  file_bytes=$(wc -c <"$output_root/$relative_path" | tr -d ' ')
  total_bytes=$((total_bytes + file_bytes))
done < <(jq -r '.[].relativePath' "$manifest_path")

summary_path="$metadata_dir/export-summary.json"
if [[ -f "$summary_path" ]]; then
  summary_tmp="$summary_path.tmp"
  jq \
    --argjson downloaded "$expected_count" \
    --argjson partials "$partial_count" \
    --argjson bytes "$total_bytes" '
      .validation.downloadedMedia = $downloaded
      | .validation.partialDownloads = $partials
      | .validation.totalBytes = $bytes
      | .validation.mimeValidation = "passed"
      | .validation.imageDecoderValidation = "passed with sips"
      | .validation.signatureValidation = (
          "passed with file MIME/signature identification; " +
          "MP4 and PDF validation is signature-level only, not a deep parse"
        )
      | .validation.checksums = "metadata/media-checksums.sha256"
    ' "$summary_path" >"$summary_tmp"
  mv "$summary_tmp" "$summary_path"
  chmod 600 "$summary_path"
fi

credential_marker_files=()
while IFS= read -r generated_path; do
  if grep -EIl 'x-famly-accesstoken|famly\.session-marker' "$generated_path" >/dev/null; then
    credential_marker_files+=("$generated_path")
  fi
done < <(
  find "$metadata_dir" "$output_root/messages" \
    -type f \
    \( -name '*.json' -o -name '*.html' -o -name '*.mjs' -o -name '*.sha256' \)
)

if [[ "${#credential_marker_files[@]}" -ne 0 ]]; then
  echo "Credential marker found in generated artifact(s):" >&2
  printf '%s\n' "${credential_marker_files[@]}" >&2
  exit 1
fi

node "$private_tree_script" harden "$output_root" >/dev/null

printf 'expected=%s\nactual=%s\npartials=%s\nbytes=%s\nmime=%s\nimages=%s\nsignature=%s\nchecksums=%s\n' \
  "$expected_count" \
  "$expected_count" \
  "$partial_count" \
  "$total_bytes" \
  "passed" \
  "passed with sips" \
  "MP4/PDF signature-level only" \
  "$metadata_dir/media-checksums.sha256"
