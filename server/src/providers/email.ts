// Transactional email: Resend or Postmark over their REST APIs,
// or a stand-in that keeps messages in memory and logs them (development).

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface Email {
  readonly kind: 'resend' | 'postmark' | 'log';
  send(m: EmailMessage): Promise<void>;
}

export function createResendEmail(apiKey: string, from: string): Email {
  return {
    kind: 'resend',
    async send(m) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [m.to], subject: m.subject, html: m.html, text: m.text }),
      });
      if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
    },
  };
}

export function createPostmarkEmail(serverToken: string, from: string): Email {
  return {
    kind: 'postmark',
    async send(m) {
      const res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: { 'X-Postmark-Server-Token': serverToken, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ From: from, To: m.to, Subject: m.subject, HtmlBody: m.html, TextBody: m.text, MessageStream: 'outbound' }),
      });
      if (!res.ok) throw new Error(`Postmark ${res.status}: ${await res.text()}`);
    },
  };
}

export function createLogEmail(outbox: EmailMessage[] = [], log?: (m: string) => void): Email {
  return {
    kind: 'log',
    async send(m) {
      outbox.push(m);
      log?.(`[email] to=${m.to} subject=${m.subject}\n${m.text}`);
    },
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** One simple, mail-client-safe layout for every message. */
export function layout(o: { brand: string; title: string; body: string; button?: { text: string; url: string }; footer: string }): { html: string; text: string } {
  const paragraphs = o.body.split('\n').filter(Boolean).map((p) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.5;color:#18201c">${esc(p)}</p>`).join('');
  const button = o.button
    ? `<p style="margin:20px 0"><a href="${esc(o.button.url)}" style="display:inline-block;background:#0b6b45;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:8px;font-size:15px">${esc(o.button.text)}</a></p>`
    : '';
  const html = `<!doctype html><html><body style="margin:0;background:#eef1ef;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1ef;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;border:1px solid #d5dcd8">
<tr><td style="padding:18px 24px;border-bottom:1px solid #d5dcd8"><span style="display:inline-block;background:#0b6b45;color:#fff;font-weight:800;letter-spacing:.04em;padding:4px 10px;border-radius:6px">${esc(o.brand.toUpperCase())}</span></td></tr>
<tr><td style="padding:24px"><h1 style="margin:0 0 14px;font-size:20px;color:#18201c">${esc(o.title)}</h1>${paragraphs}${button}</td></tr>
<tr><td style="padding:14px 24px;border-top:1px solid #d5dcd8;font-size:12px;color:#5c6862;line-height:1.5">${o.footer}</td></tr>
</table></td></tr></table></body></html>`;
  const text = `${o.title}\n\n${o.body}${o.button ? `\n\n${o.button.text}: ${o.button.url}` : ''}\n\n--\n${o.footer.replace(/<[^>]+>/g, '')}`;
  return { html, text };
}
