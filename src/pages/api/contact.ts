import type { APIRoute } from 'astro';
import { Resend } from 'resend';

export const prerender = false;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /(https?:\/\/|www\.)/gi;

// A real visitor needs at least this long to read the form and type a message.
// Bots that fill and submit programmatically are almost always faster than this.
const MIN_FILL_TIME_MS = 1500;
// Contact enquiries don't normally contain multiple links; 3+ is a strong spam signal.
const MAX_MESSAGE_URLS = 2;

// Simple in-memory sliding-window rate limit, keyed by IP. Good enough for a
// single-instance Node process; resets on redeploy, which is fine here.
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const submissionsByIp = new Map<string, number[]>();
let lastCleanupAt = Date.now();

function getClientIp(request: Request, clientAddress: string | undefined): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || clientAddress || 'unknown';
}

// Real submissions come from a browser rendering our actual contact page, which always
// sends an Origin (or at least Referer) pointing at our own site. Scripts that spam the
// endpoint directly — without ever loading the page — almost never bother setting this.
const SITE_HOSTNAMES = new Set(['woodstylejoinery.co.uk', 'www.woodstylejoinery.co.uk']);

function isTrustedOrigin(value: string | null): boolean {
  if (!value) return false;
  try {
    const { hostname } = new URL(value);
    if (SITE_HOSTNAMES.has(hostname)) return true;
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function cleanupRateLimitStore(now: number) {
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  for (const [ip, timestamps] of submissionsByIp) {
    const fresh = timestamps.filter((t) => t > windowStart);
    if (fresh.length === 0) submissionsByIp.delete(ip);
    else submissionsByIp.set(ip, fresh);
  }
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  cleanupRateLimitStore(now);

  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const timestamps = (submissionsByIp.get(ip) ?? []).filter((t) => t > windowStart);

  if (timestamps.length >= RATE_LIMIT_MAX) {
    submissionsByIp.set(ip, timestamps);
    return true;
  }

  timestamps.push(now);
  submissionsByIp.set(ip, timestamps);
  return false;
}

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const startedAt = Date.now();
  const reqId = Math.random().toString(36).slice(2, 8);
  const ip = getClientIp(request, clientAddress);

  if (isRateLimited(ip)) {
    console.warn(`[contact:${reqId}] rate limited ip=${ip}`);
    return json(429, { error: 'Too many requests. Please try again in a few minutes.' });
  }

  // Bots that POST straight to this endpoint (never loading /contact) typically send no
  // Origin/Referer at all, or one for an unrelated site. Reject before touching the body.
  const origin = request.headers.get('origin') || request.headers.get('referer');
  if (!isTrustedOrigin(origin)) {
    console.log(`[contact:${reqId}] untrusted origin "${origin ?? 'none'}", ignoring`);
    return json(200, { ok: true });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch (err) {
    console.error(`[contact:${reqId}] failed to parse form data`, err);
    return json(400, { error: 'Invalid form submission' });
  }

  // Spam honeypot: our real form always submits this field (empty), even without JS, so a
  // missing field means the request didn't come from our form at all. A filled-in field
  // means a bot filled it blindly. Either way, pretend success so bots don't adapt.
  const gotcha = form.get('_gotcha');
  if (gotcha === null || (gotcha as string).trim()) {
    console.log(`[contact:${reqId}] honeypot triggered (${gotcha === null ? 'field missing' : 'field filled'}), ignoring`);
    return json(200, { ok: true });
  }

  // Timing trap: the form stamps this via JS on page load. Missing, malformed, or
  // implausibly-fast values are all treated as scripted. Same pretend-success response.
  const rawTs = form.get('_ts');
  const loadedAt = rawTs === null ? NaN : Number(rawTs);
  if (!Number.isFinite(loadedAt) || loadedAt <= 0 || startedAt - loadedAt < MIN_FILL_TIME_MS) {
    console.log(`[contact:${reqId}] timing trap triggered, ignoring (elapsed=${Number.isFinite(loadedAt) ? startedAt - loadedAt : 'n/a'}ms)`);
    return json(200, { ok: true });
  }

  const name = (form.get('name') as string || '').trim();
  const phone = (form.get('phone') as string || '').trim();
  const email = (form.get('email') as string || '').trim();
  const message = (form.get('message') as string || '').trim();

  if (!name || !email || !message) {
    console.warn(`[contact:${reqId}] rejected: missing required fields`, {
      hasName: !!name,
      hasEmail: !!email,
      hasMessage: !!message,
    });
    return json(422, { error: 'Missing required fields' });
  }
  if (!EMAIL_RE.test(email)) {
    console.warn(`[contact:${reqId}] rejected: invalid email address format`);
    return json(422, { error: 'Invalid email address' });
  }

  const urlCount = message.match(URL_RE)?.length ?? 0;
  if (urlCount > MAX_MESSAGE_URLS) {
    console.log(`[contact:${reqId}] link-heavy message treated as spam, ignoring (urls=${urlCount})`);
    return json(200, { ok: true });
  }

  const subjectName = name.replace(/[\r\n]+/g, ' ');

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { data, error } = await resend.emails.send({
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
      console.error(`[contact:${reqId}] Resend returned an error`, error);
      return json(502, { error: 'Failed to send message' });
    }

    console.log(`[contact:${reqId}] sent ok, resend id=${data?.id} in ${Date.now() - startedAt}ms`);
  } catch (err) {
    console.error(`[contact:${reqId}] unexpected error sending message`, err);
    return json(500, { error: 'Failed to send message' });
  }

  return json(200, { ok: true });
};
