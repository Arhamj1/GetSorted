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

t('Netflix billed through Airtel is marked free via partner', () => {
  const rs = [
    { from: 'Netflix <info@account.netflix.com>', subject: 'Your Netflix membership', date: '2026-11-08', text: 'Your membership is billed through your Airtel plan. Plan: Basic' },
    { from: 'Netflix <info@account.netflix.com>', subject: 'Your Netflix membership', date: '2026-10-08', text: 'Your membership is billed through your Airtel plan. Plan: Basic' },
  ].map(parseReceipt);
  const [s] = groupFindings(rs, today);
  assert.equal(s.status, 'free'); assert.equal(s.partner, 'Airtel'); assert.equal(s.cost, 0);
});

t('a free plan that is about to expire is marked ending', () => {
  const rs = [
    { from: 'OpenAI <noreply@tm.openai.com>', subject: 'Your ChatGPT Go receipt', date: '2025-11-20', text: 'ChatGPT Go 12 months free. Total ₹0.00' },
    { from: 'OpenAI <noreply@tm.openai.com>', subject: 'Your ChatGPT Go subscription is expiring soon', date: '2026-11-05', text: 'Your free ChatGPT Go access expires on 20 Nov 2026. Add a payment method to keep Go.' },
  ].map(parseReceipt);
  const [s] = groupFindings(rs, today);
  assert.equal(s.status, 'ending'); assert.equal(s.endDate, '2026-11-20'); assert.equal(s.date, '2026-11-20'); assert.equal(s.cost, 0);
});

t('an end date in the past counts as cancelled', () => {
  const [s] = groupFindings([parseReceipt({ from: 'OpenAI <noreply@tm.openai.com>', subject: 'Your ChatGPT Go plan', date: '2026-10-01', text: 'Your Go plan will end on 15 Oct 2026.' })], today);
  assert.equal(s.status, 'cancelled');
});

t('ignores Amazon order emails that mention Prime in the footer', () => {
  assert.equal(parseReceipt({ from: 'Amazon.in <auto-confirm@amazon.in>', subject: 'Your Amazon.in order of "USB cable" has shipped', date: today,
    text: 'Order total ₹67. Enjoy FREE delivery with Amazon Prime. Prime members save more every year.' }), null);
  assert.equal(parseReceipt({ from: 'Amazon.in <store-news@amazon.in>', subject: 'Prime Video: thanks for renting', date: today, text: 'Rental ₹67 Prime Video' }), null);
  const real = parseReceipt({ from: 'Amazon.in <prime@amazon.in>', subject: 'Your Amazon Prime membership has been renewed', date: '2026-10-30', text: 'Prime annual membership Total ₹1,499' });
  assert.equal(real.name, 'Amazon Prime Video'); assert.equal(real.amount, 1499); assert.equal(real.cycle, 'Yearly');
});

t('an ended Prime membership stays ended despite later ads', () => {
  const amz = (subject, date, text) => ({ from: 'Amazon.in <store-news@amazon.in>', subject, date, text });
  const rs = [
    amz("The road to power is paved with betrayal. Join Prime Lite to watch 'Mirzapur'", '2026-10-30', 'Join Prime Lite for ₹67 a month. Amazon Prime membership benefits.'),
    amz('Your Amazon Prime membership has ended', '2026-09-22', 'Your Prime membership has ended. Rejoin Amazon Prime anytime.'),
    amz("You aren't taking full advantage of your Prime membership", '2026-09-02', 'Your Prime membership includes Prime Video.'),
    amz("You aren't taking full advantage of your Prime membership", '2026-08-14', 'Your Prime membership includes Prime Video.'),
  ].map(parseReceipt);
  const [s] = groupFindings(rs, today);
  assert.equal(s.status, 'cancelled'); assert.equal(s.cost, null);
  assert.equal(s.sources[0].ad, true); assert.equal(s.sources[1].cancelled, true);
});

t('Netflix promo emails never set a billing date', () => {
  const nf = (subject, date) => ({ from: 'Netflix <info@mailer.netflix.com>', subject, date, text: 'Watch on any device. Your Netflix membership. Change plan.' });
  const promos = [
    nf("Don't forget to finish The Great Indian Kapil Show", '2026-11-08'), nf('Diwali just got better', '2026-11-06'),
    nf('Top suggestions for Arhamj601', '2026-11-04'), nf('What do you think of Chumbak?', '2026-10-23'),
    nf('🔔 Reminder: Chumbak is back', '2026-10-01'), nf("Get to know the 'Chumbak' community. 🏠", '2026-09-20'),
  ].map(parseReceipt);
  assert.ok(promos.every(r => r.promo));
  assert.equal(groupFindings(promos, today).length, 0);
  const withReceipt = [...promos, parseReceipt({ from: 'Netflix <info@account.netflix.com>', subject: 'Your Netflix membership payment', date: '2026-10-12', text: 'Premium plan ₹649 Total ₹649' })];
  const [s] = groupFindings(withReceipt, today);
  assert.equal(s.lastDate, '2026-10-12'); assert.equal(s.date, '2026-11-12'); assert.equal(s.cost, 649);
});

t('a payment after a cancellation means it is active again', () => {
  const rs = [
    { from: 'Spotify <no-reply@spotify.com>', subject: 'Your Spotify Premium receipt', date: '2026-10-28', text: 'Premium ₹119 Total ₹119' },
    { from: 'Spotify <no-reply@spotify.com>', subject: 'Your Premium has been cancelled', date: '2026-08-01', text: 'Premium cancelled' },
  ].map(parseReceipt);
  assert.equal(groupFindings(rs, today)[0].status, 'new');
});

t('a service seen only in ads is not suggested', () => {
  const r = parseReceipt({ from: 'Amazon.in <store-news@amazon.in>', subject: 'Watch the new season on Prime Video', date: today, text: 'Amazon Prime membership ₹1,499' });
  assert.equal(groupFindings([r], today).length, 0);
});

t('footer text about "a year" does not flip a monthly plan to yearly', () => {
  const filler = ' lorem ipsum'.repeat(60);
  const r = parseReceipt({ from: 'Spotify <no-reply@spotify.com>', subject: 'Your receipt', date: today,
    text: 'Premium Individual monthly Total ₹119.' + filler + ' Save 2 months with a year of Premium.' });
  assert.equal(r.cycle, 'Monthly');
});

t('keeps the email subjects so users can see why', () => {
  const [s] = groupFindings([parseReceipt({ from: 'Spotify <no-reply@spotify.com>', subject: 'Your Spotify receipt', date: '2026-11-01', text: 'Premium Total ₹119' })], today);
  assert.equal(s.sources[0].subject, 'Your Spotify receipt'); assert.equal(s.sources[0].amount, 119);
});

t('demo inbox finds the expected services', () => {
  const found = groupFindings(demoInbox(today).map(parseReceipt), today, ['Spotify', 'Netflix']);
  const byName = Object.fromEntries(found.map(f => [f.name, f.status]));
  assert.deepEqual(byName, { 'Apple Music': 'new', ChatGPT: 'new', 'Zomato Gold': 'new', Zee5: 'free', SonyLiv: 'cancelled', Spotify: 'tracked', Netflix: 'tracked' });
});

console.log(`\n${passed} passed`);
