/* Tests for the Gmail receipt parser in gmail-import.js.  Run: npm run test:parser */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL('../gmail-import.js', import.meta.url), 'utf8'), ctx);
const { parseReceipt, groupFindings, demoInbox } = ctx.GmailImport;

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };
const today = '2026-11-10';

console.log('Gmail receipt parser');

t('reads an INR receipt with card details', () => {
  const r = parseReceipt({ from: 'Netflix <info@account.netflix.com>', subject: 'Your Netflix membership payment', date: '2026-10-12',
    text: 'Thanks for your payment. Premium plan ₹649.00 per month. Payment method: HDFC Bank •••• 4821' });
  assert.equal(r.name, 'Netflix'); assert.equal(r.amount, 649); assert.equal(r.currency, 'INR');
  assert.equal(r.cycle, 'Monthly'); assert.equal(r.payment, 'Card'); assert.equal(r.bank, 'HDFC'); assert.equal(r.last4, '4821');
});

t('prefers the amount next to "Total"', () => {
  const r = parseReceipt({ from: 'Spotify <no-reply@spotify.com>', subject: 'Your receipt', date: '2026-11-01',
    text: 'Premium Family was ₹179, now discounted. Subtotal ₹149.00 Total ₹149.00' });
  assert.equal(r.amount, 149);
});

t('handles Indian digit grouping and Rs.', () => {
  const r = parseReceipt({ from: 'Hotstar <noreply@hotstar.com>', subject: 'Payment received', date: '2026-01-05',
    text: 'Super plan 1 year subscription. Amount paid Rs. 1,499 via UPI' });
  assert.equal(r.name, 'JioHotstar'); assert.equal(r.amount, 1499); assert.equal(r.cycle, 'Yearly'); assert.equal(r.payment, 'UPI');
});

t('reads dollar receipts', () => {
  const r = parseReceipt({ from: 'OpenAI <noreply@tm.openai.com>', subject: 'Your ChatGPT Plus receipt', date: '2026-10-21', text: 'Total $20.00 Visa ending in 1107' });
  assert.equal(r.name, 'ChatGPT'); assert.equal(r.amount, 20); assert.equal(r.currency, 'USD'); assert.equal(r.last4, '1107');
});

t('picks up a stated renewal date', () => {
  const r = parseReceipt({ from: 'Apple <no_reply@email.apple.com>', subject: 'Your receipt from Apple', date: '2026-10-29', text: 'Apple Music Individual Renews 29 Nov 2026 ₹119' });
  assert.equal(r.renewDate, '2026-11-29');
  const r2 = parseReceipt({ from: 'Apple <no_reply@email.apple.com>', subject: 'Receipt', date: '2026-10-29', text: 'iCloud+ 50 GB. Your plan renews on December 3, 2026. ₹75' });
  assert.equal(r2.name, 'iCloud+'); assert.equal(r2.renewDate, '2026-12-03');
});

t('ignores marketing, orders and security emails', () => {
  assert.equal(parseReceipt({ from: 'Netflix <info@mailer.netflix.com>', subject: 'New on Netflix', date: today, text: 'Top 10 shows. Watch now.' }), null);
  assert.equal(parseReceipt({ from: 'Zomato <noreply@zomato.com>', subject: 'Your order has been delivered', date: today, text: 'Order total ₹412' }), null);
  assert.equal(parseReceipt({ from: 'Google <no-reply@accounts.google.com>', subject: 'Security alert', date: today, text: 'New sign-in' }), null);
  assert.equal(parseReceipt({ from: 'Claude <support@mail.anthropic.com>', subject: 'Your sign-in link', date: today, text: 'Click the magic link to log in to Claude' }), null);
  assert.equal(parseReceipt({ from: 'Random <a@example.com>', subject: 'Receipt', date: today, text: 'Total ₹99' }), null);
});

