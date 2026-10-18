import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Chat image URLs carry `?s=` = first 22 chars of base64url HMAC-SHA256(VIZ_SECRET,
 * "{projectId}/{file}"). backend/fetch/viz.py builds the same signature.
 */

export const vizSig = (secret: string, path: string) => createHmac("sha256", secret).update(path).digest("base64url").slice(0, 22);

/** Dev with VIZ_SECRET unset accepts unsigned requests; production without it refuses everything. */
export function vizSigOk(path: string, sig: string | null, secret = process.env.VIZ_SECRET, env = process.env.NODE_ENV) {
  if (!secret) return env !== "production";
  const want = Buffer.from(vizSig(secret, path));
  const got = Buffer.from(sig ?? "");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Relative signed path, for TS callers that want to link an image. */
export function vizPath(projectId: string, file: string, secret = process.env.VIZ_SECRET) {
  const path = `${projectId}/${file}`;
  return `/api/viz/${encodeURIComponent(projectId)}/${file}${secret ? `?s=${vizSig(secret, path)}` : ""}`;
}
