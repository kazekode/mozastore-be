import nodemailer from "nodemailer";
import { SmtpSetting } from "./database.js";

const escapeHtml = (text) => {
    if (!text) return text;
    return text
        .toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
};

// Template Generator
export const generateOrderEmailHtml = (orderData) => {
    const itemsHtml = orderData.items.map((item) => `
      <tr>
        <td style="padding: 0 0 20px 0;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="background: #ffffff; border-radius: 12px; border: 1px solid #e5e7eb; overflow: hidden;">
                <table style="width: 100%; border-collapse: collapse;">
                  <tr>
                    <td style="padding: 16px 20px; border-bottom: 1px solid #f3f4f6;">
                      <table style="width: 100%; border-collapse: collapse;">
                        <tr>
                          <td style="font-size: 16px; font-weight: 600; color: #111827;">${escapeHtml(item.name)}</td>
                          <td style="text-align: right; font-size: 15px; font-weight: 600; color: #4f46e5;">Rp ${item.price.toLocaleString('id-ID')}</td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  ${item.accountData ? `
                  <tr>
                    <td style="padding: 16px 20px; background: #fafafa;">
                      <table style="width: 100%; border-collapse: collapse;">
                        <tr>
                          <td style="font-size: 11px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; padding-bottom: 10px;">Detail Akun</td>
                        </tr>
                        <tr>
                          <td style="background: #111827; border-radius: 8px; padding: 14px 16px;">
                            <pre style="margin: 0; font-family: 'SF Mono', 'Monaco', 'Consolas', monospace; font-size: 13px; color: #e5e7eb; white-space: pre-wrap; word-break: break-all; line-height: 1.6;">${escapeHtml(item.accountData)}</pre>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  ` : ''}
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    `).join('');

    const currentDate = new Date().toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    return `
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invoice Moza Store</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; color: #334155;">
  <div style="background-color: #f1f5f9; padding: 40px 0; min-height: 100%;">
    <table role="presentation" style="width: 100%; border-collapse: collapse;">
      <tr>
        <td align="center">
          <table role="presentation" style="width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
            <tr>
                <td style="background: linear-gradient(180deg, #dbeafe 0%, #eff6ff 50%, #ffffff 100%); padding: 40px; text-align: center; border-bottom: 1px solid #f1f5f9;">
                  <h1 style="margin: 0; font-size: 26px; font-weight: 800; color: #1e40af; letter-spacing: -0.5px;">PEMBAYARAN BERHASIL</h1>
                  <p style="margin: 10px 0 0 0; font-size: 16px; color: #64748b; font-weight: 500;">Terima kasih ${orderData.recipientName ? escapeHtml(orderData.recipientName) : 'telah berbelanja di Moza Store'}</p>
                </td>
            </tr>
            <tr>
              <td style="padding: 30px 40px;">
                <table role="presentation" style="width: 100%; border-collapse: collapse;">
                  <tr>
                    <td style="padding-bottom: 20px; border-bottom: 2px dashed #e2e8f0;">
                      <table role="presentation" style="width: 100%; border-collapse: collapse;">
                        <tr>
                          <td valign="top" style="width: 50%; padding-bottom: 15px;">
                            <p style="margin: 0; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #94a3b8; letter-spacing: 1px;">Order ID</p>
                            <p style="margin: 4px 0 0 0; font-size: 15px; font-weight: 600; color: #0f172a; font-family: monospace;">#${orderData.orderId}</p>
                          </td>
                          <td valign="top" style="width: 50%; padding-bottom: 15px;">
                             <div style="text-align: right;">
                              <p style="margin: 0; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #94a3b8; letter-spacing: 1px;">Tanggal</p>
                              <p style="margin: 4px 0 0 0; font-size: 15px; font-weight: 600; color: #0f172a;">${currentDate}</p>
                             </div>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding: 0 40px;">
                <p style="margin: 0 0 15px 0; font-size: 14px; font-weight: 700; color: #334155; text-transform: uppercase; letter-spacing: 0.5px;">Detail Item</p>
                <table role="presentation" style="width: 100%; border-collapse: collapse;">
                   ${itemsHtml}
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding: 20px 40px 40px 40px;">
                <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f8fafc; border-radius: 12px;">
                  <tr>
                    <td style="padding: 20px;">
                      <table role="presentation" style="width: 100%; border-collapse: collapse;">
                        <tr>
                          <td style="font-size: 16px; font-weight: 600; color: #475569;">Total Biaya</td>
                          <td style="text-align: right; font-size: 22px; font-weight: 800; color: #2563eb;">Rp ${orderData.totalAmount.toLocaleString('id-ID')}</td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding: 0 40px 40px 40px;">
                <table role="presentation" style="width: 100%; border-collapse: collapse;">
                  <tr>
                    <td style="background-color: #eff6ff; border-left: 4px solid #3b82f6; padding: 15px; border-radius: 4px;">
                      <p style="margin: 0; font-size: 13px; color: #1e40af; line-height: 1.6;">
                        <strong>Penting:</strong> Simpan email ini sebagai bukti transaksi yang sah.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </div>
</body>
</html>
    `;
};

// Create Mailer Transporter
export const getTransporter = async () => {
    const setting = await SmtpSetting.findOne({});
    if (!setting) return null;

    return nodemailer.createTransport({
        host: setting.host,
        port: setting.port,
        secure: setting.secure,
        auth: {
            user: setting.email,
            pass: setting.password
        }
    });
};

export const sendOrderEmail = async (toEmail, orderData) => {
    const transporter = await getTransporter();
    if (!transporter) return { success: false, error: "SMTP belum dikonfigurasi" };

    const setting = await SmtpSetting.findOne({});
    const html = generateOrderEmailHtml(orderData);
    
    try {
        await transporter.sendMail({
            from: `"Moza Store" <${setting.email}>`,
            to: toEmail,
            subject: `Konfirmasi Pesanan - ${orderData.orderId}`,
            html
        });
        return { success: true };
    } catch (error) {
        console.error("Gagal mengirim email:", error);
        return { success: false, error: error.message };
    }
};

export const testSmtpConnection = async (config) => {
    const transporter = nodemailer.createTransport({
        host: config.host || 'smtp.gmail.com',
        port: config.port || 465,
        secure: config.secure !== undefined ? config.secure : true,
        auth: {
            user: config.email,
            pass: config.password
        }
    });
    
    try {
        await transporter.verify();
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
};
