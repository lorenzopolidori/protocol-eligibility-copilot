---
name: eligibility-criteria-structurer
description: Structure clinical-trial eligibility criteria (from a protocol or ClinicalTrials.gov record) into a fixed category taxonomy with thresholds, time windows and feasibility flags, for protocol-feasibility review. Use when a study team asks to break down, classify, benchmark or stress-test inclusion/exclusion criteria.
---

# Eligibility Criteria Structurer

Part of a Development Operations skills library prototype. Output feeds a **human feasibility
reviewer** — it never makes an eligibility decision about a patient, and it runs only on
protocol text (no patient data).

## Inputs
- Study identifier, title, condition(s), phase.
- Atomic criteria, each with an id and section (inclusion / exclusion). Splitting is done
  deterministically upstream (`splitCriteria` in `steps.js`) so every run sees the same items.

## Taxonomy (exactly one per criterion; the TARGET condition is the study condition)
- **DEMOGRAPHICS** — age, sex, body weight, BMI.
- **DISEASE** — diagnosis/definition of the target condition, phenotype/biomarker, stage,
  severity, disease history, measurable disease, disease-specific tests (spirometry in COPD, viral
  load in HIV), resistance, disease-defining exposures (smoking in COPD), recent episodes, excluded
  subtypes or spread of the target disease.
- **THERAPY** — current, prior or prohibited treatments (drugs, vaccines, investigational products,
  procedures, surgery, rehabilitation, oxygen/ventilation), washouts, treatment history, prior
  exposure to study drug or class.
- **LABS_VITALS** — laboratory values, vital signs, ECG/QTc, organ function, performance status.
- **COMORBIDITY_SAFETY** — other conditions (not the target), infections, allergy, prior adverse
  events, other safety risks.
- **REPRODUCTIVE** — pregnancy, lactation, contraception, pregnancy testing.
- **CONSENT_LOGISTICS** — consent, compliance, self-administration/caregiver, parent-study
  completion, practical participation requirements.

## Feasibility flags (zero or more)
`screening_burden`, `washout`, `investigator_judgement`, `modernisation_candidate` (criterion types
FDA's 2020 eligibility-diversity guidance and the ASCO–Friends of Cancer Research recommendations
suggest broadening where justified — e.g. blanket HIV/HBV/HCV exclusion, brain metastases, organ
function, prior malignancy, washout lengths, upper age limits), `ambiguous`.

## Output
JSON array only, same order as input:
`{"id", "category", "rationale" (≤15 words), "thresholds": [..], "time_window": str|null, "flags": [..]}`

## Standards (what makes this skill library-ready)
- **Versioned contract:** taxonomy + schema live in `steps.js`; prompt is generated from it by `buildPrompt()`.
- **Evaluated before use:** `eval/run_eval.mjs` scores the skill against a rule baseline on a
  labelled reference set; results, cost and latency are published with the skill.
- **Reliability:** output is schema-checked; malformed output fails closed (criterion shown as
  "needs review", never silently defaulted). Run-to-run agreement is measured.
- **Human in the loop:** every output is a draft for a named reviewer; edits are logged.
