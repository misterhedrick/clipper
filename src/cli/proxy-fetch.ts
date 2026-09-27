// Node's own fetch ignores HTTPS_PROXY; undici's agent honours it and NO_PROXY.
// Imported lazily: loading the undici package replaces Node's global dispatcher,
// after which the built-in fetch stops decoding gzip bodies (Drive listings
// arrive as binary). Only CLI paths that make no other requests load it.
export async function proxiedFetch(): Promise<typeof fetch> {
  const { EnvHttpProxyAgent, fetch: undiciFetch } = await import("undici");
  const dispatcher = new EnvHttpProxyAgent();
  return ((input: string | URL, init?: RequestInit) => undiciFetch(input as string, { ...(init as object), dispatcher } as never)) as unknown as typeof fetch;
}
