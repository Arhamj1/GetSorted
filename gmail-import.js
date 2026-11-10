/* ════════════════════════════════════════════════════════════════
   GetSorted — Import subscriptions from Gmail receipts

   • Read-only Gmail access through Google Identity Services.
   • Everything runs in the browser: emails are fetched, parsed and
     thrown away here. Nothing from the inbox is stored; only the
     subscriptions the user ticks are saved (like a normal "Add").
   • The parser half (RULES, parseReceipt, groupFindings) has no DOM
     dependencies so it can be tested in Node: scripts/test-gmail-parser.mjs
════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* Paste the OAuth "Web application" client ID from Google Cloud here.
     Until it's set, the import only runs in demo mode. */
  const GOOGLE_CLIENT_ID = '';

  const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
  const USD_INR = 88; // rough rate for receipts billed in dollars; the user can edit the amount
  const LOOKBACK_DAYS = 400;
  const MAX_MESSAGES = 250;

  /* ─── Which senders mean which subscription ─── */
  const RULES = [
    { name:'Netflix',            domains:['netflix.com'],                  need:/payment|receipt|billing|membership|invoice|charged|renew|plan/i, skip:/new device|sign[- ]?in|household|password|top 10|new arrival|watch now/i },
    { name:'Amazon Prime Video', domains:['amazon.in','amazon.com','primevideo.com'], need:/prime (membership|video)|amazon prime/i, skip:/shipped|delivered|out for delivery|your order|arriving|deal/i },
    { name:'JioHotstar',         domains:['hotstar.com','jiohotstar.com','startv.com'], need:/subscription|payment|receipt|plan|renew|invoice/i },
    { name:'SonyLiv',            domains:['sonyliv.com'],                  need:/subscription|payment|receipt|plan|renew|invoice|premium/i },
    { name:'Zee5',               domains:['zee5.com'],                     need:/subscription|payment|receipt|plan|renew|invoice|premium/i },
    { name:'YouTube Premium',    domains:['youtube.com','google.com'],     need:/youtube (music )?premium/i },
    { name:'Spotify',            domains:['spotify.com'],                  need:/premium|receipt|payment|plan|charged|renew|invoice/i, skip:/wrapped|new release|playlist|podcast/i },
    { name:'Apple Music',        domains:['apple.com'],                    need:/apple music/i },
    { name:'iCloud+',            domains:['apple.com'],                    need:/icloud\+|icloud storage|icloud plan/i },
    { name:'ChatGPT',            domains:['openai.com'],                   need:/chatgpt|receipt|invoice|subscription/i, skip:/api usage|verify|log ?in|reset/i },
    { name:'Claude',             domains:['anthropic.com'],                need:/claude|receipt|invoice|subscription/i, skip:/verify|log ?in|magic link|sign[- ]?in/i },
    { name:'Gemini',             domains:['google.com'],                   need:/google one|gemini|google ai (pro|premium|ultra)/i, skip:/youtube/i },
    { name:'Zomato Gold',        domains:['zomato.com'],                   need:/gold/i, skip:/your order|delivered|on the way|rate your/i },
    { name:'Swiggy One',         domains:['swiggy.in','swiggy.com'],       need:/swiggy one/i, skip:/your order|delivered|on the way|rate your/i },
    { name:'Notion',             domains:['notion.so','makenotion.com'],   need:/receipt|invoice|payment|plus plan|subscription/i, skip:/invited you|shared|mentioned/i },
  ];
  const ALL_DOMAINS = [...new Set(RULES.flatMap(r => r.domains))];
  const NOT_A_RECEIPT = /\b(otp|one[- ]time (password|code)|verification code|verify your|sign[- ]?in attempt|reset your password|security alert|confirm your email)\b/i;
  const CANCELLED = /\b(cancel(l)?ed|cancellation|has ended|subscription ended|won'?t renew|will not renew|membership ended|refund(ed)?)\b/i;

  const BANK_WORDS = [
    ['HDFC', /\bHDFC\b/i], ['ICICI', /\bICICI\b/i], ['SBI', /\bSBI\b|state bank/i], ['Axis', /\baxis bank\b|\baxis\b/i],
    ['Kotak', /\bkotak\b/i], ['Yes Bank', /\byes bank\b/i], ['IndusInd', /\bindusind\b/i], ['IDFC FIRST', /\bidfc\b/i],
    ['Amex', /american express|\bamex\b/i], ['HSBC', /\bhsbc\b/i], ['Citi', /\bciti(bank)?\b/i], ['RBL', /\brbl\b/i],
    ['AU Bank', /\bau small finance\b/i], ['Federal', /\bfederal bank\b/i], ['StanChart', /standard chartered/i],
  ];
  const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, sept:8, oct:9, nov:10, dec:11 };

  /* ─── Small date helpers (ISO yyyy-mm-dd strings) ─── */
  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const dayDiff = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 86400000);
  function addCycle(s, cycle) {
    const d = parseISO(s), day = d.getDate();
    d.setDate(1);
    if (cycle === 'Yearly') d.setFullYear(d.getFullYear() + 1); else d.setMonth(d.getMonth() + 1);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
    return iso(d);
  }

  /* ─── Parsing one email ─── */
  function senderDomain(from) {
    const m = String(from || '').match(/@([a-z0-9.-]+)/i);
    return m ? m[1].toLowerCase() : '';
  }
  const domainMatches = (dom, list) => list.some(d => dom === d || dom.endsWith('.' + d));

  function findAmount(text) {
    const num = s => parseFloat(s.replace(/,/g, ''));
    const INR = /(?:₹|\bRs\.?|\bINR)\s?([0-9]{1,3}(?:,[0-9]{2,3})+(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/gi;
    const USD = /(?:US\$|\bUSD\s?\$?|\$)\s?([0-9]+(?:\.[0-9]{1,2})?)/gi;
    const KEY = /(total|amount (paid|charged|due)?|charged|you paid|paid|price|grand total|order total|billed)/gi;
    const pick = (re, cur) => {
      const all = [...text.matchAll(re)].map(m => ({ v: num(m[1]), i: m.index, cur })).filter(a => a.v > 0 && a.v < 100000);
      if (!all.length) return null;
      // Prefer an amount just after a "total / charged / paid" word
      for (const k of text.matchAll(KEY)) {
        const near = all.find(a => a.i >= k.index && a.i - k.index < 80);
        if (near) return near;
      }
      return all[0];
    };
    return pick(INR, 'INR') || pick(USD, 'USD');
  }

  function findCycle(text) {
    if (/\b(annual(ly)?|yearly|per year|a year|\/\s?(yr|year)\b|12[- ]months?|1[- ]year|365 days)\b/i.test(text)) return 'Yearly';
    if (/\b(monthly|per month|a month|\/\s?(mo|month)\b|1[- ]month|30 days)\b/i.test(text)) return 'Monthly';
    return null;
  }

  const monthIdx = w => MONTHS[w.slice(0, 4).toLowerCase()] ?? MONTHS[w.slice(0, 3).toLowerCase()];
  function parseLooseDate(s) {
    let m = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/);   // 12 Dec 2026
    if (m && monthIdx(m[2]) !== undefined) return iso(new Date(+m[3], monthIdx(m[2]), +m[1]));
    m = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);        // December 12, 2026
    if (m && monthIdx(m[1]) !== undefined) return iso(new Date(+m[3], monthIdx(m[1]), +m[2]));
    m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);                                             // 2026-12-12
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    return null;
  }

  function findRenewal(text) {
    const re = /(renew(s|al)?( on| date)?|next (billing|payment|charge|bill)( date)?|valid (till|until|through)|will be charged on|expires? on|until)\s*:?\s*/gi;
    for (const m of text.matchAll(re)) {
      const d = parseLooseDate(text.slice(m.index + m[0].length, m.index + m[0].length + 40));
      if (d) return d;
    }
    return null;
  }

  function findPayment(text) {
    const last4 = (text.match(/(?:ending(?:\s+(?:in|with))?|card\s*(?:no\.?|number)?\s*[:#]?\s*[x*•·]{2,}[\s-]*|[x*•·]{4,}[\s-]*)\s*(\d{4})\b/i) || [])[1] || '';
    const bankHit = BANK_WORDS.find(([, re]) => re.test(text));
    const isCard = !!last4 || /\b(visa|mastercard|master card|rupay|amex|credit card|debit card)\b/i.test(text) || !!bankHit;
    if (/\bUPI\b/i.test(text) && !last4) return { payment: 'UPI', bank: '', last4: '' };
    if (isCard) return { payment: 'Card', bank: bankHit ? bankHit[0] : '', last4 };
    return { payment: 'UPI', bank: '', last4: '' };
  }

  /** msg: { from, subject, date (ISO), text } → receipt or null */
  function parseReceipt(msg) {
    const dom = senderDomain(msg.from);
    const text = `${msg.subject || ''}\n${msg.text || ''}`.replace(/\s+/g, ' ');
    if (!dom || NOT_A_RECEIPT.test(text)) return null;
    const rule = RULES.find(r => domainMatches(dom, r.domains) && r.need.test(text) && !(r.skip && r.skip.test(text)));
    if (!rule) return null;
    const amount = findAmount(text);
    const cancelled = CANCELLED.test(msg.subject || '') || /subscription (has been |was )?cancel/i.test(text);
    return {
      name: rule.name,
      date: msg.date,
      amount: amount ? amount.v : null,
      currency: amount ? amount.cur : null,
      cycle: findCycle(text),
      renewDate: findRenewal(text),
      cancelled,
      ...findPayment(text),
    };
  }

  /** receipts → one suggestion per service */
  function groupFindings(receipts, todayISO, trackedNames = []) {
    const by = new Map();
    receipts.filter(Boolean).forEach(r => { if (!by.has(r.name)) by.set(r.name, []); by.get(r.name).push(r); });
    const out = [];
    for (const [name, list] of by) {
      list.sort((a, b) => (a.date < b.date ? 1 : -1));
      const newest = list[0];
      const paid = list.filter(r => !r.cancelled);
      const withAmt = paid.find(r => r.amount) || list.find(r => r.amount);

      let cycle = newest.cycle || (paid.find(r => r.cycle) || {}).cycle || null;
      if (!cycle && paid.length >= 2) cycle = Math.abs(dayDiff(paid[1].date, paid[0].date)) > 200 ? 'Yearly' : 'Monthly';
      cycle = cycle || 'Monthly';

      let cost = withAmt ? withAmt.amount : null, converted = null;
      if (withAmt && withAmt.currency === 'USD') { converted = withAmt.amount; cost = Math.round(withAmt.amount * USD_INR); }

      const anchor = paid[0] || newest;
      let next = anchor.renewDate && anchor.renewDate >= todayISO ? anchor.renewDate : null;
      if (!next) { next = anchor.date; let g = 0; while (next < todayISO && g++ < 60) next = addCycle(next, cycle); }

      const lastPaid = paid[0] ? paid[0].date : null;
      const tooOld = lastPaid && dayDiff(lastPaid, todayISO) > (cycle === 'Yearly' ? 400 : 75);
      let status = 'new';
      if (trackedNames.includes(name)) status = 'tracked';
      else if (newest.cancelled) status = 'cancelled';
      else if (!lastPaid || tooOld) status = 'stale';

      const pay = paid.find(r => r.last4) || paid.find(r => r.payment === 'Card') || anchor;
      out.push({
        name, cost, converted, cycle, date: next, status,
        payment: pay.payment, bank: pay.bank, last4: pay.last4,
        receipts: list.length, lastDate: newest.date,
      });
    }
    const order = { new: 0, stale: 1, cancelled: 2, tracked: 3 };
    return out.sort((a, b) => order[a.status] - order[b.status] || (b.cost || 0) - (a.cost || 0));
  }

  /* ════════════════════════════════════════════
     Gmail API (browser only)
  ════════════════════════════════════════════ */
  function loadGIS() {
    if (global.google && global.google.accounts && global.google.accounts.oauth2) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true; s.onload = () => res(); s.onerror = () => rej(new Error('Could not load Google sign-in.'));
      document.head.appendChild(s);
    });
  }
  async function getToken(hintEmail) {
    await loadGIS();
    return new Promise((res, rej) => {
      const client = global.google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID, scope: SCOPE, hint: hintEmail || undefined, prompt: '',
        callback: r => (r && r.access_token ? res(r.access_token) : rej(new Error(r && r.error_description || 'Google sign-in was cancelled.'))),
        error_callback: e => rej(new Error(e && e.type === 'popup_closed' ? 'Google sign-in was closed.' : 'Google sign-in failed.')),
      });
      client.requestAccessToken();
    });
  }
  async function gmail(token, path) {
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error(r.status === 403 ? 'Gmail access was not granted.' : `Gmail request failed (${r.status}).`);
    return r.json();
  }
  function b64(data) {
    const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  }
  function bodyText(payload) {
    let plain = '', html = '';
    (function walk(p) {
      if (!p) return;
      if (p.body && p.body.data) {
        if (p.mimeType === 'text/plain') plain += b64(p.body.data) + '\n';
        else if (p.mimeType === 'text/html') html += b64(p.body.data) + '\n';
      }
      (p.parts || []).forEach(walk);
    })(payload);
    if (plain.trim()) return plain;
    return html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&#8377;|&#x20b9;/gi, '₹').replace(/&amp;/g, '&').replace(/&[a-z]+;/g, ' ');
  }

  async function scanGmail(token, onProgress) {
    const q = `from:(${ALL_DOMAINS.join(' OR ')}) newer_than:${LOOKBACK_DAYS}d -in:chats`;
    const ids = [];
    let pageToken = '';
    do {
      const res = await gmail(token, `messages?maxResults=100&q=${encodeURIComponent(q)}${pageToken ? '&pageToken=' + pageToken : ''}`);
      (res.messages || []).forEach(m => ids.push(m.id));
      pageToken = res.nextPageToken || '';
    } while (pageToken && ids.length < MAX_MESSAGES);
    const list = ids.slice(0, MAX_MESSAGES);
    onProgress(0, list.length);

    const receipts = [];
    let done = 0;
    const worker = async () => {
      while (list.length) {
        const id = list.shift();
        try {
          const m = await gmail(token, `messages/${id}?format=full`);
          const h = n => ((m.payload.headers || []).find(x => x.name.toLowerCase() === n) || {}).value || '';
          const d = new Date(Number(m.internalDate));
          receipts.push(parseReceipt({ from: h('from'), subject: h('subject'), date: iso(d), text: bodyText(m.payload) || m.snippet }));
        } catch (e) { /* skip unreadable message */ }
        onProgress(++done, done + list.length);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker(), worker()]);
    return receipts.filter(Boolean);
  }

  /* ─── Demo inbox: realistic receipts run through the same parser ─── */
  function demoInbox(todayISO) {
    const ago = n => { const d = parseISO(todayISO); d.setDate(d.getDate() - n); return iso(d); };
    return [
      { from:'Apple <no_reply@email.apple.com>', subject:'Your receipt from Apple', date:ago(12), text:'Apple Music Individual (Monthly) Renews ' + addCycle(ago(12), 'Monthly') + ' ₹119.00 Billed to HDFC Bank Credit Card •••• 4821 Total ₹119.00' },
      { from:'Apple <no_reply@email.apple.com>', subject:'Your receipt from Apple', date:ago(42), text:'Apple Music Individual (Monthly) ₹119.00 Total ₹119.00' },
      { from:'OpenAI <noreply@tm.openai.com>', subject:'Your ChatGPT Plus receipt', date:ago(20), text:'ChatGPT Plus Subscription Qty 1 $20.00 Total $20.00 Amount paid $20.00 Visa ending in 1107' },
      { from:'Zomato <noreply@zomato.com>', subject:'Welcome to Zomato Gold! Your membership is active', date:ago(95), text:'Zomato Gold 12 months membership. Amount paid: Rs. 30 via UPI. Valid till ' + addCycle(ago(95), 'Yearly') },
      { from:'Sony LIV <noreply@sonyliv.com>', subject:'Your Sony LIV subscription has been cancelled', date:ago(30), text:'Your Premium subscription has been cancelled and will not renew.' },
      { from:'Sony LIV <noreply@sonyliv.com>', subject:'Payment successful - Sony LIV Premium', date:ago(60), text:'Premium Monthly plan ₹299 charged via UPI' },
      { from:'Spotify <no-reply@spotify.com>', subject:'Your Spotify Premium receipt', date:ago(27), text:'Premium Individual ₹119.00 per month. Total ₹119.00 charged to UPI' },
      { from:'Netflix <info@account.netflix.com>', subject:'Your Netflix membership payment', date:ago(29), text:'Thanks for your payment. Premium plan ₹649 Payment method: HDFC •••• 4821' },
      { from:'Netflix <info@mailer.netflix.com>', subject:'New on Netflix this week', date:ago(3), text:'Top 10 shows. Watch now.' },
      { from:'Zomato <noreply@zomato.com>', subject:'Your order from Burger King has been delivered', date:ago(2), text:'Order total ₹412' },
      { from:'Google <no-reply@accounts.google.com>', subject:'Security alert', date:ago(5), text:'A new sign-in on Windows' },
    ];
  }

  global.GmailImport = {
    RULES, parseReceipt, groupFindings, demoInbox,
    isConfigured: () => !!GOOGLE_CLIENT_ID,
    getToken, scanGmail,
    revoke: token => { try { global.google.accounts.oauth2.revoke(token, () => {}); } catch (e) {} },
    todayISO: () => iso(new Date()),
  };
})(typeof window !== 'undefined' ? window : globalThis);
