import test from "node:test";
import assert from "node:assert/strict";
import { analyze, evidenceLines } from "./analysis.js";
import { compareClaims } from "./claims.js";
import { app } from "./server.js";

const date = "November 3rd";
const pair = [
  "Q: Where were you the evening of November 3rd?\nA: I was home all evening.",
  "Q: Walk me through the evening of November 3rd.\nA: I think I stepped out around 7."
];
const claim = (transcript, quote, kind, fields = {}) => ({
  transcript, line: 2, quote, kind, witness: null, property: null, entity: null,
  event: date, time: null, value: null, qualifier: null, negated: false, ...fields
});
const home = [claim(1, "I was home all evening.", "stayed_home"),
  claim(2, "I think I stepped out around 7.", "left_home", { qualifier: "I think" })];
const compare = (claims, inputs = pair, weights) => compareClaims({ claims }, inputs.map(evidenceLines), weights);

test("home conflict is scored locally and stable across extraction ordering", () => {
  const rows = compare(home);
  assert.equal(rows[0].type, "DIRECT");
  assert.equal(rows[0].confidence, 80);
  assert.equal(rows[0].evidence[1].text, home[1].quote);
  assert.deepEqual(compare([home[1], home[0], home[0]]), rows);
  assert.equal(compare(home, pair, { hedge: 5 })[0].confidence, 85);
});

test("unverified event or different period requires a supported relationship", () => {
  assert.equal(compare([home[0], { ...home[1], event: null }])[0].confidence, 80);
  for (const question of ["Where were you that evening?", "Where were you the morning of November 3rd?"]) {
    assert.deepEqual(compare([], [pair[0], `Q: ${question}\nA: I think I stepped out around 7.`]), []);
  }
});

test("clock rules distinguish continuous wakefulness from an approximate match", () => {
  const sleep = "Q: When did you sleep on November 3rd?\nA: ";
  const a = claim(1, "I fell asleep at 10pm.", "fell_asleep", { time: "10pm" });
  const b = claim(2, "I was up until midnight.", "awake_until", { time: "midnight" });
  assert.equal(compare([a, b], [sleep + a.quote, sleep + b.quote])[0].type, "INFERENTIAL");
  const arrive = "Q: When did you arrive on November 3rd?\nA: ";
  const c = claim(1, "Around 8.", "time", { time: "Around 8" });
  const d = claim(2, "8:05.", "time", { time: "8:05" });
  assert.equal(compare([c, d], [arrive + c.quote, arrive + d.quote])[0].type, "FALSE_POSITIVE");
  assert.deepEqual(compare([c, d], [arrive + c.quote, arrive.replace("3rd", "4th") + d.quote]), []);
});

test("warehouse and neighborhood have different scopes", () => {
  const inputs = ["Q: Have you ever been to the Hargrove Street warehouse?\nA: No, never.",
    "Q: Had you ever visited the Hargrove Street area?\nA: I've driven through that part of town."];
  const claims = [claim(1, "No, never.", "assertion", { negated: true, event: null }),
    claim(2, "I've driven through that part of town.", "assertion", { event: null })];
  assert.equal(compare(claims, inputs)[0].type, "FALSE_POSITIVE");
});

test("fabricated quotes, attorney citations, and extra fields are rejected", () => {
  assert.throws(() => compare([{ ...home[0], quote: "Invented quote." }]), /Invalid citation/);
  assert.throws(() => compare([{ ...home[0], line: 1, quote: "Where were you" }]), /Invalid citation/);
  assert.throws(() => compare([{ ...home[0], confidence: 100 }]), /Invalid claim/);
});

const reply = (claims, finish_reason = "stop") => Response.json({
  choices: [{ finish_reason, message: { content: JSON.stringify({ claims }) } }]
});

test("Groq request asks only for claims and rejects truncation", async () => {
  let finish = "stop";
  const fetchImpl = async (url, req) => {
    assert.match(url, /api\.groq\.com/);
    const body = JSON.parse(req.body);
    assert.equal(body.temperature, 0);
    assert.equal(body.response_format.json_schema.name, "claims");
    assert.equal(body.response_format.json_schema.strict, true);
    return reply(home, finish);
  };
  assert.deepEqual(await analyze(pair, { apiKey: "test", fetchImpl }), compare(home));
  finish = "length";
  await assert.rejects(analyze(pair, { apiKey: "test", fetchImpl }), /Incomplete analysis/);
});

test("HTTP endpoint returns scored findings and validates inputs", async t => {
  const listener = app({ apiKey: "test", fetchImpl: async () => reply(home) }).listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => listener.once("listening", resolve).once("error", reject));
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const url = "http://127.0.0.1:" + listener.address().port + "/api/analyze";
  const post = transcripts => fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcripts })
  });
  const result = await post(pair);
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).findings, compare(home));
  assert.equal((await post(["", " "])).status, 400);
});

test("the parking-lot encounter scores as inferential with location and timing deductions", () => {
  const quote = "My neighbor, Tom, might have seen me. We waved or something in the parking lot.";
  const inputs = [pair[0], "Q: Did anyone see you that evening?\nA: " + quote];
  const encounter = claim(2, quote, "encounter", { event: null, qualifier: "might" });
  const [row] = compare([home[0], encounter], inputs);
  assert.deepEqual(compare([], inputs), [row]);
  assert.equal(row.type, "INFERENTIAL");
  assert.equal(row.confidence, 45);
  assert.match(row.reason, /away from home/);
  assert.equal(row.evidence[1].text, quote);
});

test("opposing awareness claims survive paraphrased questions and missing extraction", () => {
  const pair = ["Q: Had you met Daniel Cho before November 3rd?\nA: No. I'd never heard of him before this whole thing started.",
    "Q: And Daniel Cho — did you know him?\nA: I knew of him. We had mutual friends. I don't think I'd met him face to face."];
  const [row] = compare([], pair);
  assert.equal(row.type, "DIRECT");
  assert.equal(row.confidence, 80);
  assert.match(row.reason, /Daniel Cho/);
  assert.deepEqual(compare([], [pair[0], pair[1].replace("Daniel Cho", "Jane Smith")]), []);
  assert.deepEqual(compare([], [pair[0], pair[1].replace("I knew of him.", "I never met him.")]), []);
});

test("semantic suggestions bridge unlike questions and use local scores", () => {
  const lines = ["Q: Who had the pass?\nA: I held it the whole shift.", "Q: How did Pat get inside?\nA: I lent Pat my pass."].map(evidenceLines);
  const link = { line1: 2, line2: 2, relation: "implication", explanation: "Lending the pass implies giving up possession during the loan." };
  const [row] = compareClaims({ claims: [], links: [link] }, lines);
  assert.equal(row.type, "INFERENTIAL");
  assert.equal(row.confidence, 55);
  assert.equal(row.proposed, true);
  assert.throws(() => compareClaims({ claims: [], links: [{ ...link, line2: 1 }] }, lines));
});
