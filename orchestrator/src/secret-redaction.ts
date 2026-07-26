export function redactSensitiveText(
  value: string | Buffer | null | undefined,
  source: Readonly<Record<string, string | undefined>> = process.env,
): string {
  let text = String(value ?? "");
  for (const [key, secret] of Object.entries(source)) {
    if (!secret || secret.length < 6) continue;
    if (!/(?:api.?key|token|secret|password|credential|authorization|cookie|proxy)/i.test(key)) continue;
    text = text.split(secret).join("[REDACTED]");
  }
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gi, "[REDACTED]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
      "[REDACTED]",
    )
    .replace(/((?:authorization\s*[:=]\s*)?bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(/((?:set-)?cookie\s*[:=]\s*)[^\r\n]+/gi, "$1[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(
      /((?:api[_-]?key|secret[_-]?key|password|credential|authorization|(?:(?:access|refresh|id)[_-]?)?token)\s*[:=]\s*)[^\s,;&]+/gi,
      "$1[REDACTED]",
    );
}
