const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
  tls: {
    rejectUnauthorized: false
  }
});

async function sendPasswordResetEmail(toEmail, resetLink) {
  await transporter.sendMail({
    from: `"AgosTech System" <${process.env.GMAIL_USER}>`,
    to:   toEmail,
    subject: "Reset your AgosTech password",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2 style="color:#0ea5e9">AgosTech — Password Reset</h2>
        <p>Click the button below to reset your password. This link expires in <strong>1 hour</strong>.</p>
        <a href="${resetLink}" style="display:inline-block;padding:12px 24px;background:#0ea5e9;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
          Reset Password
        </a>
        <p style="margin-top:24px;color:#666;font-size:13px">If you didn't request this, ignore this email.</p>
      </div>
    `,
  });
}

async function sendAccountApprovedEmail(toEmail, fullname, role) {
  const roleName = String(role || "user").toUpperCase();
  const loginUrl = process.env.FRONTEND_URL || "http://localhost:3000/login.html";

  try {
    await transporter.sendMail({
      from: `"AgosTech Water Monitoring" <${process.env.GMAIL_USER}>`,
      to: toEmail,
      subject: "✓ Your AgosTech Account Has Been Approved!",
      html: `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 520px; margin: auto; padding: 24px; border: 1px solid #E2E8F0; border-radius: 12px; background: #FFFFFF;">
          <div style="text-align: center; padding-bottom: 16px; border-bottom: 1px solid #E2E8F0;">
            <h2 style="color: #0EA5E9; margin: 0; font-size: 22px;">AgosTech Water Quality Monitoring</h2>
            <p style="color: #64748B; font-size: 13px; margin-top: 4px;">Account Status Notification</p>
          </div>
          <div style="padding: 20px 0;">
            <p style="font-size: 15px; color: #1E293B;">Hello <strong>${fullname || "User"}</strong>,</p>
            <p style="font-size: 14px; color: #334155; line-height: 1.6;">
              Great news! Your registration request for the AgosTech Water Quality Monitoring System has been <strong style="color: #10B981;">APPROVED</strong> by a system administrator.
            </p>
            <div style="background: #F0FDF4; border: 1px solid #BBF7D0; border-radius: 8px; padding: 14px; margin: 16px 0;">
              <div style="font-size: 12px; color: #166534; font-weight: 700; text-transform: uppercase;">Assigned Access Role</div>
              <div style="font-size: 18px; font-weight: 800; color: #15803D; margin-top: 2px;">${roleName} Department</div>
            </div>
            <p style="font-size: 14px; color: #334155; line-height: 1.6;">
              You can now sign in to your dashboard to monitor real-time sensor metrics, threshold alerts, and facility status.
            </p>
            <div style="text-align: center; margin-top: 24px;">
              <a href="${loginUrl}" style="display: inline-block; padding: 12px 28px; background: #0EA5E9; color: #FFFFFF; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 14px; box-shadow: 0 4px 12px rgba(14, 165, 233, 0.3);">
                Sign In to Dashboard →
              </a>
            </div>
          </div>
          <div style="padding-top: 16px; border-top: 1px solid #E2E8F0; text-align: center; font-size: 12px; color: #94A3B8;">
            AgosTech Water Quality Monitoring & Telemetry Platform
          </div>
        </div>
      `,
    });
    console.log(`[AgosTech] Sent account approval email to ${toEmail}`);
  } catch (err) {
    console.error(`[AgosTech] Failed to send account approval email to ${toEmail}:`, err);
  }
}

async function sendAccountDeniedEmail(toEmail, fullname) {
  try {
    await transporter.sendMail({
      from: `"AgosTech Water Monitoring" <${process.env.GMAIL_USER}>`,
      to: toEmail,
      subject: "AgosTech Account Registration Update",
      html: `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 520px; margin: auto; padding: 24px; border: 1px solid #E2E8F0; border-radius: 12px; background: #FFFFFF;">
          <div style="text-align: center; padding-bottom: 16px; border-bottom: 1px solid #E2E8F0;">
            <h2 style="color: #0EA5E9; margin: 0; font-size: 22px;">AgosTech Water Quality Monitoring</h2>
            <p style="color: #64748B; font-size: 13px; margin-top: 4px;">Account Status Notification</p>
          </div>
          <div style="padding: 20px 0;">
            <p style="font-size: 15px; color: #1E293B;">Hello <strong>${fullname || "User"}</strong>,</p>
            <p style="font-size: 14px; color: #334155; line-height: 1.6;">
              Your account registration request for the AgosTech Water Quality Monitoring System was reviewed by a system administrator and was <strong style="color: #EF4444;">DENIED</strong> or deactivated.
            </p>
            <p style="font-size: 14px; color: #334155; line-height: 1.6;">
              If you believe this was done in error or require authorized department access, please contact your system administrator or facility manager.
            </p>
          </div>
          <div style="padding-top: 16px; border-top: 1px solid #E2E8F0; text-align: center; font-size: 12px; color: #94A3B8;">
            AgosTech Water Quality Monitoring & Telemetry Platform
          </div>
        </div>
      `,
    });
    console.log(`[AgosTech] Sent account denial email to ${toEmail}`);
  } catch (err) {
    console.error(`[AgosTech] Failed to send account denial email to ${toEmail}:`, err);
  }
}

module.exports = { sendPasswordResetEmail, sendAccountApprovedEmail, sendAccountDeniedEmail };