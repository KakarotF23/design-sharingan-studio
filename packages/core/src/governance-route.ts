const ENCODED_SEPARATOR = /%(?:2f|3f|23|5c)/i;
const ENCODED_OCTET = /%[0-9a-f]{2}/i;
const MAX_DECODE_PASSES = 4;

export function normalizeGovernanceRoute(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error("Governance route must be a bounded string");
  }
  if (ENCODED_SEPARATOR.test(value)) {
    throw new Error("Governance route contains an encoded reserved separator");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error("Governance route must use valid encoding");
  }
  for (let pass = 1; pass < MAX_DECODE_PASSES; pass += 1) {
    if (ENCODED_SEPARATOR.test(decoded)) {
      throw new Error("Governance route contains a recursively encoded reserved separator");
    }
    if (!ENCODED_OCTET.test(decoded)) break;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      throw new Error("Governance route must use valid recursive encoding");
    }
  }
  if (ENCODED_SEPARATOR.test(decoded) || ENCODED_OCTET.test(decoded)) {
    throw new Error("Governance route exceeds the bounded encoding depth");
  }
  const normalized = decoded.normalize("NFC");
  if (
    !normalized.startsWith("/") || normalized.includes("\\") ||
    normalized.includes("?") || normalized.includes("#") || normalized.includes("//") ||
    /[\u0000-\u001f\u007f]/.test(normalized) ||
    normalized.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("Governance route must be a safe normalized route");
  }
  return encodeURI(normalized);
}
