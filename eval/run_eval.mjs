// Offline evaluation: rule baseline vs Claude models on the labelled reference set.
// Every run goes through orchestrator.runPipeline(), the same pipeline the demo page uses; this
// script only supplies the frozen protocols and the classifiers, then scores the results.
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
const req = createRequire(import.meta.url);
const S = req(join(here, "..", "steps.js"));          // step implementations
const O = req(join(here, "..", "orchestrator.js"));   // the pipeline
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

// 1. Frozen protocols: raw CT.gov JSON cached in eval/data so the test set does not change.
// Passed to runPipeline() as its getStudy, in place of the live registry call.
const studyCache = {};
async function frozenStudy(nct) {
  if (studyCache[nct]) return studyCache[nct];
  const f = join(here, "data", `${nct}.json`);
  if (refresh || !existsSync(f)) {
    const r = await fetch(`https://clinicaltrials.gov/api/v2/studies/${nct}`);
    writeFileSync(f, JSON.stringify(await r.json(), null, 1));
  }
  return (studyCache[nct] = S.summariseStudy(JSON.parse(readFileSync(f, "utf8"))));
}

// 2. Baseline: one pipeline run per protocol with the rule classifier. It also yields the split
// criteria and the comparator benchmark snapshot used by the page.
const studies = {}, baseline = {}, comparators = {};
let baselineMs = 0;
for (const nct of TRIALS) {
  const r = await O.runPipeline(nct, { getStudy: frozenStudy, classifier: O.baselineClassifier() });
  studies[nct] = { ...r.study, criteria: r.criteria };
  for (const [id, p] of Object.entries(r.preds)) baseline[id] = p.category;
  baselineMs += r.classification.ms;
  comparators[nct] = r.bench || { error: "comparator search failed" };
}
const gold = JSON.parse(readFileSync(join(here, "gold_labels.json"), "utf8")).labels;
const goldList = Object.entries(gold).map(([id, g]) => ({ id, ...g }));
const allCriteria = TRIALS.flatMap((n) => studies[n].criteria);
if (allCriteria.length !== goldList.length) throw new Error(`criteria/gold mismatch ${allCriteria.length} vs ${goldList.length}`);

// 3. Models (30 pipeline runs: models × repeats × protocols, 5 at a time)
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

// callModel for the model classifier: reuse the saved run in eval/runs if there is one,
// otherwise call the model and save the answer with its cost, time and token counts.
function savedOrLiveModel(m, rep, nct) {
  return async (prompt) => {
    const cache = join(runsDir, `${m}-r${rep}-${nct}.json`);
    let res;
    if (!refresh && existsSync(cache)) res = JSON.parse(readFileSync(cache, "utf8"));
    else {
      const started = Date.now();
      const out = await claude(MODELS[m], prompt);
      res = { model: m, modelId: MODELS[m], effort, rep, nct, wall_ms: Date.now() - started, duration_api_ms: out.duration_api_ms,
              cost_usd: out.total_cost_usd, usage: out.usage, raw: out.result, at: new Date().toISOString() };
      writeFileSync(cache, JSON.stringify(res, null, 1));
    }
    return { text: res.raw, meta: res };
  };
}

const runs = [];
const tasks = [];
for (const m of models) for (let rep = 0; rep < repeats; rep++) for (const nct of TRIALS) {
  tasks.push(async () => {
    // same pipeline as the page; no benchmark (already captured above) and no human review
    const r = await O.runPipeline(nct, {
      getStudy: frozenStudy, benchmark: false,
      classifier: O.modelClassifier(savedOrLiveModel(m, rep, nct), MODELS[m]),
    });
    const { meta: res, answers: parsed, parseError } = r.classification;
    // runPipeline has already failed closed: missing or unknown categories are NEEDS_REVIEW
    const preds = Object.fromEntries(Object.entries(r.preds).map(([id, p]) => [id, p.category]));
    runs.push({ ...res, parsed, parseError, preds });
    console.error(`${m} r${rep} ${nct}: ${parseError ? "PARSE ERROR " + parseError : "ok"} $${res.cost_usd?.toFixed(4)} ${res.duration_api_ms}ms`);
  });
}
await pool(tasks, 5);

