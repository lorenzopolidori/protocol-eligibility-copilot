/* Protocol Eligibility Copilot — orchestrator.
 * Owns the flow: the order of the steps, which classifier runs, the fallbacks and the fail-closed
 * check. The step implementations it calls live in steps.js.
 * Used by index.html (interactive, with human review) and by eval/run_eval.mjs (batch), so the
 * page and the evaluation run exactly the same pipeline.
 *
 *   runPipeline(nct, options)
 *     1 · Fetch      options.getStudy (default: steps.getStudy, live)  → fallback: snapshot.study
 *     2 · Split      steps.splitCriteria + assignIds                  → fallback: snapshot.criteria
 *     3 · Classify   options.classifier                               → fallback: options.fallbackClassifier
 *     4 · Benchmark  steps.findComparators (live)                     → fallback: snapshot.comparators
 *     5 · Review     handed to the caller (options.humanReview)
 */
(function (root) {
  "use strict";
  const Steps = typeof module !== "undefined" && module.exports ? require("./steps.js") : root.Steps;
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  async function timed(fn) { const t = now(); const v = await fn(); return [v, now() - t]; }

  // Fail closed: a criterion with no answer, or an answer outside the taxonomy, becomes
  // NEEDS_REVIEW. It is never silently defaulted to a category.
  function failClosed(criteria, answers) {
    const byId = Object.fromEntries((answers || []).map((o) => [o.id, o]));
    return Object.fromEntries(criteria.map((c) => {
      const o = byId[c.id];
      if (!o) return [c.id, { category: "NEEDS_REVIEW" }];
      return [c.id, Steps.CATS.includes(o.category) ? o : { ...o, category: "NEEDS_REVIEW" }];
    }));
  }

  // ---------------------------------------------------------------------------------------------
  // Classifiers. Each one classifies all criteria of one protocol and returns { preds: {id: answer} }.
  // ---------------------------------------------------------------------------------------------
  function baselineClassifier() {
    return {
      kind: "baseline", label: "keyword rules",
      async classify(study, criteria) {
        const preds = {};
        for (const c of criteria) {
          const x = Steps.ruleExtract(c.text);
          preds[c.id] = { category: Steps.ruleClassify(c.text), thresholds: x.thresholds, time_window: x.time_window, flags: [] };
        }
        return { preds };
      },
    };
  }

  // lookup(id) returns a stored answer for one criterion, or undefined.
  function recordedClassifier(lookup, label) {
    return {
      kind: "recorded", label,
      async classify(study, criteria) {
        const found = criteria.map((c) => [c.id, lookup(c.id)]);
        if (!found.some(([, o]) => o)) throw new Error("no recorded run for this protocol");
        return { preds: Object.fromEntries(found.map(([id, o]) => [id, o || { category: "NEEDS_REVIEW" }])) };
      },
    };
  }

  // callModel(prompt, study) sends the prompt to a model and resolves to { text, meta }.
  // The page passes a browser call to the Claude Messages API; the evaluation passes the claude CLI.
  function modelClassifier(callModel, label) {
    return {
      kind: "model", label,
      async classify(study, criteria) {
        const prompt = Steps.buildPrompt(study, criteria);
        const out = await callModel(prompt, study);
        let answers = null, parseError = null;
        try { answers = Steps.parseModelJson(out.text); } catch (e) { parseError = String(e.message); }
        return { preds: failClosed(criteria, answers), answers, parseError, meta: out.meta };
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // The pipeline. onStep(step, state, info) reports progress: state is run | done | fallback |
  // error | human, and info carries ms, source, n, classifier and error where relevant.
  // ---------------------------------------------------------------------------------------------
  async function runPipeline(nct, options) {
    const o = {
      getStudy: (id) => Steps.getStudy(id, options.fetchFn),
      snapshot: {}, fallbackClassifier: null, benchmark: true, humanReview: false, onStep: () => {},
      ...options,
    };
    const snap = o.snapshot, step = o.onStep;

    // 1 · Fetch protocol
    step("fetch", "run", {});
    let study, live = true;
    try {
      const [s, ms] = await timed(() => o.getStudy(nct));
      study = s; step("fetch", "done", { ms, source: "live" });
    } catch (e) {
      live = false;
      study = snap.study ? snap.study(nct) : null;
      if (!study) { step("fetch", "error", { error: e.message }); throw e; }
      step("fetch", "fallback", { source: "snapshot", error: e.message });
    }

    // 2 · Split criteria
    const snapCriteria = snap.criteria ? snap.criteria(nct) : null;
    let criteria = study.criteriaText ? Steps.assignIds(study.nct, Steps.splitCriteria(study.criteriaText)) : snapCriteria;
    if (!criteria || !criteria.length) {
      const e = new Error("no eligibility criteria found"); step("split", "error", { error: e.message }); throw e;
    }
    if (snapCriteria && criteria.length !== snapCriteria.length) {
      criteria = snapCriteria; step("split", "fallback", { n: criteria.length, source: "snapshot" });
    } else step("split", "done", { n: criteria.length });

    // 3 · Classify & flag
    let used = o.classifier, result;
    step("classify", "run", { classifier: used.kind, label: used.label });
    try {
      const [r, ms] = await timed(() => used.classify(study, criteria));
      result = { ...r, ms };
      step("classify", "done", { classifier: used.kind, label: used.label, ms, parseError: r.parseError });
    } catch (e) {
      if (!o.fallbackClassifier) { step("classify", "error", { error: e.message }); throw e; }
      used = o.fallbackClassifier;
      const [r, ms] = await timed(() => used.classify(study, criteria));
      result = { ...r, ms };
      step("classify", "fallback", { classifier: used.kind, label: used.label, ms, error: e.message });
    }

    // 4 · Benchmark against completed trials
    let bench = null;
    if (o.benchmark) {
      step("bench", "run", {});
      if (live) {
        try {
          const [b, ms] = await timed(() => Steps.findComparators(study, o.fetchFn));
          bench = b; step("bench", "done", { ms, n: b.sampled, source: "live" });
        } catch (e) {
          bench = snap.comparators ? snap.comparators(nct) : null;
          step("bench", bench ? "fallback" : "error", { n: bench && bench.sampled, source: "snapshot", error: e.message });
        }
      } else {
        bench = snap.comparators ? snap.comparators(nct) : null;
        step("bench", bench ? "fallback" : "error", { n: bench && bench.sampled, source: "snapshot" });
      }
    }

    // 5 · Human review: the caller shows the results and records the reviewer's decisions
    if (o.humanReview) step("review", "human", {});

    return {
      study, criteria, preds: result.preds, bench, live,
      classification: { kind: used.kind, label: used.label, ms: result.ms, fellBack: used !== o.classifier,
                        answers: result.answers, parseError: result.parseError, meta: result.meta },
    };
  }

  const api = { runPipeline, baselineClassifier, recordedClassifier, modelClassifier, failClosed };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Orchestrator = api;
})(typeof window !== "undefined" ? window : globalThis);
