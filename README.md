# Deposition review

Compare two transcripts from the same witness and inspect the source testimony behind each finding.

## Run

Use Node.js 22.9 or later.

```sh
npm ci
```

Before starting the server, copy `.env.example` to `.env` and set `GROQ_API_KEY` from the [Groq Console](https://console.groq.com/keys). Run `npm start`, open http://127.0.0.1:3000 and select **Compare transcripts** to analyze the prefilled Marcus Webb depositions or your own text. The default model is `openai/gpt-oss-120b`. Use short excerpts within your Groq quota. Label question and answer lines `Q:` and `A:` for clearer citations.

## Review a finding

- **Direct** describes explicitly opposing claims, such as staying home all evening and leaving for groceries.
- **Inferential** requires an assumption. A parking-lot encounter would challenge the stay-at-home claim if the lot was elsewhere.
- **False positive** covers compatible accounts. Driving through an area is consistent with never entering a particular warehouse. These findings appear alongside the other categories and are excluded from the contradiction count.

Groq extracts structured claims with exact answer quotes and line references. It also suggests links between answers about the same proposition, including paraphrased questions. The app scores these findings locally. The app validates the payload, checks quotes against the submitted answers, and checks extracted context against the answer or its question. The input contract is two transcripts from the same witness.

Local rules cover explicit opposition, prior awareness, staying home versus leaving, continuous wakefulness, approximate times, and location scope. The parking-lot encounter can support an inference about leaving home. Its score reflects the uncertainty about location, timing, and what the neighbor saw.

Every displayed relationship receives a heuristic evidence-strength score. Scores of 70–100 are direct contradictions, 35–69 are inferential contradictions, and 0–34 are false positives. The default starting scores in [claims.js](claims.js) are 90 for explicit opposition, 65 for an inference, and 8 for compatible accounts. Applicable deductions cover qualifiers, assumptions, and reliance on a model suggestion. The same validated claims and links produce the same scores. Groq can return different suggestions between runs.

## Verify

Run `npm test` for scoring, citation, and API checks. The tests simulate Groq and require no key. Live comparisons send both transcripts to Groq. The local server keeps the key server-side and writes no testimony to disk.
