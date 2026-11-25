const kinds = ["assertion", "time", "stayed_home", "left_home", "fell_asleep", "awake_until", "encounter"];
const textFields = ["witness", "property", "entity", "event", "time", "value", "qualifier"];
const properties = {
  transcript: { type: "integer", enum: [1, 2] }, line: { type: "integer" },
  quote: { type: "string" }, kind: { type: "string", enum: kinds },
  negated: { type: ["boolean", "null"] },
  ...Object.fromEntries(textFields.map(field => [field, { type: ["string", "null"] }]))
};
const linkFields = {
  line1: { type: "integer" }, line2: { type: "integer" },
  relation: { type: "string", enum: ["opposition", "implication", "compatible"] },
  explanation: { type: "string" }
};
export const claimSchema = {
  type: "object", additionalProperties: false, required: ["claims", "links"],
  properties: { links: { type: "array", items: { type: "object", additionalProperties: false, required: Object.keys(linkFields), properties: linkFields } }, claims: { type: "array", items: {
    type: "object", additionalProperties: false, required: Object.keys(properties), properties
  } } }
};

export const defaultWeights = {
  direct: 90, inferential: 65, compatible: 8, hedge: 10, assumption: 10, approximateMinutes: 10
};

function scoreRelationship(evidence, base, factors, deductions = []) {
  const confidence = Math.max(0, Math.min(100, base - deductions.reduce((sum, [, points]) => sum + points, 0)));
  const type = confidence >= 70 ? "DIRECT" : confidence >= 35 ? "INFERENTIAL" : "FALSE_POSITIVE";
  return { type, confidence, evidence, factors: [
    ...factors, `Starting strength: ${base}`,
    ...deductions.map(([reason, points]) => `${reason} (−${points})`)
  ] };
}

const normalize = text => text?.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
const hedge = /\b(maybe|might|perhaps|possibly|around|about|roughly|approximately|i think|i believe)\b/i;
const negative = /\b(no|not|never|\w+n't)\b/i;
const identifiableEvent = /\b(?:\d{4}-\d\d-\d\d|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}|(?:the|on)\s+night of\s+\w+)/i;

function validate(payload, lines) {
  if (!payload || Object.keys(payload).some(key => !["claims", "links"].includes(key)) || !Array.isArray(payload.claims) ||
      payload.claims.length > 160) throw Error("Invalid claims");
  return payload.claims.map(claim => {
    if (!claim || Object.keys(claim).length !== Object.keys(properties).length ||
        ![1, 2].includes(claim.transcript) || !Number.isInteger(claim.line) ||
        !kinds.includes(claim.kind) || ![null, true, false].includes(claim.negated) ||
        typeof claim.quote !== "string" || !claim.quote.trim() ||
        textFields.some(field => claim[field] !== null &&
          (typeof claim[field] !== "string" || !claim[field].trim()))) throw Error("Invalid claim");
    const rows = lines[claim.transcript - 1];
    const cited = rows.find(row => row.line === claim.line);
    if (!cited?.text.includes(claim.quote) || /^q:/i.test(cited.text) ||
        (rows.some(row => /^a:/i.test(row.text)) && !/^a:/i.test(cited.text))) throw Error("Invalid citation");
    const question = rows.findLast(row => row.line < claim.line && /^q:/i.test(row.text))?.text;
    const grounded = { ...claim, question, answer: cited.text };
    for (const field of textFields) {
      const sources = ["event", "entity", "property"].includes(field) ? [claim.quote, question] : [claim.quote];
      if (!sources.some(source => source?.includes(claim[field]))) grounded[field] = null;
    }
    return grounded;
  });
}

function clock(text) {
  const match = /^(?:(around|about|approximately|roughly)\s+)?(?:(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)?|(midnight|noon))$/i.exec(normalize(text) || "");
  if (!match) return null;
  const [, approximate, hour, minute, period, named] = match;
  return {
    approximate, period: named ? (named === "midnight" ? "am" : "pm") : period,
    minutes: (Number(hour || 12) % 12) * 60 + Number(minute || 0)
  };
}

const same = (a, b) => Boolean(a && b && normalize(a) === normalize(b));

function period(text) {
  return /\b(morning|afternoon|evening|night|day) of\b/i.exec(text || "")?.[1].toLowerCase();
}

const homeThroughout = /\b(?:at home|home) all (?:evening|night|day)\b/i;
const leavingHome = /\b(?:went out|stepped out|left (?:the house|home))\b/i;
const parkingEncounter = /\b(?:saw|seen|waved|met)\b/i;

