// Offline evaluation: rule baseline vs Claude models on the labelled reference set.
// Model calls go through headless Claude Code (`claude -p`) with tools disabled and a minimal
// system prompt, so the measured cost/latency is close to a plain API call.
//
//   node eval/run_eval.mjs [--models haiku,sonnet,opus] [--repeats 2] [--effort low] [--refresh]
//
// Writes eval/results.json and data/results.js (consumed by index.html).
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const L = createRequire(import.meta.url)(join(here, "..", "lib.js"));
const TRIALS = ["NCT07177339", "NCT07099898", "NCT07650916", "NCT07851246", "NCT06716606"];
const MODELS = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
};
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const models = arg("--models", "haiku,sonnet,opus").split(",");
const repeats = Number(arg("--repeats", "2"));
const refresh = process.argv.includes("--refresh");
const effort = arg("--effort", "low"); // classification task: low reasoning effort is the production-like setting
const runsDir = join(here, "runs");
mkdirSync(runsDir, { recursive: true });

// 1. Studies (cached raw CT.gov JSON in eval/data so the set is frozen)
const studies = {};
for (const nct of TRIALS) {
  const f = join(here, "data", `${nct}.json`);
  if (refresh || !existsSync(f)) {
    const r = await fetch(`https://clinicaltrials.gov/api/v2/studies/${nct}`);
    writeFileSync(f, JSON.stringify(await r.json(), null, 1));
  }
  const s = L.summariseStudy(JSON.parse(readFileSync(f, "utf8")));
  s.criteria = L.assignIds(nct, L.splitCriteria(s.criteriaText));
  studies[nct] = s;
}
const gold = JSON.parse(readFileSync(join(here, "gold_labels.json"), "utf8")).labels;
const goldList = Object.entries(gold).map(([id, g]) => ({ id, ...g }));
const allCriteria = TRIALS.flatMap((n) => studies[n].criteria);
if (allCriteria.length !== goldList.length) throw new Error(`criteria/gold mismatch ${allCriteria.length} vs ${goldList.length}`);

// 2. Baseline
const t0 = performance.now();
const baseline = Object.fromEntries(allCriteria.map((c) => [c.id, L.ruleClassify(c.text)]));
const baselineMs = performance.now() - t0;

// 3. Models
function claude(model, prompt) {
  return new Promise((resolve, reject) => {
    // neutral cwd so no project CLAUDE.md / memory leaks into the context
    const cwd = join(tmpdir(), "pec-eval"); mkdirSync(cwd, { recursive: true });
    const child = execFile("claude", ["-p", "--model", model, "--effort", effort, "--output-format", "json", "--tools", "",
      "--system-prompt", "You are a precise clinical-operations data analyst. Follow the output format exactly."],
      { maxBuffer: 20 * 1024 * 1024, timeout: 300000, cwd },
      (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout))));
    child.stdin.end(prompt);
  });
}

async function pool(tasks, n) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); } }));
  return out;
}

const runs = [];
const tasks = [];
for (const m of models) for (let rep = 0; rep < repeats; rep++) for (const nct of TRIALS) {
  tasks.push(async () => {
    const cache = join(runsDir, `${m}-r${rep}-${nct}.json`);
    let res;
    if (!refresh && existsSync(cache)) res = JSON.parse(readFileSync(cache, "utf8"));
    else {
      const prompt = L.buildPrompt(studies[nct], studies[nct].criteria);
      const started = Date.now();
      const out = await claude(MODELS[m], prompt);
      res = { model: m, modelId: MODELS[m], effort, rep, nct, wall_ms: Date.now() - started, duration_api_ms: out.duration_api_ms,
              cost_usd: out.total_cost_usd, usage: out.usage, raw: out.result, at: new Date().toISOString() };
      writeFileSync(cache, JSON.stringify(res, null, 1));
    }
    let parsed = null, parseError = null;
    try { parsed = L.parseModelJson(res.raw); } catch (e) { parseError = String(e.message); }
    // fail closed: anything missing or outside the taxonomy is "NEEDS_REVIEW" (scored as wrong)
    const byId = Object.fromEntries((parsed || []).map((o) => [o.id, o]));
    const preds = Object.fromEntries(studies[nct].criteria.map((c) => {
      const o = byId[c.id]; return [c.id, o && L.CATS.includes(o.category) ? o.category : "NEEDS_REVIEW"];
    }));
    runs.push({ ...res, parsed, parseError, preds });
    console.error(`${m} r${rep} ${nct}: ${parseError ? "PARSE ERROR " + parseError : "ok"} $${res.cost_usd?.toFixed(4)} ${res.duration_api_ms}ms`);
  });
}
await pool(tasks, 5);

