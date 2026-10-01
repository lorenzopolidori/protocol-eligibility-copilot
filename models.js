/* Protocol Eligibility Copilot — model adapters.
 * Each adapter returns a callModel(prompt) function for orchestrator.modelClassifier(). It
 * resolves to { text, meta }. The orchestrator decides when the model is called; an adapter only
 * knows how to reach one. Swapping provider or model means passing a different adapter.
 * The eval harness's claude CLI adapter lives in eval/run_eval.mjs because it needs Node.
 */
(function (root) {
  "use strict";

  // Shared by every adapter, so all models get exactly the same instructions.
  const SYSTEM_PROMPT = "You are a precise clinical-operations data analyst. Follow the output format exactly.";
  const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

  // Claude Messages API over plain fetch: works in the browser and in Node 18+.
  // apiKey may be a string or a function (read at call time, e.g. from a form field).
  function messagesApiModel({ apiKey, model = "claude-sonnet-5-5", maxTokens = 8000, fetchFn } = {}) {
    return async (prompt) => {
      const key = typeof apiKey === "function" ? apiKey() : apiKey;
      if (!key) throw new Error("add an API key to run live");
      const headers = { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" };
      // required for calls made directly from a browser page
      if (typeof window !== "undefined") headers["anthropic-dangerous-direct-browser-access"] = "true";
      const started = Date.now();
      const r = await (fetchFn || fetch)(MESSAGES_URL, {
        method: "POST", headers,
        body: JSON.stringify({ model, max_tokens: maxTokens, system: SYSTEM_PROMPT, messages: [{ role: "user", content: prompt }] }),
      });
      if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${(await r.text()).slice(0, 120)}`);
      const j = await r.json();
      const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      return { text, meta: { model: j.model || model, usage: j.usage, wall_ms: Date.now() - started } };
    };
  }

  const api = { SYSTEM_PROMPT, messagesApiModel };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Models = api;
})(typeof window !== "undefined" ? window : globalThis);
