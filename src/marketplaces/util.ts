// Small marketplace-agnostic helpers shared by adapters.

/** Last meaningful path segment of a URL, sanitized for use as a download
 *  filename (lowercase/uppercase latin, digits, hyphen, underscore). */
export function productSlugFromUrl(url: string): string {
  try {
    const last =
      new URL(url).pathname.split("/").filter(Boolean).pop() || "product";
    return last.replace(/[^a-z0-9-_]/gi, "_").slice(0, 60);
  } catch {
    return "product";
  }
}
