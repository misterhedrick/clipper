import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// v1 reviewer auth: one shared REVIEWER_TOKEN, plus the reviewer's name so every
// decision is attributed (`reviewer:<name>`). Signing in sets an HMAC-signed,
// HttpOnly, SameSite=Strict session cookie keyed on the token, so rotating
// REVIEWER_TOKEN signs everyone out.

export const SESSION_COOKIE = "clipper_session";
export const SESSION_HOURS = 12;
export const REVIEWER_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/i;

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time comparison of a submitted token with the configured one. */
export function tokenMatches(submitted: string, expected: string): boolean {
  return timingSafeEqual(digest(submitted), digest(expected));
}

const sign = (secret: string, payload: string) => createHmac("sha256", secret).update(payload).digest("base64url");

export function createSession(secret: string, name: string, now = new Date()): string {
  const payload = `${Buffer.from(name).toString("base64url")}.${Math.floor(now.getTime() / 1000) + SESSION_HOURS * 3600}`;
  return `${payload}.${sign(secret, payload)}`;
}

/** The reviewer's name if the cookie value is authentic and unexpired, else null. */
export function verifySession(secret: string, value: string | undefined, now = new Date()): string | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [nameB64, exp, mac] = parts as [string, string, string];
  const expected = Buffer.from(sign(secret, `${nameB64}.${exp}`));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (!/^\d+$/.test(exp) || Number(exp) * 1000 < now.getTime()) return null;
  const name = Buffer.from(nameB64, "base64url").toString("utf8");
  return REVIEWER_NAME.test(name) ? name : null;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function sessionCookie(value: string, maxAgeSec = SESSION_HOURS * 3600): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;
}
