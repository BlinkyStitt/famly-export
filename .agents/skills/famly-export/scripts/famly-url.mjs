export const KILLSWITCH_URL =
  "https://famly-killswitch.s3.eu-central-1.amazonaws.com/killswitch";

export const APPROVED_FAMLY_MEDIA_HOSTS = new Set([
  "img.famly.co",
  "famly-de.s3.eu-central-1.amazonaws.com",
  "famly-video-storage.s3.eu-central-1.amazonaws.com",
]);

export function validateFamlyMediaUrl(value) {
  if (
    typeof value !== "string" ||
    !/^[\x21-\x7e]+$/.test(value) ||
    /["\\]/.test(value)
  ) {
    throw new Error("Media URL contains unsafe or non-visible characters");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Media URL is invalid");
  }
  if (url.href === KILLSWITCH_URL) {
    throw new Error("The prohibited Famly killswitch URL was rejected locally");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.hash ||
    !APPROVED_FAMLY_MEDIA_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw new Error("Media URL is not an approved HTTPS Famly URL");
  }
  return url.href;
}
