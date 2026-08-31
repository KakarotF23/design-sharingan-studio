const ENCODED_SEPARATOR = /%(?:2f|3f|23|5c)/i;

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