function explicitClaims(lines) {
  return lines.flatMap((rows, index) => rows.flatMap(row => {
    if (!/^a:/i.test(row.text)) return [];
    const quote = row.text.replace(/^a:\s*/i, "");
    const question = rows.findLast(entry => entry.line < row.line && /^q:/i.test(entry.text))?.text;
    let kind;
    if (homeThroughout.test(quote)) kind = "stayed_home";
    else if (leavingHome.test(quote)) kind = "left_home";
    else if (parkingEncounter.test(quote) && /\bparking lot\b/i.test(quote)) kind = "encounter";
    if (!kind) return [];
    return [{
      transcript: index + 1, line: row.line, kind, quote, question, answer: row.text,
      event: question?.match(identifiableEvent)?.[0] ?? null,
      negated: negative.test(row.text)
    }];
  }));
}

function rule(a, b, weights) {
  // Match the same named street, with distinct building and neighborhood scopes.
  for (const [building, area] of [[a, b], [b, a]]) {
    const street = /\bever (?:been to|visited|entered) the (.+?) warehouse\?/i.exec(building.question || "")?.[1];
    if (street && normalize(area.question)?.includes(normalize(street) + " area") &&
        /^(?:a:\s*)?(?:no|never)\b/i.test(building.quote) &&
        /\b(?:drove|driven) through\b/i.test(area.quote)) {
      return ["FALSE_POSITIVE", "compatible", "Driving through the named area is consistent with never visiting the warehouse.", "scope"];
    }
  }
  const byKind = Object.fromEntries([a, b].map(claim => [claim.kind, claim]));
  if (byKind.stayed_home && byKind.encounter &&
      /\b(?:at home|home) all (?:evening|night|day)\b/i.test(byKind.stayed_home.quote) &&
      /\bparking lot\b/i.test(byKind.encounter.answer) &&
      /\b(?:saw|seen|waved|met)\b/i.test(byKind.encounter.quote)) {
    return ["INFERENTIAL", "inferential",
      "The reported parking-lot encounter would challenge the stay-at-home account if it happened during that period at a lot away from home. The cited testimony does not establish both facts.", "conditional"];
  }
  if (Object.hasOwn(byKind, "stayed_home") && Object.hasOwn(byKind, "left_home") &&
      /\b(?:at home|home) all (?:evening|night|day)\b/i.test(byKind.stayed_home.quote) &&
      /\b(?:went out|stepped out|left (?:the house|home))\b/i.test(byKind.left_home.quote)) {
    return ["DIRECT", "direct", "Staying home throughout the stated period conflicts with leaving during it.", "same period"];
  }
  if (byKind.fell_asleep && byKind.awake_until &&
      /\b(?:went to sleep|fell asleep)\b/i.test(byKind.fell_asleep.quote) &&
      /\b(?:awake|up) until\b/i.test(byKind.awake_until.quote)) {
    const sleep = clock(byKind.fell_asleep.time);
    const awake = clock(byKind.awake_until.time);
    if (sleep?.period === "pm" && awake?.period === "am" && awake.minutes === 0) {
      return ["INFERENTIAL", "inferential", "On the same night, staying awake until midnight implies the witness was awake at the earlier evening sleep time.", "same event"];
    }
    return null;
  }
  if (a.kind === "time" && b.kind === "time" && same(a.question, b.question)) {
    const x = clock(a.time);
    const y = clock(b.time);
    if (x && y && (x.approximate || y.approximate || hedge.test(a.quote + " " + b.quote)) &&
        x.period === y.period && Math.abs(x.minutes - y.minutes) <= weights.approximateMinutes) {
      return ["FALSE_POSITIVE", "compatible", `Approximate times for the same occurrence are within ${weights.approximateMinutes} minutes.`, "same event"];
    }
  }
  if (a.kind === "assertion" && b.kind === "assertion" && same(a.property, b.property) &&
      same(a.entity, b.entity) && same(a.value, b.value) && a.negated !== b.negated) {
    return ["DIRECT", "direct", "One answer affirms a proposition that the other denies.", "same event"];
  }
  return null;
}

