// PROTOTYPE, throwaway. Spike for issue #19: dry-run one real Greenhouse application.
// Opens a live hosted form, fills every field with dummy data, uploads a test resume,
// and STOPS BEFORE SUBMIT. It never clicks submit, cancels any form submit event,
// and aborts every non-GET request to Greenhouse application hosts.
//
// Usage: node spike.mjs <board> <jobId> [--headful]
//   Optional: ANTHROPIC_API_KEY + ANTHROPIC_MODEL to answer free-text/unknown questions with an LLM
//   (prices via LLM_IN_PER_MTOK / LLM_OUT_PER_MTOK, default 3 / 15 USD).
import { chromium } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';

const [board, jobId] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const headful = process.argv.includes('--headful');
if (!board || !jobId) throw new Error('usage: node spike.mjs <board> <jobId> [--headful]');

const outDir = `out/${board}-${jobId}-${headful ? 'headful' : 'headless'}-${Date.now()}`;
mkdirSync(outDir, { recursive: true });
const t0 = Date.now();
const report = {
  board, jobId, headful, host: os.hostname(), startedAt: new Date().toISOString(),
  publicIp: null, steps: [], fields: [], challenges: [], blockedRequests: [], otherWrites: [],
  submitEventsCancelled: 0, memory: { peakBrowserRssMb: 0, minMemAvailableMb: Infinity, samples: 0 },
  llm: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, submitted: false,
};

async function step(name, fn) {
  const s = Date.now();
  try {
    const detail = await fn();
    report.steps.push({ name, ok: true, ms: Date.now() - s, detail });
    console.log(`✓ ${name} (${Date.now() - s} ms)`);
    return detail;
  } catch (e) {
    report.steps.push({ name, ok: false, ms: Date.now() - s, error: String(e).slice(0, 500) });
    console.log(`✗ ${name}: ${e}`);
    return undefined;
  }
}

// ---- memory sampling: RSS of every chromium process descended from this node process
function sampleMemory() {
  try {
    const rows = execSync('ps -eo pid=,ppid=,rss=,comm=').toString().trim().split('\n')
      .map((l) => l.trim().split(/\s+/)).map(([pid, ppid, rss, comm]) => ({ pid: +pid, ppid: +ppid, rss: +rss, comm }));
    const kids = new Set([process.pid]);
    let grew = true;
    while (grew) { grew = false; for (const r of rows) if (kids.has(r.ppid) && !kids.has(r.pid)) { kids.add(r.pid); grew = true; } }
    const rss = rows.filter((r) => kids.has(r.pid) && r.pid !== process.pid).reduce((a, r) => a + r.rss, 0) / 1024;
    const avail = +readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/)[1] / 1024;
    report.memory.peakBrowserRssMb = Math.max(report.memory.peakBrowserRssMb, Math.round(rss));
    report.memory.minMemAvailableMb = Math.min(report.memory.minMemAvailableMb, Math.round(avail));
    report.memory.samples++;
  } catch {}
}
report.memory.memAvailableAtStartMb = Math.round(+readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/)[1] / 1024);
const memTimer = setInterval(sampleMemory, 500);

// ---- dummy candidate (obviously fake, reserved example.com domain)
const P = {
  first: 'Dryrun', last: 'Spiketest', email: 'dryrun.spiketest@example.com', phone: '5125550147',
  city: 'Austin', country: 'United States', linkedin: 'https://www.linkedin.com/in/dryrun-spiketest-example',
  website: 'https://example.com',
};

async function makeResume() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines = [
    `${P.first} ${P.last}`, `${P.email} | (512) 555-0147 | ${P.city}, TX`, '',
    'TEST RESUME FOR AN AUTOMATED DRY RUN. NOT A REAL CANDIDATE.', '',
    'Experience', 'Senior Software Engineer, Example Corp (2019-2026)',
    '- Built TypeScript services handling 10k requests per second.',
    'Software Engineer, Sample LLC (2015-2019)', '- Shipped React applications.', '',
    'Education', 'B.S. Computer Science, Example University (2015)',
  ];
  lines.forEach((l, i) => page.drawText(l, { x: 50, y: 740 - i * 18, size: 11, font }));
  const path = `${outDir}/resume.pdf`;
  writeFileSync(path, await doc.save());
  return path;
}

