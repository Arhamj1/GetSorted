#!/usr/bin/env node
/**
 * GetSorted — renewal reminder emails.
 *
 * Runs once a day (see .github/workflows/reminders.yml). For every user it finds
 * subscriptions that renew in 3 days or today and sends ONE email listing them,
 * to the email address the user logs in with.
 *
 *   node scripts/send-reminders.mjs                 send for real
 *   node scripts/send-reminders.mjs --dry-run       read Firestore, send nothing, write previews
 *   node scripts/send-reminders.mjs --demo --dry-run   sample data, no Firebase or Gmail needed
 *   node scripts/send-reminders.mjs --to=me@x.com   send everything to one address (testing)
 *
 * Environment:
 *   FIREBASE_SERVICE_ACCOUNT  service-account JSON (the whole file contents)
 *   GMAIL_USER                Gmail address that sends the emails
 *   GMAIL_APP_PASSWORD        16-character Google app password for that account
 *   APP_URL                   (optional) link to the live site, shown as a button
 */
import { mkdirSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const DRY  = argv.includes('--dry-run');
const DEMO = argv.includes('--demo');
const TO_OVERRIDE = (argv.find(a => a.startsWith('--to=')) || '').slice(5) || process.env.TEST_TO || '';
const APP_URL = process.env.APP_URL || '';
const TZ = 'Asia/Kolkata';
const OFFSETS = [3, 0]; // days before renewal

/* ─── Dates (ISO strings, timezone-safe) ─── */
const todayISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const toUTC = iso => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const fromUTC = t => new Date(t).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 86400000);
const shiftDays = (iso, n) => fromUTC(toUTC(iso) + n * 86400000);
function addCycle(iso, cycle) {
  const [y, m, d] = iso.split('-').map(Number);
  const ny = cycle === 'Yearly' ? y + 1 : y + (m === 12 ? 1 : 0);
  const nm = cycle === 'Yearly' ? m : (m % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
/* Same rule as the app: auto-pay rolls forward, manual ones expire */
function nextBilling(sub, today) {
  if (!sub.date || !/^\d{4}-\d{2}-\d{2}$/.test(sub.date)) return null;
  let d = sub.date, guard = 0;
  while (d < today) {
    if (!sub.autopay) return null;
    d = addCycle(d, sub.cycle);
    if (++guard > 400) return null;
  }
  return d;
}
const niceDate = iso => new Date(toUTC(iso)).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const rupees = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s || '');

/* Brand colours for the letter badges (SVG logos don't render in Gmail) */
const BRAND = {
  'Netflix':'#E50914','Amazon Prime Video':'#1A98FF','JioHotstar':'#1B2B6B','SonyLiv':'#B88A1B','Zee5':'#8230C6',
  'YouTube Premium':'#FF0033','Spotify':'#1DB954','Apple Music':'#FA243C','ChatGPT':'#10A37F','Gemini':'#4C7BF4',
  'Claude':'#D97757','Zomato Gold':'#E23744','Swiggy One':'#FC8019','Notion':'#27272A','iCloud+':'#2F7CF6',
};
const badge = name => {
  const words = String(name).trim().split(/\s+/);
  const letters = (words.length > 1 ? words[0][0] + words[1][0] : String(name).slice(0, 1)).toUpperCase();
  return { letters, color: BRAND[name] || '#6D5CF0' };
};

/* ─── Email ─── */
function buildEmail(email, items) {
  const total = items.reduce((s, i) => s + Number(i.sub.cost || 0), 0);
  const first = items[0];
  const when = d => d === 0 ? 'today' : `in ${d} days`;
  const subject = items.length === 1
    ? `${first.sub.name} renews ${when(first.days)} · ${rupees(first.sub.cost)}`
    : `${items.length} subscriptions renew soon · ${rupees(total)}`;
  const name = email.split('@')[0].replace(/[._\d]+/g, ' ').trim().split(' ')[0] || 'there';
  const hello = name.charAt(0).toUpperCase() + name.slice(1);

  const rows = items.map(({ sub, due, days }) => {
    const b = badge(sub.name);
    const pay = sub.payment === 'Card'
      ? `${esc(sub.bank || 'Card')}${sub.last4 ? ` •••• ${esc(sub.last4)}` : ''}`
      : 'UPI';
    const note = sub.autopay
      ? `<span style="color:#16A34A">Auto-pay on</span> · ${pay}`
      : `<span style="color:#D97706;font-weight:600">Pay manually</span> · ${pay}`;
    const pill = days === 0
      ? `<span style="display:inline-block;padding:3px 9px;border-radius:999px;background:#FEE2E2;color:#B91C1C;font-size:11px;font-weight:600">Today</span>`
      : `<span style="display:inline-block;padding:3px 9px;border-radius:999px;background:#EDE9FE;color:#5B21B6;font-size:11px;font-weight:600">In ${days} days</span>`;
    return `
      <tr><td style="padding:14px 0;border-top:1px solid #EEEEF2">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td width="44" valign="middle"><div style="width:40px;height:40px;border-radius:11px;background:${b.color};color:#fff;font:600 14px/40px -apple-system,Segoe UI,Arial,sans-serif;text-align:center">${esc(b.letters)}</div></td>
          <td valign="middle" style="padding-left:12px;font-family:-apple-system,Segoe UI,Arial,sans-serif">
            <div style="font-size:15px;font-weight:600;color:#18181B">${esc(sub.name)} &nbsp;${pill}</div>
            <div style="font-size:12.5px;color:#71717A;margin-top:3px">${niceDate(due)} · ${note}</div>
          </td>
          <td valign="middle" align="right" style="font-family:-apple-system,Segoe UI,Arial,sans-serif;white-space:nowrap">
            <div style="font-size:16px;font-weight:600;color:#18181B">${rupees(sub.cost)}</div>
            <div style="font-size:11.5px;color:#A1A1AA">/${sub.cycle === 'Yearly' ? 'year' : 'month'}</div>
          </td>
        </tr></table>
      </td></tr>`;
  }).join('');

  const manual = items.filter(i => !i.sub.autopay);
  const lead = items.length === 1
    ? `Your <b>${esc(first.sub.name)}</b> subscription renews <b>${when(first.days)}</b>.`
    : `<b>${items.length} subscriptions</b> are renewing soon. Here's what's coming up.`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#F4F4F7">
<div style="display:none;max-height:0;overflow:hidden">${esc(subject)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F4F7"><tr><td align="center" style="padding:32px 16px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
    <tr><td style="padding:0 4px 18px;font-family:-apple-system,Segoe UI,Arial,sans-serif">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td><div style="width:28px;height:28px;border-radius:8px;background:#7C6CF5;text-align:center;font:700 15px/28px Arial,sans-serif;color:#fff">≡</div></td>
        <td style="padding-left:9px;font-size:16px;font-weight:700;color:#18181B;letter-spacing:-.2px">GetSorted</td>
      </tr></table>
    </td></tr>
    <tr><td style="background:#FFFFFF;border-radius:18px;border:1px solid #E7E7EC;overflow:hidden">
      <div style="height:4px;background:linear-gradient(90deg,#9A8DFF,#6E5CF0)"></div>
      <div style="padding:28px 28px 8px;font-family:-apple-system,Segoe UI,Arial,sans-serif">
        <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#7C6CF5;font-weight:600">Renewal reminder</div>
        <h1 style="margin:8px 0 10px;font-size:23px;line-height:1.25;color:#18181B;letter-spacing:-.4px">Hi ${esc(hello)}, heads-up before you're charged</h1>
        <p style="margin:0;font-size:14.5px;line-height:1.6;color:#52525B">${lead}</p>
      </div>
      <div style="padding:10px 28px 4px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
      </div>
      <div style="margin:0 28px;padding:16px 0 4px;border-top:2px solid #18181B;font-family:-apple-system,Segoe UI,Arial,sans-serif">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="font-size:13px;color:#52525B">Total in this email</td>
          <td align="right" style="font-size:18px;font-weight:700;color:#18181B">${rupees(total)}</td>
        </tr></table>
      </div>
      ${manual.length ? `<div style="margin:16px 28px 0;padding:12px 14px;border-radius:12px;background:#FFFBEB;border:1px solid #FDE68A;font:13px/1.5 -apple-system,Segoe UI,Arial,sans-serif;color:#92400E">${manual.length === 1 ? `${esc(manual[0].sub.name)} doesn't have auto-pay, so pay it yourself` : `${manual.length} of these don't have auto-pay, so pay them yourself`} before the date or it will be removed from your list.</div>` : ''}
      <div style="padding:22px 28px 28px;font-family:-apple-system,Segoe UI,Arial,sans-serif">
        ${APP_URL ? `<a href="${esc(APP_URL)}" style="display:inline-block;padding:12px 20px;border-radius:999px;background:#6E5CF0;color:#FFFFFF;font-size:14px;font-weight:600;text-decoration:none">Open GetSorted</a>` : ''}
        <p style="margin:${APP_URL ? '16px' : '0'} 0 0;font-size:12.5px;line-height:1.55;color:#A1A1AA">Want to cancel something? Do it before the renewal date to avoid the charge.</p>
      </div>
    </td></tr>
    <tr><td style="padding:18px 8px;font:12px/1.6 -apple-system,Segoe UI,Arial,sans-serif;color:#A1A1AA;text-align:center">
      You're getting this because you track subscriptions with GetSorted as ${esc(email)}.<br>
      Turn reminders off any time from the account menu in the app.
    </td></tr>
  </table>
</td></tr></table></body></html>`;

  const text = [
    `GetSorted renewal reminder`, ``,
    ...items.map(({ sub, due, days }) => `• ${sub.name}: ${rupees(sub.cost)} ${when(days)} (${niceDate(due)})${sub.autopay ? '' : ' — pay manually'}`),
    ``, `Total: ${rupees(total)}`, APP_URL ? `\nOpen GetSorted: ${APP_URL}` : '',
    `\nTurn reminders off from the account menu in the app.`,
  ].join('\n');

  return { subject, html, text };
}

/* ─── Data ─── */
function demoData(today) {
  const at = n => shiftDays(today, n);
  const subs = [
    { id:'a', name:'Netflix',     cost:649,  cycle:'Monthly', date:at(0),  autopay:true,  payment:'Card', bank:'HDFC', last4:'4821' },
    { id:'b', name:'Spotify',     cost:119,  cycle:'Monthly', date:at(3),  autopay:true,  payment:'UPI' },
    { id:'c', name:'Swiggy One',  cost:899,  cycle:'Yearly',  date:at(3),  autopay:false, payment:'UPI' },
    { id:'d', name:'Claude',      cost:1950, cycle:'Monthly', date:at(6),  autopay:true,  payment:'Card', bank:'ICICI', last4:'1107' },
  ];
  return [{ email: 'demo@getsorted.app', prefs: {}, subs: subs.map(s => ({ ...s, ref: null })) }];
}

async function loadFirestore() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set.');
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
  initializeApp({ credential: cert(JSON.parse(raw)) });
  const db = getFirestore();

  // Subscriptions live at users/{email}/subscriptions/{id}
  const snap = await db.collectionGroup('subscriptions').get();
  const byUser = new Map();
  snap.forEach(doc => {
    const userRef = doc.ref.parent.parent;
    if (!userRef || doc.ref.parent.parent.parent.id !== 'users') return;
    const email = userRef.id;
    if (!byUser.has(email)) byUser.set(email, { email, userRef, subs: [] });
    byUser.get(email).subs.push({ id: doc.id, ...doc.data(), ref: doc.ref });
  });
  const users = [...byUser.values()];
  if (users.length) {
    const prefDocs = await db.getAll(...users.map(u => u.userRef));
    prefDocs.forEach((d, i) => { users[i].prefs = d.exists ? d.data() : {}; });
  }
  return { users, markSent: (ref, key) => ref.update({ reminderLog: FieldValue.arrayUnion(key) }) };
}

async function makeSender() {
  if (DRY) return null;
  const { GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) throw new Error('GMAIL_USER and GMAIL_APP_PASSWORD must be set (or use --dry-run).');
  const nodemailer = (await import('nodemailer')).default;
  const transport = nodemailer.createTransport({ service: 'gmail', auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD.replace(/\s+/g, '') } });
  await transport.verify();
  return msg => transport.sendMail({ from: `"GetSorted" <${GMAIL_USER}>`, ...msg });
}

/* ─── Main ─── */
async function main() {
  const today = todayISO();
  console.log(`GetSorted reminders · ${today} (${TZ}) · ${DEMO ? 'demo data' : 'Firestore'}${DRY ? ' · dry run' : ''}`);

  const { users, markSent } = DEMO ? { users: demoData(today), markSent: async () => {} } : await loadFirestore();
  const send = await makeSender();

  let emails = 0, skipped = 0, failed = 0;
  for (const user of users) {
    if (!isEmail(user.email)) { skipped++; continue; }
    if (user.prefs && user.prefs.emailReminders === false) { skipped++; continue; }

    const items = [];
    for (const sub of user.subs) {
      const due = nextBilling(sub, today);
      if (!due) continue;
      const days = daysBetween(today, due);
      if (!OFFSETS.includes(days)) continue;
      const key = `${due}:${days}d`;
      if ((sub.reminderLog || []).includes(key)) continue; // already sent
      items.push({ sub, due, days, key });
    }
    if (!items.length) continue;
    items.sort((a, b) => a.days - b.days || b.sub.cost - a.sub.cost);

    const mail = buildEmail(user.email, items);
    const to = TO_OVERRIDE || user.email;
    if (DRY) {
      mkdirSync('reminder-previews', { recursive: true });
      const file = `reminder-previews/${user.email.replace(/[^a-z0-9@._-]/gi, '_')}.html`;
      writeFileSync(file, mail.html);
      console.log(`  would email ${to}: "${mail.subject}" → ${file}`);
      emails++;
      continue;
    }
    try {
      await send({ to, subject: mail.subject, html: mail.html, text: mail.text });
      if (!TO_OVERRIDE) await Promise.all(items.filter(i => i.sub.ref).map(i => markSent(i.sub.ref, i.key)));
      console.log(`  sent to ${to}: "${mail.subject}"`);
      emails++;
    } catch (err) {
      failed++;
      console.error(`  FAILED for ${user.email}: ${err.message}`);
    }
  }
  console.log(`Done. ${emails} email${emails === 1 ? '' : 's'} ${DRY ? 'previewed' : 'sent'}, ${skipped} user${skipped === 1 ? '' : 's'} skipped, ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
