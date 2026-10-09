// Checks that a `data:` URL really carries a raster image of the type it claims.
//
// The avatar and the physique-goal photo are stored as data URLs and rendered back as
// <img src>. The avatar endpoint used to check only the length and the goal photo only the
// `data:image/` prefix, so any string - `data:text/html,...`, `data:image/svg+xml` with a
// script inside, or plain garbage - was stored as "the photo" (audit 2026-10-09, B-N2). The
// CSP and the fact that only the owner sees their own avatar limit what that buys, but there
// is no reason to store bytes no browser will decode as the picture they claim to be.
//
// Three checks, all cheap: a MIME type from a short allowlist (the frontend always re-encodes
// through a canvas to JPEG, so this is generous), a well-formed base64 payload, and the magic
// bytes of the decoded header matching that MIME type. SVG is deliberately absent - it is a
// document format that can carry script, not a raster image.

const SIGNATURES = {
  'image/jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  'image/webp': (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  'image/gif': (b) => b.length >= 6 && (b.toString('ascii', 0, 6) === 'GIF87a' || b.toString('ascii', 0, 6) === 'GIF89a')
};

const DATA_URL_REGEX = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/]+={0,2})$/;

function isImageDataUrl(value) {
  if (typeof value !== 'string') return false;
  const match = DATA_URL_REGEX.exec(value);
  if (!match) return false;
  const check = SIGNATURES[match[1]];
  if (!check) return false;
  // 16 base64 characters decode to 12 bytes - enough for the longest signature above.
  const header = Buffer.from(match[2].slice(0, 16), 'base64');
  return check(header);
}

module.exports = { isImageDataUrl };