// 4. Score
const summary = [];
const bScore = L.score(goldList, baseline);
summary.push({ method: "baseline", label: "Rule baseline (keywords)", ...pick(bScore), cost_per_protocol: 0, latency_s_per_protocol: baselineMs / 1000 / TRIALS.length, schema_valid: 1, run_agreement: 1 });
for (const m of models) {
  const mr = runs.filter((r) => r.model === m);
  const perRep = [];
  for (let rep = 0; rep < repeats; rep++) {
    const preds = Object.assign({}, ...mr.filter((r) => r.rep === rep).map((r) => r.preds));
    perRep.push({ rep, preds, score: L.score(goldList, preds) });
  }
  const ids = allCriteria.map((c) => c.id);
  const agree = repeats > 1 ? ids.filter((id) => perRep.every((p) => p.preds[id] === perRep[0].preds[id])).length / ids.length : 1;
  const avg = (f) => perRep.reduce((a, p) => a + f(p.score), 0) / perRep.length;
  const valid = ids.length * repeats - perRep.reduce((a, p) => a + Object.values(p.preds).filter((v) => v === "NEEDS_REVIEW").length, 0);
  summary.push({
    method: m, label: `Claude ${m[0].toUpperCase() + m.slice(1)} (${MODELS[m]})`,
    accuracy: avg((s) => s.accuracy), strict_accuracy: avg((s) => s.strict_accuracy), macro_f1: avg((s) => s.macro_f1), n: perRep[0].score.n,
    errors: perRep[0].score.errors,
    cost_per_protocol: mr.reduce((a, r) => a + (r.cost_usd || 0), 0) / mr.length,
    latency_s_per_protocol: mr.reduce((a, r) => a + (r.duration_api_ms || 0), 0) / mr.length / 1000,
    schema_valid: valid / (ids.length * repeats), run_agreement: agree,
  });
}
function pick(s) { return { accuracy: s.accuracy, strict_accuracy: s.strict_accuracy, macro_f1: s.macro_f1, n: s.n, errors: s.errors }; }

// 5. Per-criterion view for the UI (first repeat of each model)
const criteriaOut = allCriteria.map((c) => {
  const row = { ...c, gold: gold[c.id].gold, alt: gold[c.id].alt || [], baseline: baseline[c.id], extract: L.ruleExtract(c.text), models: {} };
  for (const m of models) {
    const r = runs.find((x) => x.model === m && x.rep === 0 && x.nct === c.nct);
    const o = (r.parsed || []).find((x) => x.id === c.id);
    row.models[m] = o ? { category: r.preds[c.id], rationale: o.rationale, thresholds: o.thresholds, time_window: o.time_window, flags: o.flags } : { category: "NEEDS_REVIEW" };
  }
  return row;
});

// 6. Comparator benchmarks (frozen snapshot; the live UI re-queries ClinicalTrials.gov)
const comparators = {};
for (const nct of TRIALS) {
  try { comparators[nct] = await L.findComparators(studies[nct]); } catch (e) { comparators[nct] = { error: String(e) }; }
}

const studiesOut = Object.fromEntries(TRIALS.map((n) => { const { criteriaText, criteria, ...rest } = studies[n]; return [n, rest]; }));
const result = { generated: new Date().toISOString(), trials: TRIALS, models: Object.fromEntries(models.map((m) => [m, MODELS[m]])), repeats, effort,
                 summary, criteria: criteriaOut, studies: studiesOut, comparators };
writeFileSync(join(here, "results.json"), JSON.stringify(result, null, 1));
mkdirSync(join(here, "..", "data"), { recursive: true });
writeFileSync(join(here, "..", "data", "results.js"), "window.PEC_RESULTS = " + JSON.stringify(result) + ";\n");
console.table(summary.map((s) => ({ method: s.method, acc: s.accuracy.toFixed(3), strict: s.strict_accuracy.toFixed(3), macroF1: s.macro_f1.toFixed(3), cost: s.cost_per_protocol.toFixed(4), latency_s: s.latency_s_per_protocol.toFixed(2), valid: s.schema_valid, agree: s.run_agreement.toFixed(3) })));
