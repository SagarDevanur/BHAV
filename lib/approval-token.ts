import { createHmac } from "crypto";
import { config } from "@/lib/config";

/**
 * Generates a signed approval token for a given userId.
 * Used in one-click approve links sent to the admin via email.
 *
 * Token format: base64url(userId + "." + timestamp) + "." + hmac
 */
export function generateApprovalToken(userId: string): string {
  const timestamp = Date.now().toString();
  const payload = Buffer.from(`${userId}.${timestamp}`).toString("base64url");
  const sig = createHmac("sha256", config.approval.secret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

/**
 * Verifies an approval token and returns the userId if valid.
 * Tokens expire after 7 days.
 * Returns null if invalid or expired.
 */
export function verifyApprovalToken(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payload, sig] = parts;

  // Verify signature
  const expectedSig = createHmac("sha256", config.approval.secret)
    .update(payload)
    .digest("base64url");
  if (sig !== expectedSig) return null;

  // Decode payload
  let decoded: string;
  try {
    decoded = Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    return null;
  }

  const dotIndex = decoded.lastIndexOf(".");
  if (dotIndex === -1) return null;

  const userId = decoded.slice(0, dotIndex);
  const timestamp = parseInt(decoded.slice(dotIndex + 1), 10);

  if (isNaN(timestamp)) return null;

  // 7-day expiry
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  if (Date.now() - timestamp > SEVEN_DAYS_MS) return null;

  return userId;
}
