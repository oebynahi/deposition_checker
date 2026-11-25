import test from "node:test";
import assert from "node:assert/strict";
import { analyze, evidenceLines, findings } from "./analysis.js";
import { app } from "./server.js";

const item = { line1: 2, line2: 2, relation: "explicit_opposition", reason: "The second answer describes leaving home." };
const pair = ["Q: Where were you?\nA: I was home all night.", "Q: Where were you?\nA: I stepped out around 7."];
const compare = (inputs, candidate = item) => findings([candidate], inputs.map(evidenceLines))[0];

test("direct conflict uses original lines and discounts the qualified account", () => {
  const result = compare(pair, { ...item, confidence: 1 });
  assert.equal(result.type, "DIRECT");
  assert.equal(result.confidence, 80);
  assert.equal(result.evidence[1].text, "A: I stepped out around 7.");
});
test("inference retains the bridge and scores below explicit opposition", () => {
  const candidate = { ...item, relation: "incompatible_implications", reason: "Remaining awake until midnight excludes falling asleep at ten that night." };
  const result = compare(["Q: That night?\nA: I went to sleep at 10.", "Q: That night?\nA: I was up until midnight."], candidate);
  assert.equal(result.type, "INFERENTIAL");
  assert.equal(result.reason, candidate.reason);
  assert.equal(result.confidence, 68);
});
test("same question, rounded time versus five minutes later overrides an explicit-conflict label", () => {
  const result = compare(["Q: When did you arrive?\nA: Around 8.", "Q: When did you arrive?\nA: 8:05."]);
  assert.equal(result.type, "FALSE_POSITIVE");
  assert.equal(result.confidence, 4);
});
test("rounding rule respects event, distance and AM/PM", () => {
  const a = "Q: Arrival?\nA: Around 8pm.";
  for (const b of ["Q: Arrival?\nA: 8:05am.", "Q: Arrival?\nA: 9:15pm.", "Q: Departure?\nA: 8:05pm."]) {
    assert.equal(compare([a, b]).type, "DIRECT");
  }
});
test("scope differences may be retained as false positives", () => {
  const candidate = { ...item, relation: "compatible_accounts", reason: "Driving through the area does not require entering the warehouse." };
  const result = compare(["Q: Ever entered the warehouse?\nA: Never.", "Q: Visited the area?\nA: I've driven through."], candidate);
  assert.equal(result.type, "FALSE_POSITIVE");
  assert.equal(result.confidence, 12);
});
test("bad references, question citations and unknown relations fail closed", () => {
  for (const overrides of [{ line1: 400 }, { line2: 1 }, { relation: "unknown" }]) {
    assert.throws(() => compare(pair, { ...item, ...overrides }));
  }
});
test("duplicate findings collapse and an empty analysis succeeds", () => {
  assert.equal(findings([item,item], pair.map(evidenceLines)).length, 1);
  assert.deepEqual(findings([], pair.map(evidenceLines)), []);
});
const provider = async () => Response.json({
  choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ candidates: [item] }) } }]
});
test("HTTP entry point validates requests and returns source-grounded analysis", async t => {
  const server = await new Promise((resolve, reject) => {
    const listener = app({ apiKey: "test", fetchImpl: provider }).listen(0, "127.0.0.1");
    listener.once("listening", () => resolve(listener));
    listener.once("error", reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port + '/api/analyze';
  const post = transcripts => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcripts }) });
  const res = await post(pair);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).findings, [compare(pair)]);
  assert.equal((await post(["", " "])).status, 400);
});

test("Groq requests structured output and applies the same local scoring and citation checks", async () => {
  let candidate = { ...item, confidence: 1 };
  let finish_reason = "stop";
  const options = { apiKey: "test", fetchImpl: async (url, request) => {
    assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer test");
    const body = JSON.parse(request.body);
    assert.equal(body.model, "openai/gpt-oss-120b");
    assert.equal(body.response_format.json_schema.strict, true);
    return Response.json({ choices: [{ finish_reason, message: { content: JSON.stringify({ candidates: [candidate] }) } }] });
  } };
  assert.deepEqual(await analyze(pair, options), [compare(pair)]);
  candidate = { ...item, line1: 999 };
  await assert.rejects(analyze(pair, options), /Invalid citation/);
  finish_reason = "length";
  await assert.rejects(analyze(pair, options), /Incomplete analysis/);
});
