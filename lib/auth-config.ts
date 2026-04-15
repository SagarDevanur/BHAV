/**
 * Authentication configuration for BHAV Acquisition Corp.
 *
 * EXCEPTION_EMAILS  — always allowed; bypass domain check.
 * ALLOWED_DOMAIN    — any @bhavspac.com address is allowed.
 *
 * Access control is enforced in:
 *   - middleware.ts (unauthenticated protection)
 *   - app/(dashboard)/layout.tsx (email domain check after login)
 */

export const EXCEPTION_EMAILS: readonly string[] = [
  "sagardevanur@gmail.com",   // co-founder
  "giri.devanur@gmail.com",   // co-founder
  "chaitanya@bhavspac.com",   // co-founder / admin
] as const;

export const ALLOWED_DOMAIN = "bhavspac.com" as const;

/** Admin email that receives new-user signup notifications. */
export const ADMIN_EMAIL = "chaitanya@bhavspac.com" as const;

/**
 * Returns true if the given email is permitted to access the dashboard.
 * Comparison is case-insensitive.
 */
export function isEmailAllowed(email: string): boolean {
  const lower = email.toLowerCase().trim();
  return (
    EXCEPTION_EMAILS.some((e) => e.toLowerCase() === lower) ||
    lower.endsWith(`@${ALLOWED_DOMAIN}`)
  );
}

/**
 * Returns true if the email is in the pre-approved exception list.
 * Exception emails skip the "request submitted" step and go straight to the dashboard.
 */
export function isExceptionEmail(email: string): boolean {
  const lower = email.toLowerCase().trim();
  return EXCEPTION_EMAILS.some((e) => e.toLowerCase() === lower);
}
