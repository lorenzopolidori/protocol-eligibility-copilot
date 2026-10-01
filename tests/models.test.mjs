// Tests for models.messagesApiModel() with a fake fetch, so no API key or network is needed.
//   node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const M = createRequire(import.meta.url)("../models.js");

const fakeFetch = (status, body, seen = {}) => async (url, init) => {
  Object.assign(seen, { url, init, body: JSON.parse(init.body) });
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
};

test("sends one Messages API call with the shared system prompt and returns the text", async () => {
  const seen = {};
  const call = M.messagesApiModel({ apiKey: "k", model: "claude-sonnet-5-5",
    fetchFn: fakeFetch(200, { model: "claude-sonnet-5-5", content: [{ type: "text", text: "[{\"id\":\"x\"}]" }], usage: { input_tokens: 5 } }, seen) });
  const out = await call("PROMPT");
  assert.equal(seen.url, "https://api.anthropic.com/v1/messages");
  assert.equal(seen.init.headers["x-api-key"], "k");
  assert.equal(seen.body.system, M.SYSTEM_PROMPT);
  assert.deepEqual(seen.body.messages, [{ role: "user", content: "PROMPT" }]);
  assert.equal(out.text, "[{\"id\":\"x\"}]");
  assert.equal(out.meta.usage.input_tokens, 5);
});

test("reads the API key at call time and refuses to call without one", async () => {
  let key = "";
  const call = M.messagesApiModel({ apiKey: () => key, fetchFn: fakeFetch(200, { content: [] }) });
  await assert.rejects(call("p"), /add an API key/);
  key = "k";
  await assert.doesNotReject(call("p"));
});

test("surfaces API errors so the orchestrator can fall back", async () => {
  const call = M.messagesApiModel({ apiKey: "k", fetchFn: fakeFetch(401, { error: "invalid x-api-key" }) });
  await assert.rejects(call("p"), /Anthropic API 401/);
});
