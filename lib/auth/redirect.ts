export const guardianContactPath = "/modules/profile?view=guardian";
export const guardianEmailContinuation = `${guardianContactPath}&contact=email`;

const defaultRedirect = "/dashboard";
const internalOrigin = "https://internal.invalid";
const encodedByte = /%[\da-f]{2}/i;

function isInternalPath(value: string) {
  return value.startsWith("/")
    && !value.startsWith("//")
    && !value.includes("\\")
    && !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    });
}

/** Keep auth redirects on an internal path, including after URL decoding. */
export function safeAuthRedirect(next: string | null): string {
  if (!next || !isInternalPath(next)) return defaultRedirect;

  let pathname = next.split(/[?#]/, 1)[0];

  // Check nested encoding too, without changing legitimate encoded route names.
  for (let depth = 0; depth < 5; depth += 1) {
    if (!isInternalPath(pathname)) return defaultRedirect;
    const normalized = new URL(pathname, internalOrigin);
    if (normalized.origin !== internalOrigin || !isInternalPath(normalized.pathname)) {
      return defaultRedirect;
    }
    if (!encodedByte.test(pathname)) break;

    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      return defaultRedirect;
    }
    if (depth === 4 && encodedByte.test(pathname)) return defaultRedirect;
  }

  if (!isInternalPath(pathname)) return defaultRedirect;
  const destination = new URL(next, internalOrigin);
  if (destination.origin !== internalOrigin || !isInternalPath(destination.pathname)) {
    return defaultRedirect;
  }
  return `${destination.pathname}${destination.search}${destination.hash}`;
}
