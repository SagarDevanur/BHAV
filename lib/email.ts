import { Resend } from "resend";
import { config } from "@/lib/config";
import { ADMIN_EMAIL } from "@/lib/auth-config";
import { generateApprovalToken } from "@/lib/approval-token";

/**
 * Sends an approval request email to the admin when a new @bhavspac.com
 * user signs up and is waiting for access.
 *
 * The email contains a one-click approve link valid for 7 days.
 */
export async function sendApprovalRequestEmail(params: {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
}): Promise<void> {
  if (!config.resend.apiKey) {
    console.warn("[email] RESEND_API_KEY not set — skipping approval email");
    return;
  }

  const resend = new Resend(config.resend.apiKey);
  const token = generateApprovalToken(params.userId);
  const approveUrl = `${config.app.url}/approve?token=${token}`;

  const fullName = `${params.firstName} ${params.lastName}`.trim() || params.email;

  await resend.emails.send({
    from: "BHAV Access Control <onboarding@resend.dev>",
    to: ADMIN_EMAIL,
    subject: `Access request from ${fullName} — BHAV`,
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; margin: 0; padding: 32px 16px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 480px; margin: 0 auto;">
    <tr>
      <td>
        <!-- Logo -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 24px;">
          <tr>
            <td align="center">
              <div style="display:inline-block; background:#1e3a5f; border-radius:10px; width:44px; height:44px; line-height:44px; text-align:center; margin-bottom:10px;">
                <span style="color:#fff; font-size:20px; font-weight:700;">B</span>
              </div>
              <p style="margin:0; font-size:16px; font-weight:600; color:#0f172a;">BHAV Acquisition Corp</p>
              <p style="margin:2px 0 0; font-size:12px; color:#94a3b8; letter-spacing:0.05em;">AI-Native deSPAC Engine</p>
            </td>
          </tr>
        </table>

        <!-- Card -->
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff; border:1px solid #e2e8f0; border-radius:16px; padding:32px;">
          <tr>
            <td>
              <p style="margin:0 0 6px; font-size:15px; font-weight:600; color:#0f172a;">New access request</p>
              <p style="margin:0 0 24px; font-size:13px; color:#64748b; line-height:1.5;">
                The following user has signed up and is waiting for dashboard access.
              </p>

              <!-- User details -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:16px; margin-bottom:24px;">
                <tr>
                  <td>
                    <p style="margin:0 0 4px; font-size:14px; font-weight:600; color:#0f172a;">${fullName}</p>
                    <p style="margin:0; font-size:13px; color:#64748b;">${params.email}</p>
                  </td>
                </tr>
              </table>

              <!-- Approve button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center">
                    <a href="${approveUrl}"
                       style="display:inline-block; background:#1e3a5f; color:#fff; text-decoration:none; font-size:14px; font-weight:600; padding:12px 32px; border-radius:8px;">
                      Approve Access
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:20px 0 0; font-size:11px; color:#94a3b8; text-align:center; line-height:1.5;">
                This link expires in 7 days. If you did not expect this request, ignore this email.
              </p>
            </td>
          </tr>
        </table>

        <p style="margin:20px 0 0; font-size:11px; color:#cbd5e1; text-align:center;">
          © ${new Date().getFullYear()} BHAV Acquisition Corp. All rights reserved.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim(),
  });
}
