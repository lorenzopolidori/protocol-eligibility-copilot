// Tests for orchestrator.runPipeline(): every step, fallback and classifier path, offline.
// The registry is replaced by the frozen protocols in eval/data, so no network is needed.
//   node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const S = req("../steps.js");
const O = req("../orchestrator.js");

const NCT = "NCT07650916"; // HIV protocol, 10 criteria
const raw = JSON.parse(readFileSync(new URL(`../eval/data/${NCT}.json`, import.meta.url), "utf8"));
const study = S.summariseStudy(raw);
const offline = async () => { throw new Error("registry unreachable"); };
const snapshot = {
  study: () => { const { criteriaText, ...rest } = study; return rest; },
  criteria: () => S.assignIds(NCT, S.splitCriteria(study.criteriaText)),
  comparators: () => ({ sampled: 3, median_enrollment: 100 }),
};
const events = () => { const log = []; return { log, onStep: (step, st) => log.push(`${step}:${st}`) }; };

test("baseline run: all steps done, review handed over", async () => {
  const ev = events();
  const r = await O.runPipeline(NCT, { getStudy: async () => study, classifier: O.baselineClassifier(), benchmark: false, humanReview: true, onStep: ev.onStep });
  assert.equal(r.criteria.length, 10);
  assert.equal(r.preds[`${NCT}-inc-03`].category, "THERAPY");
  assert.deepEqual(ev.log, ["fetch:run", "fetch:done", "split:done", "classify:run", "classify:done", "review:human"]);
});

test("registry unreachable: falls back to the frozen snapshot for study and benchmark", async () => {
  const ev = events();
  const r = await O.runPipeline(NCT, { getStudy: offline, snapshot, classifier: O.baselineClassifier(), onStep: ev.onStep });
  assert.equal(r.live, false);
  assert.equal(r.criteria.length, 10);
  assert.equal(r.bench.sampled, 3);
  assert.ok(ev.log.includes("fetch:fallback") && ev.log.includes("bench:fallback"));
});

test("registry unreachable and no snapshot: fails at step 1", async () => {
  const ev = events();
  await assert.rejects(O.runPipeline("NCT00000000", { getStudy: offline, classifier: O.baselineClassifier(), onStep: ev.onStep }));
  assert.deepEqual(ev.log, ["fetch:run", "fetch:error"]);
});

test("recorded classifier with no stored run: falls back to the baseline", async () => {
  const ev = events();
  const r = await O.runPipeline(NCT, { getStudy: async () => study, benchmark: false, onStep: ev.onStep,
    classifier: O.recordedClassifier(() => undefined, "none"), fallbackClassifier: O.baselineClassifier() });
  assert.equal(r.classification.kind, "baseline");
  assert.equal(r.classification.fellBack, true);
  assert.ok(ev.log.includes("classify:fallback"));
});

test("model call fails (e.g. no API key): falls back to the baseline", async () => {
  const r = await O.runPipeline(NCT, { getStudy: async () => study, benchmark: false,
    classifier: O.modelClassifier(async () => { throw new Error("add an API key to run live"); }, "test"),
    fallbackClassifier: O.baselineClassifier() });
  assert.equal(r.classification.fellBack, true);
});

test("unreadable model reply: fails closed, every criterion NEEDS_REVIEW", async () => {
  const r = await O.runPipeline(NCT, { getStudy: async () => study, benchmark: false,
    classifier: O.modelClassifier(async () => ({ text: "Sorry, I cannot help with that." }), "test") });
  assert.ok(r.classification.parseError);
  assert.ok(Object.values(r.preds).every((p) => p.category === "NEEDS_REVIEW"));
});

test("partial or invalid model answers: only the bad ones become NEEDS_REVIEW", async () => {
  const ids = S.assignIds(NCT, S.splitCriteria(study.criteriaText)).map((c) => c.id);
  const reply = JSON.stringify([{ id: ids[0], category: "DEMOGRAPHICS" }, { id: ids[1], category: "NOT_A_CATEGORY" }]);
  let prompt = "";
  const r = await O.runPipeline(NCT, { getStudy: async () => study, benchmark: false,
    classifier: O.modelClassifier(async (p) => { prompt = p; return { text: reply }; }, "test") });
  assert.ok(prompt.includes(ids[0]) && prompt.includes("TAXONOMY"), "prompt is built by steps.buildPrompt");
  assert.equal(r.preds[ids[0]].category, "DEMOGRAPHICS");
  assert.equal(r.preds[ids[1]].category, "NEEDS_REVIEW");
  assert.equal(r.preds[ids[2]].category, "NEEDS_REVIEW");
});
