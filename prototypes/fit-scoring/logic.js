// ===== PURE LOGIC MODULE (liftable; no DOM) =====
// Question: how do extraction -> prefilter -> tier/score -> qualification -> policy behave on real postings?
const Fit = (() => {
  const TIER_SCORE = { IDEAL: 100, GOOD: 80, ACCEPTABLE: 60 };
  const TIER_ORDER = ['IDEAL', 'GOOD', 'ACCEPTABLE', 'UNACCEPTABLE'];
  const best = (tiers) => tiers.slice().sort((a, b) => TIER_ORDER.indexOf(a) - TIER_ORDER.indexOf(b))[0];
  const field = (value, provenance, how, note) => ({ value, provenance, how, note: note || '' });
  // provenance: stated | inferred | unknown ; how: source | regex | needs-llm

  const NON_US = /munich|germany|london|\buk\b|united kingdom|taipei|taiwan|dublin|ireland|paris|france|toronto|canada|bengaluru|bangalore|india|singapore|sydney|australia|z[uü]rich|luxembourg|barcelona|berlin|bucharest|sao paulo|brazil/i;
  const US_OTHER = /seattle|chicago|austin|boston|atlanta|denver|los angeles|portland|\bus\b|united states|, ca\b|, wa\b|, ny\b/i;
  function locationTags(raw) {
    const parts = raw.split(/\s*[|;]\s*/).map((s) => s.trim()).filter(Boolean);
    return parts.map((p) => {
      let tag = 'UNKNOWN';
      if (/remote/i.test(p) && /united states|\bus\b|us-remote/i.test(p)) tag = 'US_REMOTE';
      else if (/remote-friendly/i.test(p)) tag = 'US_REMOTE';
      else if (/san francisco|\bsf\b|us-sf/i.test(p)) tag = 'SF';
      else if (/new york|nyc|us-nyc|\bny\b/i.test(p)) tag = 'NYC';
      else if (/washington, dc|\bdc\b/i.test(p)) tag = 'DC';
      else if (NON_US.test(p)) tag = 'NON_US';
      else if (US_OTHER.test(p)) tag = 'US_OTHER';
      return { raw: p, tag };
    });
  }

  function extract(job) {
    const t = job.text;
    const out = {};
    out.title = field(job.title, 'stated', 'source');
    out.employer = field(job.employer, 'stated', 'source');
    const locs = locationTags(job.location);
    out.locations = field(locs, locs.every((l) => l.tag === 'UNKNOWN') ? 'unknown' : 'stated', 'source');

    if (/^hybrid\b/i.test(job.location)) out.workplace = field('HYBRID', 'stated', 'source', 'location string says Hybrid');
    else if (/^remote\b/i.test(job.location)) out.workplace = field('REMOTE', 'stated', 'source', 'location string says Remote');
    else if (/remote-friendly/i.test(job.location)) out.workplace = field('REMOTE', 'inferred', 'regex', '"Remote-Friendly" in location');
    else if (/hybrid|at least \d+% of (?:the )?time in|in[- ]office|on-?site/i.test(t)) out.workplace = field('HYBRID', 'inferred', 'regex', 'office-attendance wording in prose');
    else out.workplace = field(null, 'unknown', 'needs-llm', 'nothing deterministic; an LLM read of the prose could settle it');

    const pay = job.pay.find((p) => p.cur === 'USD');
    if (pay) out.comp = field({ min: pay.min, max: pay.max }, 'stated', 'source', 'structured pay range');
    else {
      const m = t.match(/\$\s?(\d{2,3}(?:,\d{3})+)\s*(?:-|–|—|to|and)\s*\$?\s?(\d{2,3}(?:,\d{3})+)/);
      if (m) out.comp = field({ min: +m[1].replace(/,/g, ''), max: +m[2].replace(/,/g, '') }, 'inferred', 'regex', 'dollar range found in prose (could be OTE/other currency)');
      else out.comp = field(null, 'unknown', 'needs-llm', 'no pay range in structured data or prose');
    }

    const ttl = job.title.toLowerCase();
    let sen = null;
    if (/\bintern(ship)?\b/.test(ttl)) sen = 'INTERN';
    else if (/new grad|early career|graduate/.test(ttl)) sen = 'NEWGRAD';
    else if (/\bprincipal\b/.test(ttl)) sen = 'PRINCIPAL';
    else if (/\bstaff\b/.test(ttl)) sen = 'STAFF';
    else if (/\b(senior|sr\.?)\b/.test(ttl)) sen = 'SENIOR';
    else if (/\blead\b/.test(ttl)) sen = 'LEAD';
    else if (/\b(junior|jr\.?|associate)\b/.test(ttl)) sen = 'JUNIOR';
    if (sen) out.seniority = field(sen, 'inferred', 'regex', 'title keyword');
    else out.seniority = field(null, 'unknown', 'needs-llm', 'title has no level word');

    const ym = t.match(/(\d+)\+?\s*years?[^.\n]{0,60}experience|experience[^.\n]{0,40}?(\d+)\+?\s*years/i);
    if (ym) out.yearsRequired = field(+(ym[1] || ym[2]), 'inferred', 'regex', `"${ym[0].slice(0, 70)}"`);
    else out.yearsRequired = field(null, 'unknown', 'regex', 'no "N years" phrase');
    if (!sen && out.yearsRequired.value != null) {
      const y = out.yearsRequired.value;
      out.seniority = field(y <= 2 ? 'JUNIOR' : y <= 5 ? 'MID' : 'SENIOR', 'inferred', 'regex', `no level word in title; ${y}+ years in prose`);
    }

    const cm = t.match(/(requires?|must (?:have|hold|be able to obtain)|active|ability to obtain|eligib\w+ (?:for|to obtain))[^.\n]{0,60}clearance|clearance[^.\n]{0,40}(?:is )?required/i);
    out.clearanceRequired = field(!!cm, cm ? 'inferred' : 'stated', 'regex', cm ? `"${cm[0].slice(0, 80)}"` : 'no clearance wording');
    return out;
  }

  const roleMatch = (title, phrases) => phrases.some((p) => new RegExp('\\b' + p.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(title.toLowerCase()));

  function tierRole(h, a) {
    const t = a.title.value;
    for (const k of ['IDEAL', 'GOOD', 'ACCEPTABLE']) if (roleMatch(t, h.role[k])) return { tier: k, prov: 'stated', detail: `title matches a ${k} role phrase` };
    return h.role.anythingElseUnacceptable
      ? { tier: 'UNACCEPTABLE', prov: 'stated', detail: 'title matches no listed role ("anything else = unacceptable")' }
      : { tier: 'ACCEPTABLE', prov: 'stated', detail: 'title matches no listed role' };
  }
  function tierLocation(h, a) {
    const known = a.locations.value.filter((l) => l.tag !== 'UNKNOWN').map((l) => {
      let t = h.location.anythingElseUnacceptable ? 'UNACCEPTABLE' : 'ACCEPTABLE';
      for (const k of ['IDEAL', 'GOOD', 'ACCEPTABLE', 'UNACCEPTABLE']) if (h.location[k].includes(l.tag)) { t = k; break; }
      return { l, t };
    });
    if (!known.length) return { tier: null, prov: 'unknown', detail: 'no location recognised' };
    const b = best(known.map((x) => x.t));
    const hit = known.find((x) => x.t === b);
    return { tier: b, prov: 'stated', detail: `best of ${known.length} location(s): ${hit.l.raw} → ${b}` };
  }
  function tierComp(h, a) {
    if (!a.comp.value) return { tier: null, prov: 'unknown', detail: 'no pay range' };
    const mid = (a.comp.value.min + a.comp.value.max) / 2;
    const c = h.comp;
    const tier = mid >= c.ideal ? 'IDEAL' : mid >= c.good ? 'GOOD' : mid >= c.acceptable ? 'ACCEPTABLE' : 'UNACCEPTABLE';
    return { tier, prov: a.comp.provenance, detail: `range midpoint $${Math.round(mid / 1000)}k → ${tier}` };
  }
  const listTier = (key, label) => (h, a) => {
    const v = a[key].value;
    if (!v) return { tier: null, prov: 'unknown', detail: `${label} unknown` };
    for (const k of ['IDEAL', 'GOOD', 'ACCEPTABLE', 'UNACCEPTABLE']) if (h[key][k].includes(v)) return { tier: k, prov: a[key].provenance, detail: `${v} → ${k}` };
    return { tier: 'ACCEPTABLE', prov: a[key].provenance, detail: `${v} not listed → ACCEPTABLE` };
  };
  function tierEmployer(h, a) {
    const e = a.employer.value;
    for (const k of ['IDEAL', 'GOOD', 'ACCEPTABLE', 'UNACCEPTABLE']) if (h.employer[k].includes(e)) return { tier: k, prov: 'stated', detail: `${e} is a ${k} employer` };
    return null;
  }
  const DIMS = [
    ['role', 'Role', tierRole], ['location', 'Location', tierLocation], ['comp', 'Compensation', tierComp],
    ['seniority', 'Seniority', listTier('seniority', 'seniority')], ['workplace', 'Work arrangement', listTier('workplace', 'workplace')],
    ['employer', 'Company', tierEmployer],
  ];

  // stage A: deterministic prefilter on STATED values only, before any LLM
  function prefilter(h, a, job) {
    const role = tierRole(h, a);
    if (role.tier === 'UNACCEPTABLE') return { pass: false, reason: 'Role: ' + role.detail };
    const loc = tierLocation(h, a);
    if (loc.tier === 'UNACCEPTABLE') return { pass: false, reason: 'Location: ' + loc.detail };
    if (a.comp.provenance === 'stated') {
      const c = tierComp(h, a);
      if (c.tier === 'UNACCEPTABLE') return { pass: false, reason: 'Compensation: ' + c.detail };
    }
    const kw = h.excludedKeywords.find((k) => job.title.toLowerCase().includes(k.toLowerCase()));
    if (kw) return { pass: false, reason: `Excluded keyword "${kw}" in title` };
    return { pass: true };
  }

  function score(h, a, job) {
    const reasons = [];
    const dims = [];
    for (const [key, label, fn] of DIMS) {
      const r = fn(h, a);
      if (!r) continue;
      const w = h.weights[key];
      const d = { key, label, w, ...r, unknownPolicy: '' };
      if (r.tier === null) {
        d.unknownPolicy = h.unknown[key] || 'ACCEPTABLE';
        d.score = d.unknownPolicy === 'ACCEPTABLE' || d.unknownPolicy === 'RESEARCH' ? TIER_SCORE.ACCEPTABLE : null;
        if (d.unknownPolicy === 'SKIP' || d.unknownPolicy === 'REQUIRE') reasons.push(`${label} unknown and Hunt says ${d.unknownPolicy === 'SKIP' ? 'skip if unknown' : 'require known'}`);
        if (d.unknownPolicy === 'ACCEPTABLE' && h.unknownScoring === 'IGNORE') d.score = null;
      } else if (r.tier === 'UNACCEPTABLE') {
        if (r.prov === 'inferred' && !h.inferredCanExclude) { d.softened = true; d.score = 20; }
        else { d.score = 0; reasons.push(`${label} is UNACCEPTABLE (${r.prov})`); }
      } else d.score = TIER_SCORE[r.tier];
      dims.push(d);
    }
    const kw = h.excludedKeywords.find((k) => job.text.toLowerCase().includes(k.toLowerCase()));
    if (kw) reasons.push(`Excluded keyword "${kw}" in posting`);
    const counted = dims.filter((d) => d.score != null);
    const wsum = counted.reduce((x, d) => x + d.w, 0);
    const fit = wsum ? Math.round(counted.reduce((x, d) => x + d.score * d.w, 0) / wsum) : 0;
    return { dims, fit, excluded: reasons.length > 0, reasons };
  }

  // qualification: separate from fit, deliberately broad
  function qualify(c, a) {
    const notes = [];
    let ok = true;
    const y = a.yearsRequired.value;
    if (y != null) {
      if (y > c.years * c.tolerance) { ok = false; notes.push(`Needs ${y}+ years; Candidate has ${c.years}; beyond ${c.tolerance}× stretch allowance (${c.years * c.tolerance} yrs)`); }
      else if (y > c.years) notes.push(`Needs ${y}+ years; Candidate has ${c.years}. Within stretch allowance → still qualifies (broad qualification)`);
      else notes.push(`Needs ${y}+ years; meets it`);
    } else notes.push('No years requirement found; nothing held against the Candidate');
    if (a.clearanceRequired.value && !c.hasClearance) { ok = false; notes.push('Requires a security clearance the Candidate lacks'); }
    const s = a.seniority.value;
    if ((s === 'INTERN' || s === 'NEWGRAD') && !c.isStudentOrGrad) { ok = false; notes.push('Intern/new-grad programme; Candidate is neither'); }
    return { qualified: ok, notes };
  }

  function decide(h, fitRes, qual, a) {
    if (fitRes.excluded) return { action: 'SKIP', why: 'Excluded: ' + fitRes.reasons.join('; ') };
    if (!qual.qualified) return { action: 'SKIP', why: 'Not qualified: ' + qual.notes.join('; ') };
    const band = h.policy.bands.find((b) => fitRes.fit >= b.from && fitRes.fit <= b.to);
    let action = band ? band.action : 'SKIP';
    let why = band ? `Fit ${fitRes.fit} in band ${band.from}–${band.to} → ${band.action}` : 'No band covers this score → SKIP';
    for (const r of h.policy.reviewRules) {
      if (action !== 'AUTO') break;
      if (r.type === 'employer' && r.values.includes(a.employer.value)) { action = 'REVIEW'; why += `; Review rule: employer is ${a.employer.value}`; }
      if (r.type === 'compAtLeast' && a.comp.value && (a.comp.value.min + a.comp.value.max) / 2 >= r.value) { action = 'REVIEW'; why += `; Review rule: pay ≥ $${r.value / 1000}k`; }
    }
    return { action, why };
  }

  function evaluate(h, c, job) {
    const attrs = extract(job);
    const pre = prefilter(h, attrs, job);
    if (!pre.pass) return { job, attrs, pre, stage: 'PREFILTER', llmNeeded: [], decision: { action: 'SKIP', why: pre.reason }, fitRes: null, qual: null };
    const llmNeeded = Object.entries(attrs).filter(([, f]) => f && f.how === 'needs-llm').map(([k]) => k);
    const fitRes = score(h, attrs, job);
    const qual = qualify(c, attrs);
    return { job, attrs, pre, stage: 'FULL', llmNeeded, fitRes, qual, decision: decide(h, fitRes, qual, attrs) };
  }

  // Stand-in for an LLM structured-output call on the PRD §88 conversational example.
  function huntFromAnswers(ans) {
    const notes = [];
    const role = { IDEAL: [], GOOD: [], ACCEPTABLE: [], anythingElseUnacceptable: true };
    if (/\bai\b/i.test(ans.roles)) { role.IDEAL.push('AI Engineer', 'Applied AI Engineer', 'AI Product Engineer'); notes.push('Role: "AI engineering" expanded to 3 IDEAL titles by the model (Candidate must confirm)'); }
    if (/software/i.test(ans.roles)) { role.GOOD.push('Software Engineer', 'Full Stack Engineer', 'Solutions Engineer'); notes.push('Role: "software roles" expanded to GOOD titles by the model'); }
    const location = { IDEAL: [], GOOD: [], ACCEPTABLE: [], UNACCEPTABLE: [], anythingElseUnacceptable: true };
    const places = { 'san francisco': 'SF', 'new york': 'NYC', nyc: 'NYC', dc: 'DC', washington: 'DC' };
    const tierOf = (cl) => /ideal/i.test(cl) ? 'IDEAL' : /good/i.test(cl) ? 'GOOD' : /accept|anywhere/i.test(cl) ? 'ACCEPTABLE' : null;
    for (const clause of ans.where.split(/[,.]|\bbut\b/i)) { void clause; }
    // clause-level tiering: "A ideally, B and C are good, but anywhere in the US is acceptable"
    const segs = ans.where.split(/,\s*|\.\s*/);
    let pending = [];
    for (const s of segs) {
      for (const [p, tag] of Object.entries(places)) if (new RegExp('\\b' + p + '\\b', 'i').test(s)) pending.push(tag);
      const t = tierOf(s.replace(/^.*\bbut\b/i, 'but ' + (/accept|anywhere/i.test(s) ? 'acceptable' : '')));
      if (/ideal/i.test(s) || /\bgood\b/i.test(s)) {
        const tier = /ideal/i.test(s) ? 'IDEAL' : 'GOOD';
        pending.forEach((tag) => !location[tier].includes(tag) && location[tier].push(tag)); pending = [];
      }
      if (/anywhere in the (us|united states)|remote us/i.test(s)) { location.ACCEPTABLE.push('US_OTHER', 'US_REMOTE'); }
      void t;
    }
    location.UNACCEPTABLE.push('NON_US');
    notes.push('Location: "anywhere in the US" made every non-US place UNACCEPTABLE; the Candidate never said that outright');
    const num = (s) => { const m = s.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(k)?/i); return m ? (+m[1] < 1000 ? +m[1] * 1000 : +m[1]) : null; };
    const acceptable = num(ans.minSalary), ideal = num(ans.idealSalary);
    const good = Math.round((acceptable + (ideal - acceptable) * 0.6) / 10000) * 10000;
    notes.push(`Compensation: only a floor and an ideal were given; GOOD ($${good / 1000}k) is a derived midpoint`);
    return { role, location, comp: { acceptable, good, ideal }, notes, notAsked: ['seniority', 'work arrangement', 'employer preferences', 'unknown-value handling', 'dimension weights', 'submission bands / review rules'] };
  }

  const defaultHunt = () => ({
    name: 'AI / Software Engineering',
    role: { IDEAL: ['AI Engineer', 'Applied AI Engineer', 'AI Product Engineer'], GOOD: ['Software Engineer', 'Full Stack Engineer', 'Full-Stack Engineer', 'Solutions Engineer', 'Forward Deployed Engineer'], ACCEPTABLE: ['Technical Product Engineer', 'Developer Experience Engineer', 'DevRel Engineer'], anythingElseUnacceptable: true },
    location: { IDEAL: ['SF'], GOOD: ['NYC', 'DC'], ACCEPTABLE: ['US_OTHER', 'US_REMOTE'], UNACCEPTABLE: ['NON_US'], anythingElseUnacceptable: false },
    comp: { ideal: 200000, good: 160000, acceptable: 100000 },
    seniority: { IDEAL: ['MID', 'SENIOR'], GOOD: ['JUNIOR', 'STAFF'], ACCEPTABLE: ['LEAD', 'PRINCIPAL'], UNACCEPTABLE: ['INTERN', 'NEWGRAD'] },
    workplace: { IDEAL: ['REMOTE', 'HYBRID'], GOOD: ['ONSITE'], ACCEPTABLE: [], UNACCEPTABLE: [] },
    employer: { IDEAL: ['Anthropic'], GOOD: ['Stripe'], ACCEPTABLE: ['Vercel'], UNACCEPTABLE: [] },
    weights: { role: 3, location: 2, comp: 2, seniority: 1, workplace: 1, employer: 1 },
    excludedKeywords: ['TS/SCI'],
    unknown: { location: 'ACCEPTABLE', comp: 'ACCEPTABLE', seniority: 'ACCEPTABLE', workplace: 'ACCEPTABLE' },
    unknownScoring: 'COUNT',
    inferredCanExclude: false,
    policy: { bands: [{ from: 0, to: 49, action: 'SKIP' }, { from: 50, to: 100, action: 'AUTO' }], reviewRules: [] },
  });
  const defaultCandidate = () => ({ years: 4, tolerance: 2, hasClearance: false, isStudentOrGrad: false });

  return { extract, evaluate, huntFromAnswers, defaultHunt, defaultCandidate };
})();
if (typeof module !== 'undefined') module.exports = Fit;
