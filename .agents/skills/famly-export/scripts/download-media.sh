#!/usr/bin/env bash
set -euo pipefail

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

for required_command in jq curl xargs shasum file sips find grep; do
  command -v "$required_command" >/dev/null || {
    echo "$required_command is required" >&2
    exit 1
  }
done

mkdir -p \
  "$metadata_dir" \
  "$output_root/photos" \
  "$output_root/videos" \
  "$output_root/files" \
  "$output_root/message-images" \
  "$output_root/messages/attachments"

jq -e '
  type == "array" and
  length > 0 and
  all(.[];
    (.mediaId | type == "string" and length > 0) and
    (.sourceType == "home" or .sourceType == "message") and
    (.ownerType == "post" or .ownerType == "message") and
    (.kind == "image" or .kind == "video" or .kind == "file") and
    (.sourceUrl | type == "string") and
    (
      .sourceUrl
      | test(
          "^https://([^/?]+\\.)?famly\\.co/" +
          "|^https://famly[-.][A-Za-z0-9.-]*\\.amazonaws\\.com/"
        )
    ) and
    (.sourceUrl | contains("famly-killswitch.s3.eu-central-1.amazonaws.com/killswitch") | not) and
    (.relativePath | type == "string") and
    (
      .relativePath
      | test("^(photos|videos|files|message-images|messages/attachments)/")
    ) and
    (
      (
        .sourceType == "home" and
        .kind == "image" and
        (.relativePath | test("^photos/[^/]+$"))
      ) or
      (
        .sourceType == "message" and
        .kind == "image" and
        (.relativePath | test("^message-images/[^/]+$"))
      ) or
      (.kind != "image")
    ) and
    (.relativePath | contains("\\") | not) and
    (.relativePath | test("[[:cntrl:]]") | not) and
    (.relativePath | test("(^|/)\\.\\.(/|$)") | not) and
    (
      .expectedMime
      | IN(
          "image/jpeg",
          "image/png",
          "image/gif",
          "image/webp",
          "image/heic",
          "image/heif",
          "video/mp4",
          "application/pdf"
        )
    )
  ) and
  ((map(.relativePath) | unique | length) == length)
' "$manifest_path" >/dev/null || {
  echo "Media manifest failed URL, MIME, uniqueness, or safe-path validation" >&2
  exit 1
}

# This snippet runs in child shells. Arguments are passed as NUL-delimited
# values so spaces and punctuation in safe filenames are preserved.
# shellcheck disable=SC2016
download_one='
  source_url=$1
  target_path=$2
  part_path="${target_path}.part"
  mkdir -p "$(dirname "$target_path")"
  if [[ -s "$target_path" ]]; then
    exit 0
  fi
  curl_args=(
    --fail
    --location
    --silent
    --show-error
    --retry 3
    --retry-all-errors
    --connect-timeout 15
    --max-time 300
    --output "$part_path"
  )
  if [[ -s "$part_path" ]]; then
    curl_args+=(--continue-at -)
  fi
  curl "${curl_args[@]}" "$source_url"
  mv "$part_path" "$target_path"
'

if ! jq -j --arg root "$output_root" '
  .[]
  | .sourceUrl, "\u0000", ($root + "/" + .relativePath), "\u0000"
' "$manifest_path" |
  xargs -0 -n 2 -P "$concurrency" bash -c "$download_one" _; then
  echo "One or more media downloads failed; resumable .part files were retained" >&2
  exit 1
fi

expected_count=$(jq 'length' "$manifest_path")
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
fi

credential_marker_files=()
while IFS= read -r generated_path; do
  if grep -EIl 'x-famly-accesstoken|famly\.session-marker' "$generated_path" >/dev/null; then
    credential_marker_files+=("$generated_path")
  fi
done < <(
  find "$metadata_dir" "$output_root/messages" \
    -type f \
    \( -name '*.json' -o -name '*.html' -o -name '*.sha256' \)
)

if [[ "${#credential_marker_files[@]}" -ne 0 ]]; then
  echo "Credential marker found in generated artifact(s):" >&2
  printf '%s\n' "${credential_marker_files[@]}" >&2
  exit 1
fi

printf 'expected=%s\nactual=%s\npartials=%s\nbytes=%s\nmime=%s\nimages=%s\nsignature=%s\nchecksums=%s\n' \
  "$expected_count" \
  "$expected_count" \
  "$partial_count" \
  "$total_bytes" \
  "passed" \
  "passed with sips" \
  "MP4/PDF signature-level only" \
  "$metadata_dir/media-checksums.sha256"
