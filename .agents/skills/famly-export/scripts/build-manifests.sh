#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: build-manifests.sh <captured-feed-pages.json> <output-root>" >&2
}

if [[ $# -ne 2 ]]; then
  usage
  exit 2
fi

capture_path=$1
output_root=$2
metadata_dir="$output_root/metadata"

if [[ ! -f "$capture_path" ]]; then
  echo "Capture file not found: $capture_path" >&2
  exit 1
fi

command -v jq >/dev/null || {
  echo "jq is required" >&2
  exit 1
}

mkdir -p "$metadata_dir"

posts_tmp="$metadata_dir/posts.json.tmp"
photos_tmp="$metadata_dir/photos.json.tmp"
summary_tmp="$metadata_dir/export-summary.json.tmp"

cleanup() {
  rm -f "$posts_tmp" "$photos_tmp" "$summary_tmp"
}
trap cleanup EXIT

jq -e '
  type == "object" and
  (.feedPages | type == "array") and
  (.feedPages | length > 0) and
  all(.feedPages[]; (.data.feedItems | type == "array"))
' "$capture_path" >/dev/null || {
  echo "Capture JSON does not contain the expected feedPages response bodies" >&2
  exit 1
}

jq '
  [.feedPages[].data.feedItems[]]
  | unique_by(.feedItemId)
  | sort_by(.createdDate)
  | reverse
' "$capture_path" >"$posts_tmp"

post_count=$(jq 'length' "$posts_tmp")
dom_post_count=$(jq -r '.domPostLinks // 0' "$capture_path")
reported_unique_count=$(jq -r '.uniqueFeedItems // 0' "$capture_path")

if [[ "$post_count" -eq 0 ]]; then
  echo "The capture contains no posts" >&2
  exit 1
fi

if [[ "$reported_unique_count" -gt 0 && "$post_count" -ne "$reported_unique_count" ]]; then
  echo "Captured unique-post mismatch: manifest=$post_count capture=$reported_unique_count" >&2
  exit 1
fi

if [[ "$dom_post_count" -gt 0 && "$post_count" -ne "$dom_post_count" ]]; then
  echo "Incomplete capture: API posts=$post_count DOM post links=$dom_post_count" >&2
  exit 1
fi

jq '
  [
    .[] as $post
    | ($post.images // [])[]
    | . as $image
    | ($image.key | split("?")[0] | split(".")[-1] | ascii_downcase) as $extension
    | {
        imageId: $image.imageId,
        feedItemId: $post.feedItemId,
        postCreatedDate: $post.createdDate,
        imageCreatedDate: ($image.createdAt.date // null),
        width: $image.width,
        height: $image.height,
        sourceUrl: (
          "\($image.prefix)/\($image.width)x\($image.height)/\($image.key)"
        ),
        relativePath: (
          "photos/\($post.createdDate[0:4])/" +
          "\($post.createdDate[0:10])_\($post.feedItemId)_" +
          "\($image.imageId).\($extension)"
        )
      }
  ]
  | unique_by(.imageId)
  | sort_by(.postCreatedDate, .imageId)
  | reverse
' "$posts_tmp" >"$photos_tmp"

jq -n \
  --slurpfile capture "$capture_path" \
  --slurpfile posts "$posts_tmp" \
  --slurpfile photos "$photos_tmp" '
    ($capture[0]) as $captureData
    | ($posts[0]) as $postData
    | ($photos[0]) as $photoData
    | {
        capturedAt: $captureData.capturedAt,
        captureStartedAt: $captureData.captureStartedAt,
        pageUrl: $captureData.pageUrl,
        feedPages: $captureData.capturedFeedPages,
        domPostLinks: $captureData.domPostLinks,
        posts: ($postData | length),
        oldestPost: ($postData | map(.createdDate) | min),
        newestPost: ($postData | map(.createdDate) | max),
        postsWithImages: (
          $postData | map(select((.images // []) | length > 0)) | length
        ),
        uniquePhotos: ($photoData | length),
        videosReferenced: (
          $postData | map(.videos // []) | flatten | length
        ),
        filesReferenced: (
          $postData | map(.files // []) | flatten | length
        ),
        downloadedPhotos: 0,
        partialDownloads: 0,
        decoderValidation: "not-run"
      }
  ' >"$summary_tmp"

if grep -EIl 'x-famly-accesstoken|famly\.session-marker' \
  "$capture_path" "$posts_tmp" "$photos_tmp" >/dev/null; then
  echo "Credential marker found in generated response-body artifacts" >&2
  exit 1
fi

mv "$posts_tmp" "$metadata_dir/posts.json"
mv "$photos_tmp" "$metadata_dir/photos.json"
mv "$summary_tmp" "$metadata_dir/export-summary.json"

trap - EXIT

jq . "$metadata_dir/export-summary.json"
