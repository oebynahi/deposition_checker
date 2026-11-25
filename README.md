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

Groq proposes a relationship and cites lines. The app verifies the citations and calculates confidence locally. The rubric starts at 90 for direct, 68 for inferential, and 12 for compatible accounts. Qualified wording subtracts 10 per answer in a potential conflict. A narrow rounding rule scores otherwise matching statements at 4 when one time is approximate, the times are within ten minutes, and the question context matches. These scores are review heuristics.

## Verify

Run `npm test` for scoring, citation, and API checks. The tests simulate Groq and require no key. Live comparisons send both transcripts to Groq. The local server keeps the key server-side and writes no testimony to disk.
