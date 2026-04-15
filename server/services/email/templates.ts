// ─── Email Templates ─────────────────────────────────────────────────────────
// HTML renderers for campaign and scheduled-report emails.
// ─────────────────────────────────────────────────────────────────────────────

export interface CampaignBranding {
  primaryColor?: string;
  logoUrl?: string;
  vendorName?: string;
}

export function renderCampaignEmail(
  subject: string,
  message: string,
  branding?: CampaignBranding,
): string {
  const color = branding?.primaryColor ?? "#00438f";
  const logo = branding?.logoUrl
    ? `<img src="${branding.logoUrl}" alt="${branding.vendorName ?? "Logo"}" style="max-height:60px;margin-bottom:20px;display:block;">`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
          <tr>
            <td style="padding:32px 40px 24px;">
              ${logo}
              <h1 style="margin:0 0 16px;font-size:22px;color:${color};line-height:1.3;">${subject}</h1>
              <div style="font-size:15px;color:#333333;line-height:1.6;">${message}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 40px 32px;border-top:1px solid #eeeeee;">
              <p style="margin:0;font-size:12px;color:#999999;">
                You received this message because you are a member of ${branding?.vendorName ?? "our platform"}.
                To unsubscribe, reply with "unsubscribe" in the subject line.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function renderReportEmail(
  frequency: string,
  format: string,
  vendorName?: string,
): string {
  const label = format.toUpperCase();
  const freqLabel = frequency.charAt(0).toUpperCase() + frequency.slice(1);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Your ${freqLabel} Report</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
          <tr>
            <td style="padding:32px 40px 24px;">
              <h1 style="margin:0 0 12px;font-size:20px;color:#00438f;">Your ${freqLabel} ${label} Report</h1>
              <p style="font-size:15px;color:#333333;line-height:1.6;margin:0 0 16px;">
                Your scheduled ${frequency} analytics report from ${vendorName ?? "the platform"} is attached.
              </p>
              <p style="font-size:13px;color:#666666;margin:0;">
                Report format: <strong>${label}</strong> &nbsp;|&nbsp; Frequency: <strong>${freqLabel}</strong>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 40px 32px;border-top:1px solid #eeeeee;">
              <p style="margin:0;font-size:12px;color:#999999;">
                To stop receiving these reports, log in and manage your scheduled reports settings.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
