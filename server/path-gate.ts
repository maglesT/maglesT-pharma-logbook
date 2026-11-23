// Path gate (pen test PH-01): the API check is made on the DECODED path, so no encoding trick (%61pi, /API, backslashes)
// can skip the JSON-only and sign-in handling in the onRequest hook.

/** True when the request path is an API path, judged on the decoded path. An undecodable path counts as API (strict side). */
export function isApiUrl(url: string): boolean {
  let p = url.split('?')[0]!;
  try { p = decodeURIComponent(p); } catch { return true; }
  return /^[\\/]+api([\\/]|$)/i.test(p);
}

/** A path with a percent-encoded unreserved character (letter, digit, - . _ ~) is never sent by our screens: refused. */
export const hasEncodedUnreserved = (url: string): boolean =>
  /%(?:3\d|4[1-9A-F]|5[0-9AF]|6[1-9A-F]|7[0-9AE]|2[DE])/i.test(url.split('?')[0]!);