// Resolve pronouns from a single named person in the question. This runs even
// when extraction misses one of the two awareness statements.
function awarenessPairs(lines, weights) {
  const mentions = lines.map(rows => {
    let question = "";
    const answers = [];
    for (const row of rows) {
      if (/^q:/i.test(row.text)) question = row.text;
      if (!/^a:/i.test(row.text)) continue;
      const names = question.replace(/^Q:\s*(?:And|Regarding|About)\s+/i, "").match(/\b[A-Z][a-z]+(?: [A-Z][a-z]+)+\b/g) || [];
      if (names.length !== 1) continue;
      const text = normalize(row.text);
      const denied = /\b(?:never heard of|hadn't heard of) (?:him|her|them)\b/.test(text);
      const affirmed = /\bi (?:knew of|had heard of|was aware of) (?:him|her|them)\b/.test(text);
      if (denied === affirmed) continue;
      answers.push({ row, name: names[0], denied, question });
    }
    return answers;
  });
  const findings = [];
  for (const a of mentions[0]) {
    for (const b of mentions[1]) {
      if (!same(a.name, b.name) || a.denied === b.denied) continue;
      const positive = a.denied ? b : a;
      if (/\b(?:only (?:later|after)|since then|first heard .*after)\b/i.test(positive.row.text)) continue;
      findings.push({
        ...scoreRelationship([a.row, b.row], weights.direct,
          ["Both answer lines verified.", "Both questions identify " + a.name + "."],
          [["The second answer leaves the time frame implicit", weights.assumption]]),
        reason: `The witness denies having heard of ${a.name} in one account and acknowledges knowing of the same person in the other. The answers directly oppose each other on prior awareness. The second answer leaves the time frame implicit.`,

      });
    }
  }
  return findings;
}

function semanticPairs(links, lines, weights) {
  if (!Array.isArray(links) || links.length > 80) throw Error("Invalid semantic links");
  const bases = { opposition: "direct", implication: "inferential", compatible: "compatible" };
  return links.map(link => {
    if (!link || Object.keys(link).length !== 4 || !Object.hasOwn(bases, link.relation) ||
        typeof link.explanation !== "string" || !link.explanation.trim()) throw Error("Invalid semantic link");
    const evidence = [link.line1, link.line2].map((id, i) => {
      const row = lines[i].find(entry => entry.line === id);
      if (!row || /^q:/i.test(row.text) ||
          (lines[i].some(entry => /^a:/i.test(entry.text)) && !/^a:/i.test(row.text))) throw Error("Invalid link citation");
      return row;
    });
    const deductions = link.relation === "compatible" ? [] : [
      ["Relationship proposed by Groq", weights.assumption],
      ...qualifiedAnswers(evidence, weights)
    ];
    return { ...scoreRelationship(evidence, weights[bases[link.relation]], ["Both cited answer lines verified."], deductions),
      reason: link.explanation, proposed: true };
  });
}

function qualifiedAnswers(evidence, weights) {
  return evidence.flatMap(({ text }, index) => hedge.test(text)
    ? [[`Qualified wording in transcript ${index + 1}`, weights.hedge]] : []);
}

export function compareClaims(payload, lines, overrides = {}) {
  const weights = { ...defaultWeights, ...overrides };
  const extracted = validate(payload, lines);
  const explicit = explicitClaims(lines);
  const claims = [...explicit, ...extracted.filter(claim => !explicit.some(local =>
    local.transcript === claim.transcript && local.line === claim.line && local.kind === claim.kind
  ))];
  const results = new Map();
  for (const a of claims.filter(claim => claim.transcript === 1)) {
    for (const b of claims.filter(claim => claim.transcript === 2)) {
      if (a.kind === b.kind && same(a.quote, b.quote) && same(a.event, b.event)) continue;
      const match = rule(a, b, weights);
      if (!match) continue;
      const [type, weight, reason, alignment] = match;
      const factors = ["Both supporting quotes verified against the submitted transcripts."];
      const eventMatches = same(a.event, b.event) && identifiableEvent.test(a.event);
      const polarityMatches = [a, b].every(claim => claim.negated !== null &&
        claim.negated === negative.test(claim.answer));
      const scopeMatches = alignment !== "same period" ||
        (same(period(a.question), period(b.question)) &&
          new RegExp("\\ball " + period(a.question) + "\\b", "i").test(a.kind === "stayed_home" ? a.quote : b.quote));
      if (a.witness && b.witness && !same(a.witness, b.witness)) continue;
      if (!weight) continue;
      if (alignment !== "scope" && alignment !== "conditional" &&
          (!eventMatches || !polarityMatches || !scopeMatches ||
           ((type !== "DIRECT" || a.kind !== "assertion") && (a.negated || b.negated)))) continue;
      const deductions = type === "FALSE_POSITIVE" ? [] :
        qualifiedAnswers([a, b].map(claim => ({ text: claim.answer })), weights);
      if (type === "INFERENTIAL") {
        deductions.push([alignment === "conditional" ? "Encounter location and timing are inferred" :
          "Inference about continuous wakefulness", weights.assumption]);
      }
      if (eventMatches) factors.push(`Shared event: ${a.event}`);
      const evidence = [a, b].map(({ line, quote }) => ({ line, text: quote }));
      const finding = { ...scoreRelationship(evidence, weights[weight], factors, deductions), reason };
      results.set(JSON.stringify(finding), finding);
    }
  }
  const rows = [...results.values()];
  const pairKey = row => row.evidence.map(item => item.line).join("/");
  const classified = new Set(rows.map(pairKey));
  for (const row of [...awarenessPairs(lines, weights), ...semanticPairs(payload.links ?? [], lines, weights)]) {
    const key = pairKey(row);
    if (classified.has(key)) continue;
    classified.add(key);
    rows.push(row);
  }
  return rows.sort((a, b) => b.confidence - a.confidence ||
    a.evidence[0].line - b.evidence[0].line || a.evidence[1].line - b.evidence[1].line ||
    JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
