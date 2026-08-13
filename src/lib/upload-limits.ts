/**
 * Upload limits, in a module with no server-only imports so the browser can
 * check them before spending a round-trip — and so there is one copy.
 *
 * ImageInput.tsx used to carry its own MAX_BYTES with a "keep in sync with the
 * /api/media-upload route" comment, which is a rule a person has to remember.
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

/** Content type → file extension. The keys double as the `accept` allowlist. */
export const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export const IMAGE_ACCEPT_ATTR = Object.keys(ALLOWED_IMAGE_TYPES).join(",");
