import crypto from "node:crypto";
import { config } from "../config.js";

// ---- passwords (scrypt) ----
export const hashPassword = (pw: string) => {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pw, salt, 64).toString("hex");
  return `${salt}:${hash}`;
};

export const verifyPassword = (pw: string, stored: string) => {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64).toString("hex");
  const a = Buffer.from(test, "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// ---- signed admin session cookie (HMAC) ----
export const signSession = (email: string) => {
  const body = Buffer.from(
    JSON.stringify({ email, exp: Date.now() + 12 * 3600 * 1000 }),
  ).toString("base64url");
  const sig = crypto
    .createHmac("sha256", config.admin.sessionSecret)
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
};

export const verifySession = (token?: string): string | null => {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expect = crypto
    .createHmac("sha256", config.admin.sessionSecret)
    .update(body)
    .digest("base64url");
  if (
    sig.length !== expect.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))
  )
    return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString());
    if (data.exp < Date.now()) return null;
    return data.email as string;
  } catch {
    return null;
  }
};

// ---- API keys ----
export const sha256 = (s: string) =>
  crypto.createHash("sha256").update(s).digest("hex");

export const generateApiKey = () => {
  const raw = `fc_live_${crypto.randomBytes(24).toString("base64url")}`;
  return { key: raw, prefix: raw.slice(0, 16), hash: sha256(raw) };
};