// 4. Score
const summary = [];
const bScore = S.score(goldList, baseline);
summary.push({ method: "baseline", label: "Rule baseline (keywords)", ...pick(bScore), cost_per_protocol: 0, latency_s_per_protocol: baselineMs / 1000 / TRIALS.length, schema_valid: 1, run_agreement: 1 });
for (const m of models) {
  const mr = runs.filter((r) => r.model === m);
  const perRep = [];
  for (let rep = 0; rep < repeats; rep++) {
    const preds = Object.assign({}, ...mr.filter((r) => r.rep === rep).map((r) => r.preds));
    perRep.push({ rep, preds, score: S.score(goldList, preds) });
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

// 4b. Flags have no answer key yet, so measure what we can without one: how often each flag is
// raised, whether the same model repeats it on a second run, and whether models agree.
const FLAG_KEYS = Object.keys(S.FLAGS);
const flagsOf = (m, rep, id) => {
  const r = runs.find((x) => x.model === m && x.rep === rep && x.nct === id.slice(0, 11));
  const o = (r?.parsed || []).find((x) => x.id === id);
  return new Set((o?.flags || []).filter((f) => FLAG_KEYS.includes(f)));
};
const ids = allCriteria.map((c) => c.id);
const flagStats = { per_model: {}, cross_model: {} };
for (const m of models) {
  const per = {};
  for (const f of FLAG_KEYS) {
    const raised = ids.filter((id) => flagsOf(m, 0, id).has(f)).length;
    const agree = repeats > 1 ? ids.filter((id) => flagsOf(m, 0, id).has(f) === flagsOf(m, 1, id).has(f)).length / ids.length : null;
    per[f] = { raised, rate: raised / ids.length, run_agreement: agree };
  }
  const exact = repeats > 1 ? ids.filter((id) => { const a = flagsOf(m, 0, id), b = flagsOf(m, 1, id); return a.size === b.size && [...a].every((x) => b.has(x)); }).length / ids.length : null;
  flagStats.per_model[m] = { per_flag: per, flag_set_run_agreement: exact };
}
for (let i = 0; i < models.length; i++) for (let j = i + 1; j < models.length; j++) {
  const a = models[i], b = models[j], out = {};
  for (const f of FLAG_KEYS) {
    const A = ids.filter((id) => flagsOf(a, 0, id).has(f)), B = new Set(ids.filter((id) => flagsOf(b, 0, id).has(f)));
    const both = A.filter((id) => B.has(id)).length, union = new Set([...A, ...B]).size;
    out[f] = { both, only_a: A.length - both, only_b: B.size - both, jaccard: union ? both / union : null };
  }
  flagStats.cross_model[`${a}_vs_${b}`] = out;
}

// 5. Per-criterion view for the UI (first repeat of each model)
const criteriaOut = allCriteria.map((c) => {
  const row = { ...c, gold: gold[c.id].gold, alt: gold[c.id].alt || [], baseline: baseline[c.id], extract: S.ruleExtract(c.text), models: {} };
  for (const m of models) {
    const r = runs.find((x) => x.model === m && x.rep === 0 && x.nct === c.nct);
    const o = (r.parsed || []).find((x) => x.id === c.id);
    row.models[m] = o ? { category: r.preds[c.id], rationale: o.rationale, thresholds: o.thresholds, time_window: o.time_window, flags: o.flags } : { category: "NEEDS_REVIEW" };
  }
  return row;
});

const studiesOut = Object.fromEntries(TRIALS.map((n) => { const { criteriaText, criteria, ...rest } = studies[n]; return [n, rest]; }));
const result = { generated: new Date().toISOString(), trials: TRIALS, models: Object.fromEntries(models.map((m) => [m, MODELS[m]])), repeats, effort,
                 summary, flag_stats: flagStats, criteria: criteriaOut, studies: studiesOut, comparators };
writeFileSync(join(here, "results.json"), JSON.stringify(result, null, 1));
mkdirSync(join(here, "..", "data"), { recursive: true });
writeFileSync(join(here, "..", "data", "results.js"), "window.PEC_RESULTS = " + JSON.stringify(result) + ";\n");
console.log("flag-set run agreement:", Object.fromEntries(Object.entries(flagStats.per_model).map(([m, v]) => [m, v.flag_set_run_agreement?.toFixed(2)])));
console.table(summary.map((s) => ({ method: s.method, acc: s.accuracy.toFixed(3), strict: s.strict_accuracy.toFixed(3), macroF1: s.macro_f1.toFixed(3), cost: s.cost_per_protocol.toFixed(4), latency_s: s.latency_s_per_protocol.toFixed(2), valid: s.schema_valid, agree: s.run_agreement.toFixed(3) })));