// ---- answers: deterministic by label first; LLM (if configured) or canned text for the rest
function ruleAnswer(label, options) {
  const l = label.toLowerCase();
  const pick = (...needles) => options?.find((o) => needles.some((n) => o.toLowerCase().includes(n)));
  if (/^first name/.test(l) || l.includes('preferred first') || l.includes('preferred name')) return P.first;
  if (/^last name/.test(l)) return P.last;
  if (l.startsWith('email')) return P.email;
  if (l.startsWith('phone')) return P.phone;
  if (l.includes('linkedin')) return P.linkedin;
  if (l.includes('website') || l.includes('portfolio') || l.includes('github')) return P.website;
  if (l === 'country' || l.startsWith('country')) return P.country;
  if (l.includes('location') || l.includes('city') || l.includes('where do you intend to work') || l.includes('where are you located')) return options ? pick('united states', 'us', 'austin', 'remote') : `${P.city}, TX, United States`;
  if (options) {
    if (l.includes('authorized') || l.includes('eligible') || l.includes('legally')) return pick('yes');
    if (l.includes('sponsor')) return pick('no');
    if (l.includes('worked for') || l.includes('previously') || l.includes('ever been employed')) return pick('no');
    if (l.includes('gender') || l.includes('hispanic') || l.includes('race') || l.includes('veteran') || l.includes('disab') || l.includes('pronoun') || l.includes('ethnic') || l.includes('orientation'))
      return pick("don't wish", 'decline', 'prefer not', 'not wish', 'do not want');
    if (l.includes('privacy') || l.includes('consent') || l.includes('acknowledge') || l.includes('agree')) return pick('yes', 'agree', 'acknowledge', 'confirm');
  }
  if (l.includes('salary') || l.includes('compensation')) return 'Open to discussing; flexible within the posted range.';
  if (l.includes('additional information') || l.includes('cover letter')) return null; // optional, leave empty
  return undefined;
}

async function llmAnswers(questions, jobTitle) {
  if (!process.env.ANTHROPIC_API_KEY || !process.env.ANTHROPIC_MODEL || questions.length === 0) return {};
  const prompt = `You are filling a job application for a FAKE test candidate (a TypeScript engineer, 10 years, Austin TX, US citizen, needs no sponsorship) for "${jobTitle}". Answer each question plausibly and briefly. For questions with options, answer with the exact option text. Reply with only a JSON object mapping key to answer.\n\n${JSON.stringify(questions)}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`LLM ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  const inp = j.usage.input_tokens, out = j.usage.output_tokens;
  report.llm.calls++; report.llm.inputTokens += inp; report.llm.outputTokens += out;
  report.llm.costUsd += (inp * +(process.env.LLM_IN_PER_MTOK ?? 3) + out * +(process.env.LLM_OUT_PER_MTOK ?? 15)) / 1e6;
  return JSON.parse(j.content[0].text.match(/\{[\s\S]*\}/)[0]);
}

const CANNED = 'I build reliable TypeScript products end to end and want to work on tools people use every day. This role matches my experience shipping and operating user-facing services. (Automated dry-run test text, not a real application.)';