t('does not confuse Apple Music with iCloud, or YouTube with Gemini', () => {
  assert.equal(parseReceipt({ from: 'Apple <no_reply@email.apple.com>', subject: 'Receipt', date: today, text: 'Apple Music Student ₹59' }).name, 'Apple Music');
  assert.equal(parseReceipt({ from: 'Google Payments <payments-noreply@google.com>', subject: 'Your YouTube Premium receipt', date: today, text: 'YouTube Premium ₹149' }).name, 'YouTube Premium');
  assert.equal(parseReceipt({ from: 'Google <payments-noreply@google.com>', subject: 'Google One AI Premium receipt', date: today, text: 'Gemini Advanced in Google One ₹1,950' }).name, 'Gemini');
});

t('flags cancellations', () => {
  const r = parseReceipt({ from: 'Sony LIV <noreply@sonyliv.com>', subject: 'Your Sony LIV subscription has been cancelled', date: today, text: 'Premium will not renew' });
  assert.equal(r.cancelled, true);
});

t('groups receipts into one suggestion per service', () => {
  const rs = [
    { from: 'Spotify <no-reply@spotify.com>', subject: 'Your receipt', date: '2026-10-28', text: 'Premium ₹119 Total ₹119' },
    { from: 'Spotify <no-reply@spotify.com>', subject: 'Your receipt', date: '2026-09-28', text: 'Premium ₹119 Total ₹119' },
  ].map(parseReceipt);
  const [s] = groupFindings(rs, today);
  assert.equal(s.name, 'Spotify'); assert.equal(s.receipts, 2); assert.equal(s.cycle, 'Monthly');
  assert.equal(s.date, '2026-11-28'); assert.equal(s.cost, 119); assert.equal(s.status, 'new');
});

t('infers a yearly cycle from the gap between receipts', () => {
  const rs = [
    { from: 'Notion <team@makenotion.com>', subject: 'Your receipt', date: '2026-03-02', text: 'Plus plan ₹8,000 Total ₹8,000' },
    { from: 'Notion <team@makenotion.com>', subject: 'Your receipt', date: '2025-03-02', text: 'Plus plan ₹8,000 Total ₹8,000' },
  ].map(parseReceipt);
  const [s] = groupFindings(rs, today);
  assert.equal(s.cycle, 'Yearly'); assert.equal(s.date, '2027-03-02');
});

t('marks tracked, cancelled and lapsed services', () => {
  const rs = [
    { from: 'Spotify <no-reply@spotify.com>', subject: 'Receipt', date: '2026-10-28', text: 'Premium Total ₹119' },
    { from: 'Sony LIV <noreply@sonyliv.com>', subject: 'Payment successful', date: '2026-09-10', text: 'Premium Monthly ₹299' },
    { from: 'Sony LIV <noreply@sonyliv.com>', subject: 'Your subscription has been cancelled', date: '2026-10-10', text: 'Premium cancelled' },
    { from: 'Zee5 <no-reply@zee5.com>', subject: 'Payment received', date: '2026-05-01', text: 'Premium monthly plan ₹99' },
  ].map(parseReceipt);
  const g = Object.fromEntries(groupFindings(rs, today, ['Spotify']).map(x => [x.name, x.status]));
  assert.deepEqual(g, { Spotify: 'tracked', SonyLiv: 'cancelled', Zee5: 'stale' });
});

t('converts dollar amounts to rupees', () => {
  const [s] = groupFindings([parseReceipt({ from: 'OpenAI <noreply@tm.openai.com>', subject: 'ChatGPT Plus receipt', date: '2026-10-21', text: 'Total $20.00' })], today);
  assert.equal(s.converted, 20); assert.ok(s.cost > 1000 && s.cost < 3000);
});

t('demo inbox finds the expected services', () => {
  const found = groupFindings(demoInbox(today).map(parseReceipt), today, ['Spotify', 'Netflix']);
  const byName = Object.fromEntries(found.map(f => [f.name, f.status]));
  assert.deepEqual(byName, { 'Apple Music': 'new', ChatGPT: 'new', 'Zomato Gold': 'new', SonyLiv: 'cancelled', Spotify: 'tracked', Netflix: 'tracked' });
});

console.log(`\n${passed} passed`);
