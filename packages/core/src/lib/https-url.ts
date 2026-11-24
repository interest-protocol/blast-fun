function boundedString(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new TypeError("Expected a bounded non-empty string.");
  }
  return value;
}

/** An absolute https URL without credentials, in its normalized form. */
export function parseHttpsUrl(value: unknown, maxLength: number): string {
  const text = boundedString(value, maxLength);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError("Invalid URL.");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password
  ) {
    throw new TypeError("Only https URLs without credentials are accepted.");
  }
  if (url.href.length > maxLength) throw new TypeError("URL is too long.");
  return url.href;
}