// ---- challenge / block detection
async function detectChallenges(page, phase) {
  const found = await page.evaluate(() => {
    const out = [];
    const txt = document.body?.innerText?.slice(0, 5000).toLowerCase() ?? '';
    for (const f of document.querySelectorAll('iframe')) {
      const s = f.src || '';
      const r = f.getBoundingClientRect();
      const visible = r.width > 30 && r.height > 30 && getComputedStyle(f).visibility !== 'hidden';
      if (/recaptcha\/.*bframe/.test(s) && visible) out.push('recaptcha visible challenge (bframe)');
      if (/hcaptcha/.test(s)) out.push(`hcaptcha iframe${visible ? ' (visible)' : ''}`);
      if (/challenges\.cloudflare|turnstile/.test(s)) out.push('cloudflare turnstile');
    }
    if (txt.includes('just a moment') || txt.includes('checking your browser')) out.push('cloudflare interstitial');
    if (txt.includes('access denied') || txt.includes('request blocked') || txt.includes('unusual traffic')) out.push('block page text');
    if (txt.includes('verification code') || txt.includes('security code')) out.push('email/security code prompt');
    const scripts = [...document.scripts].map((s) => s.src).filter((s) => /captcha|turnstile/.test(s));
    return { out, scripts };
  });
  for (const c of found.out) report.challenges.push({ phase, kind: c });
  return found;
}

// ---- DOM discovery (the DOM is the truth; schema only seeds option lists)
async function discover(page) {
  return page.evaluate(() => {
    const form = document.querySelector('form#application-form');
    if (!form) return null;
    const out = [];
    for (const el of form.querySelectorAll('input, textarea, select')) {
      if (!el.id || el.type === 'hidden' || el.type === 'search' || el.disabled) continue;
      if (el.closest('.iti__dropdown-content')) continue;
      const label = (el.labels?.[0]?.innerText || el.getAttribute('aria-label') || document.querySelector(`[for="${el.id}"]`)?.innerText || '')
        .replace(/\*\s*$/, '').trim();
      const type = el.type === 'file' ? 'file' : el.getAttribute('role') === 'combobox' ? 'combobox'
        : el.tagName === 'TEXTAREA' ? 'textarea' : el.type === 'checkbox' ? 'checkbox' : el.tagName === 'SELECT' ? 'select' : 'text';
      const required = el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(el.labels?.[0]?.innerText || '');
      out.push({ id: el.id, label, type, required });
    }
    return out;
  });
}

async function comboboxOptions(page, id) {
  const input = page.locator(`[id="${id}"]`);
  await input.click({ timeout: 5000 });
  await page.waitForTimeout(400);
  const opts = await page.locator(`[id^="react-select-${id}-option"]`).allInnerTexts();
  await page.keyboard.press('Escape');
  return opts.map((o) => o.trim()).filter(Boolean);
}

