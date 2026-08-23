import type { APIRoute } from 'astro';
import { Resend } from 'resend';

export const prerender = false;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json(400, { error: 'Invalid form submission' });
  }

  // Spam honeypot: bots fill this in, humans never see it. Pretend success so bots don't retry.
  if ((form.get('_gotcha') as string)?.trim()) {
    return json(200, { ok: true });
  }

  const name = (form.get('name') as string || '').trim();
  const phone = (form.get('phone') as string || '').trim();
  const email = (form.get('email') as string || '').trim();
  const message = (form.get('message') as string || '').trim();

  if (!name || !email || !message) {
    return json(422, { error: 'Missing required fields' });
  }
  if (!EMAIL_RE.test(email)) {
    return json(422, { error: 'Invalid email address' });
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const subjectName = name.replace(/[\r\n]+/g, ' ');

  try {
    const { error } = await resend.emails.send({
      from: process.env.CONTACT_FROM_EMAIL as string,
      to: process.env.CONTACT_TO_EMAIL as string,
      replyTo: email,
      subject: `New enquiry from ${subjectName} — Woodstyle Joinery website`,
      text: [
        `Name: ${name}`,
        `Email: ${email}`,
        phone ? `Phone: ${phone}` : null,
        '',
        message,
      ].filter((line) => line !== null).join('\n'),
    });

    if (error) {
      console.error('Resend error', error);
      return json(502, { error: 'Failed to send message' });
    }
  } catch (err) {
    console.error('Contact form send failed', err);
    return json(500, { error: 'Failed to send message' });
  }

  return json(200, { ok: true });
};
