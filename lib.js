/* Protocol Eligibility Copilot — shared logic.
 * Loaded by index.html in the browser AND by eval/run_eval.mjs in Node, so the live demo and the
 * offline evaluation use exactly the same splitter, baseline and scoring code.
 */
(function (root) {
  "use strict";

  // ---------------------------------------------------------------------------------------------
  // Taxonomy — the contract shared by the gold labels, the rule baseline and the LLM skill.
  // ---------------------------------------------------------------------------------------------
  const TAXONOMY = [
    { key: "DEMOGRAPHICS", label: "Demographics", def: "Age, sex, body weight, BMI." },
    { key: "DISEASE", label: "Disease characteristics", def: "Diagnosis/definition of the TARGET condition, phenotype or biomarker, stage, severity, disease history (e.g. exacerbations), measurable disease, disease-specific tests (e.g. spirometry in COPD, viral load in HIV), resistance, disease-defining exposures (e.g. smoking in COPD), recent episodes of the target disease, excluded subtypes or spread of the target disease." },
    { key: "THERAPY", label: "Prior / concomitant therapy", def: "Current, prior or prohibited treatments: drugs, vaccines, investigational products, procedures, surgery, rehabilitation, oxygen or ventilation support; washout periods; treatment history; prior exposure to the study drug or class." },
    { key: "LABS_VITALS", label: "Labs, vitals & organ function", def: "Laboratory values, vital signs, ECG/QTc, organ function, performance status (e.g. ECOG)." },
    { key: "COMORBIDITY_SAFETY", label: "Comorbidities & safety", def: "Other medical conditions that are NOT the target disease, infections, allergy/hypersensitivity, prior adverse events, other safety risks (e.g. radiation exposure)." },
    { key: "REPRODUCTIVE", label: "Reproductive", def: "Pregnancy, lactation, contraception, pregnancy testing, childbearing potential." },
    { key: "CONSENT_LOGISTICS", label: "Consent, compliance & logistics", def: "Informed consent, ability/willingness to comply, self-administration or caregiver, completion of a parent study, practical requirements for participating." },
  ];
  const CATS = TAXONOMY.map((t) => t.key);

  const FLAGS = {
    screening_burden: "Adds screening procedures or documentation burden for sites/participants",
    washout: "Imposes a time window / washout that can delay or block enrolment",
    investigator_judgement: "Relies on investigator judgement — a source of site-to-site variability",
    modernisation_candidate: "Criterion type that FDA (2020) / ASCO–Friends guidance suggests broadening where scientifically justified",
    ambiguous: "Wording is ambiguous or compound — likely to generate site queries",
  };

  // ---------------------------------------------------------------------------------------------
  // Splitting ClinicalTrials.gov eligibility text into atomic criteria
  // ---------------------------------------------------------------------------------------------
  function splitCriteria(text) {
    const items = [];
    let section = null;
    for (const raw of String(text || "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const low = line.toLowerCase().replace(/^[*:\s]+|[*:\s]+$/g, "");
      const header = line.length < 90 && line.replace(/\*+$/, "").endsWith(":");
      if (/^(key\s+)?inclusion criteria/.test(low) || (header && low.includes("inclusion criteria"))) { section = "inclusion"; continue; }
      if (/^(key\s+)?exclusion criteria/.test(low) || (header && low.includes("exclusion criteria"))) { section = "exclusion"; continue; }
      if (line.replace(/\*+$/, "").endsWith(":") && low.includes("following criteria apply")) continue;
      const m = line.match(/^(\*|-|•|\d+[.)])\s+(.*)$/);
      const body = (m ? m[2] : line).trim();
      const isBullet = !!m && !/^( {2}|\t)/.test(raw);
      // indented sub-bullets and continuation lines attach to the previous criterion
      if (items.length && !isBullet && section === items[items.length - 1].section) {
        items[items.length - 1].text += " " + body;
        continue;
      }
      if (section === null) continue;
      items.push({ section, text: body });
    }
    return items.map((it, k) => ({ ...it, text: unescapeMd(it.text) }));
  }

  function unescapeMd(s) {
    return s.replace(/\\([<>\[\]^*_~])/g, "$1");
  }

  function assignIds(nct, items) {
    return items.map((it, k) => ({ ...it, nct, id: `${nct}-${it.section.slice(0, 3)}-${String(k).padStart(2, "0")}` }));
  }

  // ---------------------------------------------------------------------------------------------
  // Baseline: keyword rules, first match wins. Written once up-front and deliberately NOT tuned
  // against the gold set — it stands in for the "quick rules-based tool" a team would build first.
  // ---------------------------------------------------------------------------------------------
  const RULES = [
    ["REPRODUCTIVE", /pregnan|lactat|breastfeed|contracept|childbearing|WOCBP|WONCBP|menstrual/i],
    ["CONSENT_LOGISTICS", /informed consent|\bICF\b|\bcomply\b|compliance|self-administer|caregiver|eDiary|completed (either )?stud/i],
    ["LABS_VITALS", /QTc|\bECG\b|ha?emoglobin|platelet|creatinine|\bALT\b|\bAST\b|bilirubin|neutrophil|organ function|ECOG|performance status|laborator|blood pressure|heart rate/i],
    ["DEMOGRAPHICS", /\b(age|aged|years of age|adults?|adolescents?|male|female)\b|\bBMI\b|body mass|weight/i],
    ["THERAPY", /therapy|treatment|treated|regimen|vaccine|\bdrugs?\b|medication|inhaler|surgery|procedure|rehabilitation|oxygen|investigational|exposure to|administration/i],
    ["COMORBIDITY_SAFETY", /history of|disease|disorder|infection|hepatitis|\bHIV\b|allerg|hypersensitivity|comorbid|cardiovascular|malignan|syndrome|condition/i],
  ];

  function ruleClassify(text) {
    for (const [cat, re] of RULES) if (re.test(text)) return cat;
    return "DISEASE";
  }

  // Deterministic extraction used by the baseline (and shown alongside LLM output).
  function ruleExtract(text) {
    const thresholds = [];
    const re = /(≥|≤|>=|<=|>|<|greater than|less than|at least|more than)\s*\(?\s*(?:\\?[<>]=?\)?\s*)?(\d+(?:\.\d+)?)\s*(%|kg\/m\^?2|kg|years?|copies\/mL|msec|ms|pack-years|mSv|days?|weeks?|months?|cycles?)?/gi;
    let m;
    while ((m = re.exec(text))) thresholds.push(m[0].trim());
    const win = text.match(/(within|prior to|before|in the (past|prior))[^.;]{0,40}?\b(\d+)\s*(days?|weeks?|months?|years?)/i)
      || text.match(/\b(\d+)\s*(days?|weeks?|months?)\s+(prior|before)/i);
    return { thresholds, time_window: win ? win[0] : null };
  }

  // ---------------------------------------------------------------------------------------------
  // LLM skill prompt — built from the same taxonomy so the skill, the baseline and the gold labels
  // share one contract. The canonical copy also lives in skills/eligibility-criteria-structurer/.
  // ---------------------------------------------------------------------------------------------
  function buildPrompt(study, criteria) {
    const tax = TAXONOMY.map((t) => `- ${t.key}: ${t.def}`).join("\n");
    const flags = Object.entries(FLAGS).map(([k, v]) => `- ${k}: ${v}`).join("\n");
    const list = criteria.map((c) => `${c.id} [${c.section}] ${c.text}`).join("\n");
    return `You are a clinical operations analyst structuring protocol eligibility criteria for feasibility review.

STUDY: ${study.nct} — ${study.title}
CONDITION(S): ${(study.conditions || []).join(", ")}   PHASE: ${(study.phases || []).join(", ")}

TAXONOMY (choose exactly one category per criterion; the TARGET condition is the study condition above):
${tax}

FEASIBILITY FLAGS (zero or more per criterion):
${flags}

CRITERIA:
${list}

Return ONLY a JSON array, one object per criterion, in the same order, with keys:
{"id": string, "category": one of [${CATS.join(", ")}], "rationale": string (max 15 words),
 "thresholds": [string], "time_window": string|null, "flags": [flag keys]}
No prose before or after the JSON.`;
  }

  function parseModelJson(text) {
    const s = String(text);
    const start = s.indexOf("["), end = s.lastIndexOf("]");
    if (start < 0 || end < start) throw new Error("No JSON array in model output");
    return JSON.parse(s.slice(start, end + 1));
  }

  // ---------------------------------------------------------------------------------------------
  // Scoring
  // ---------------------------------------------------------------------------------------------
  function isCorrect(pred, g) {
    return pred === g.gold || (g.alt || []).includes(pred);
  }

  function score(gold, preds) {
    // preds: {id: category}
    let correct = 0, n = 0, strict = 0;
    const per = Object.fromEntries(CATS.map((c) => [c, { tp: 0, fp: 0, fn: 0 }]));
    const errors = [];
    for (const g of gold) {
      const p = preds[g.id];
      if (p === undefined) continue;
      n++;
      if (p === g.gold) strict++;
      if (isCorrect(p, g)) { correct++; per[g.gold].tp++; }
      else {
        per[g.gold].fn++;
        if (per[p]) per[p].fp++;
        errors.push({ id: g.id, gold: g.gold, alt: g.alt || [], pred: p });
      }
    }
    const f1s = CATS.map((c) => {
      const { tp, fp, fn } = per[c];
      if (tp + fp + fn === 0) return null;
      const prec = tp + fp ? tp / (tp + fp) : 0, rec = tp + fn ? tp / (tp + fn) : 0;
      return prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
    }).filter((x) => x !== null);
    return {
      n, accuracy: n ? correct / n : 0, strict_accuracy: n ? strict / n : 0,
      macro_f1: f1s.reduce((a, b) => a + b, 0) / (f1s.length || 1),
      per_class: per, errors,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // ClinicalTrials.gov API v2 tools (public, CORS-enabled)
  // ---------------------------------------------------------------------------------------------
  const CTG = "https://clinicaltrials.gov/api/v2/studies";

  function summariseStudy(d) {
    const p = d.protocolSection || {};
    const id = p.identificationModule || {}, st = p.statusModule || {}, de = p.designModule || {};
    const el = p.eligibilityModule || {}, sp = p.sponsorCollaboratorsModule || {};
    return {
      nct: id.nctId, title: id.briefTitle, official: id.officialTitle,
      sponsor: (sp.leadSponsor || {}).name, status: st.overallStatus,
      start: (st.startDateStruct || {}).date, primaryCompletion: (st.primaryCompletionDateStruct || {}).date,
      phases: de.phases || [], enrollment: (de.enrollmentInfo || {}).count,
      enrollmentType: (de.enrollmentInfo || {}).type,
      conditions: (p.conditionsModule || {}).conditions || [],
      sites: ((p.contactsLocationsModule || {}).locations || []).length,
      countries: [...new Set(((p.contactsLocationsModule || {}).locations || []).map((l) => l.country))].length,
      minAge: el.minimumAge, maxAge: el.maximumAge, sex: el.sex, healthyVolunteers: el.healthyVolunteers,
      criteriaText: el.eligibilityCriteria || "",
    };
  }

  async function getStudy(nct, fetchFn) {
    const r = await (fetchFn || fetch)(`${CTG}/${encodeURIComponent(nct)}`);
    if (!r.ok) throw new Error(`ClinicalTrials.gov returned ${r.status} for ${nct}`);
    return summariseStudy(await r.json());
  }

  function monthsBetween(a, b) {
    if (!a || !b) return null;
    const pa = new Date(a.length === 7 ? a + "-15" : a), pb = new Date(b.length === 7 ? b + "-15" : b);
    const m = (pb - pa) / (1000 * 60 * 60 * 24 * 30.44);
    return isFinite(m) && m > 0 ? m : null;
  }

  function median(xs) {
    const v = xs.filter((x) => x != null && isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const k = Math.floor(v.length / 2);
    return v.length % 2 ? v[k] : (v[k - 1] + v[k]) / 2;
  }

  // Comparator benchmark: completed interventional studies, same condition + phase.
  async function findComparators(study, fetchFn) {
    const cond = study.conditions[0];
    const phase = (study.phases || []).find((p) => /PHASE/.test(p));
    const params = new URLSearchParams({ "query.cond": cond, pageSize: "50", "filter.overallStatus": "COMPLETED", countTotal: "true" });
    if (phase) params.set("filter.advanced", `AREA[Phase]${phase} AND AREA[StudyType]INTERVENTIONAL`);
    const r = await (fetchFn || fetch)(`${CTG}?${params}`);
    if (!r.ok) throw new Error(`Comparator search failed (${r.status})`);
    const j = await r.json();
    const rows = (j.studies || []).map(summariseStudy).filter((s) => s.nct !== study.nct);
    const enrol = rows.filter((s) => s.enrollmentType === "ACTUAL").map((s) => s.enrollment);
    const dur = rows.map((s) => monthsBetween(s.start, s.primaryCompletion));
    const sites = rows.map((s) => s.sites).filter((x) => x > 0);
    const critCounts = rows.map((s) => splitCriteria(s.criteriaText).length).filter((x) => x > 0);
    return {
      query: { condition: cond, phase: phase || "any", status: "COMPLETED" },
      totalMatching: j.totalCount, sampled: rows.length,
      median_enrollment: median(enrol), median_duration_months: median(dur),
      median_sites: median(sites), median_criteria: median(critCounts),
      examples: rows.slice(0, 6).map((s) => ({ nct: s.nct, title: s.title, sponsor: s.sponsor, enrollment: s.enrollment, sites: s.sites, months: monthsBetween(s.start, s.primaryCompletion) })),
    };
  }

  const api = { TAXONOMY, CATS, FLAGS, splitCriteria, assignIds, ruleClassify, ruleExtract, buildPrompt, parseModelJson, isCorrect, score, summariseStudy, getStudy, findComparators, median, monthsBetween };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PEC = api;
})(typeof window !== "undefined" ? window : globalThis);