async function pickComboboxOption(page, id, answer, typeToSearch) {
  const input = page.locator(`[id="${id}"]`);
  await input.click({ timeout: 5000 });
  if (typeToSearch) { await input.pressSequentially(typeToSearch, { delay: 60 }); await page.waitForTimeout(1500); }
  else await page.waitForTimeout(300);
  const opts = page.locator(`[id^="react-select-${id}-option"]`);
  const n = await opts.count();
  if (n === 0) throw new Error('no options appeared');
  let target = opts.first();
  if (answer) {
    const exact = opts.filter({ hasText: new RegExp(`^\\s*${answer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i') });
    if (await exact.count()) target = exact.first();
    else { const loose = opts.filter({ hasText: answer }); if (await loose.count()) target = loose.first(); }
  }
  await target.click();
}

async function observed(page, f) {
  return page.evaluate(({ id, type }) => {
    const el = document.getElementById(id);
    if (!el && type === 'file') return document.body.innerText.match(/resume\.pdf/)?.[0] ?? null; // input is replaced by a file chip after upload
    if (!el) return null;
    if (type === 'file') return el.files?.[0]?.name || null;
    if (type === 'combobox') {
      const c = el.closest('.select__control') || el.closest('.select') || el.parentElement.parentElement;
      return c.querySelector('.select__single-value, .select__multi-value, [class*="singleValue"]')?.innerText || null;
    }
    if (type === 'checkbox') return el.checked;
    return el.value || null;
  }, f);
}

// ===================== run =====================
report.publicIp = await fetch('https://api.ipify.org').then((r) => r.text()).catch(() => null);

const schema = await step('fetch public question schema', async () => {
  const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${jobId}?questions=true`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  report.jobTitle = j.title; report.company = j.company_name;
  return j;
});
const schemaOptions = new Map();
const schemaRequired = new Set((schema?.questions ?? []).filter((q) => q.required).flatMap((q) => q.fields.map((f) => f.name)));
for (const q of [...(schema?.questions ?? []), ...(schema?.location_questions ?? []), ...(schema?.compliance ?? []).flatMap((c) => c.questions)])
  for (const f of q.fields) if (f.values?.length) schemaOptions.set(f.name, f.values.map((v) => v.label));

const resumePath = await makeResume();
const browser = await step('launch chromium', () =>
  chromium.launch({ headless: !headful, channel: headful ? 'chromium' : undefined }));
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US', timezoneId: 'America/Chicago' });

// HARD GUARDS: cancel any submit event and abort writes to Greenhouse application hosts.
await context.addInitScript(() => {
  document.addEventListener('submit', (e) => { e.preventDefault(); e.stopImmediatePropagation(); window.__dryRunSubmitBlocked = (window.__dryRunSubmitBlocked || 0) + 1; }, true);
  HTMLFormElement.prototype.submit = function () { window.__dryRunSubmitBlocked = (window.__dryRunSubmitBlocked || 0) + 1; };
  HTMLFormElement.prototype.requestSubmit = function () { window.__dryRunSubmitBlocked = (window.__dryRunSubmitBlocked || 0) + 1; };
});
await context.route('**/*', (route) => {
  const req = route.request();
  if (req.method() === 'GET' || req.method() === 'HEAD' || req.method() === 'OPTIONS') return route.continue();
  const u = new URL(req.url());
  const gh = /(^|\.)greenhouse\.io$/.test(u.hostname);
  if (gh && /application|submit|\/jobs\/\d+/.test(u.pathname)) {
    report.blockedRequests.push({ method: req.method(), url: req.url().slice(0, 200) });
    return route.abort('blockedbyclient');
  }
  report.otherWrites.push({ method: req.method(), url: req.url().slice(0, 200) });
  return route.continue();
});

const page = await context.newPage();
const nav = await step('open hosted application page', async () => {
  const resp = await page.goto(`https://job-boards.greenhouse.io/${board}/jobs/${jobId}`, { waitUntil: 'networkidle', timeout: 45000 });
  const status = resp?.status();
  if (!status || status >= 400) throw new Error(`HTTP ${status} at ${page.url()}`);
  await page.waitForSelector('form#application-form', { timeout: 15000 });
  return { status, finalUrl: page.url() };
});
await step('detect anti-bot on load', () => detectChallenges(page, 'load'));
await page.screenshot({ path: `${outDir}/01-loaded.png`, fullPage: true }).catch(() => {});

const fields = nav ? await step('discover fields from DOM', async () => {
  const f = await discover(page);
  if (!f) throw new Error('form#application-form not found');
  return f;
}) : null;

if (fields) {
  // gather options for comboboxes (DOM first, schema as fallback) and decide answers
  const plans = [];
  for (const f of fields) {
    let options = f.type === 'combobox' ? await comboboxOptions(page, f.id).catch(() => []) : undefined;
    if (f.type === 'combobox' && options.length === 0) options = schemaOptions.get(f.id);
    let answer = f.type === 'file' ? (f.id === 'resume' ? resumePath : null) : ruleAnswer(f.label, options?.length ? options : undefined);
    plans.push({ ...f, required: f.required || schemaRequired.has(f.id), domRequired: f.required, options, answer, source: answer === undefined ? 'unresolved' : 'rule' });
  }
  // async-search comboboxes (location) have no options until typed
  for (const p of plans) if (p.type === 'combobox' && !p.options?.length && /location|city/i.test(p.label)) { p.answer = null; p.search = P.city; p.source = 'rule'; }

  const unresolved = plans.filter((p) => p.source === 'unresolved');
  await step('answer remaining questions (LLM if configured)', async () => {
    const llm = await llmAnswers(unresolved.map((p) => ({ key: p.id, label: p.label, options: p.options })), report.jobTitle);
    for (const p of unresolved) {
      if (llm[p.id] != null) { p.answer = String(llm[p.id]); p.source = 'llm'; }
      else if (p.type === 'combobox' && p.required) { p.answer = p.options?.[0] ?? null; p.source = 'fallback-first-option'; }
      else if (p.type === 'combobox') { p.answer = null; p.source = 'skipped-optional'; }
      else if (p.required || p.type === 'textarea') { p.answer = CANNED; p.source = 'canned'; }
      else { p.answer = null; p.source = 'skipped-optional'; }
    }
    return { unresolved: unresolved.length, llm: Object.keys(llm).length };
  });

  for (const p of plans) {
    const s = Date.now();
    let ok = true, error;
    try {
      const loc = page.locator(`[id="${p.id}"]`);
      if (p.answer === null && !p.search) { ok = true; }
      else if (p.type === 'file') { await loc.setInputFiles(p.answer); await page.getByText('resume.pdf').first().waitFor({ timeout: 15000 }); }
      else if (p.type === 'combobox') await pickComboboxOption(page, p.id, p.answer, p.search);
      else if (p.type === 'checkbox') { if (p.answer) await loc.check(); }
      else { await loc.click(); await loc.pressSequentially(p.answer, { delay: 15 }); }
      await page.waitForTimeout(150);
    } catch (e) { ok = false; error = String(e).split('\n')[0].slice(0, 200); }
    const obs = await observed(page, p).catch(() => null);
    const filledOk = p.answer === null && !p.search ? true : Boolean(obs);
    report.fields.push({ id: p.id, label: p.label, type: p.type, required: p.required, source: p.source,
      answer: p.type === 'file' ? 'resume.pdf' : p.answer, observed: obs, ok: ok && filledOk, ms: Date.now() - s, error });
    console.log(`  ${ok && filledOk ? '✓' : '✗'} [${p.type}] ${p.label.slice(0, 60)} → ${String(obs).slice(0, 50)}${error ? ' ERR ' + error : ''}`);
  }
  report.steps.push({ name: 'fill fields', ok: report.fields.every((f) => f.ok), ms: report.fields.reduce((a, f) => a + f.ms, 0),
    detail: { total: report.fields.length, failed: report.fields.filter((f) => !f.ok).length } });

  // discover again: conditional fields may have appeared
  await step('re-discover (conditional fields)', async () => {
    const again = await discover(page);
    const known = new Set(fields.map((f) => f.id));
    return { newFields: again.filter((f) => !known.has(f.id)) };
  });
  await step('verify required fields have values', async () => {
    const missing = report.fields.filter((f) => f.required && !f.observed).map((f) => f.label);
    if (missing.length) throw new Error(`required without value: ${missing.join(' | ')}`);
    return { requiredFilled: report.fields.filter((f) => f.required).length };
  });
  await step('detect anti-bot after fill', () => detectChallenges(page, 'after-fill'));
  await page.screenshot({ path: `${outDir}/02-filled.png`, fullPage: true }).catch(() => {});
  report.submitEventsCancelled = await page.evaluate(() => window.__dryRunSubmitBlocked || 0);
  report.stoppedBeforeSubmit = await page.locator('form#application-form button[type=submit]').isVisible().catch(() => null);
}

sampleMemory();
clearInterval(memTimer);
await browser?.close();
report.totalMs = Date.now() - t0;
report.memory.peakSystemUseMb = report.memory.memAvailableAtStartMb - report.memory.minMemAvailableMb; // more honest than summed RSS, which double-counts shared pages
writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 2));
console.log(`\nDRY RUN COMPLETE (never submitted). ${report.totalMs} ms, peak system memory used ${report.memory.peakSystemUseMb} MB (summed browser RSS ${report.memory.peakBrowserRssMb} MB), LLM $${report.llm.costUsd.toFixed(4)}`);
console.log(`challenges: ${JSON.stringify(report.challenges)}  blocked writes: ${report.blockedRequests.length}  other writes: ${report.otherWrites.length}`);
console.log(`report: ${outDir}/report.json`);
