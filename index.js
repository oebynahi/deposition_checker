import { createRoot } from "react-dom/client";
import "./style.css";
import React, { useState, useRef } from "react";

import { sampleTranscripts } from "./transcripts.js";

const labels = { DIRECT: "Direct contradiction", INFERENTIAL: "Inferential contradiction", FALSE_POSITIVE: "False positive" };

export default function DepositionChecker() {
  const [transcripts, setTranscripts] = useState(sampleTranscripts);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState("");
  const editors = useRef([]);

  async function analyze(event) {
    event.preventDefault();
    setLoading(true);
    setResults(null);
    setError("");
    try {
      const res = await fetch("/api/analyze", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcripts })
      });
      const data = await res.json();
      if (!res.ok) throw Error(data.error || "Analysis failed. Try again.");
      setResults(data.findings);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }

  function reveal(index, line) {
    const editor = editors.current[index];
    const lines = editor.value.split("\n");
    const start = lines.slice(0, line - 1).reduce((n, text) => n + text.length + 1, 0);
    editor.focus();
    editor.setSelectionRange(start, start + lines[line - 1].length);
  }

  function card(result, i) {
    return <article key={i}><div className="cardTitle"><strong className={'chip ' + result.type}>{labels[result.type]}</strong>
      <span>Contradiction confidence <b>{result.confidence}/100</b></span></div>
      <p>{result.reason}</p>
      <div className="pair">{result.evidence.map(({line, text}, j) => <div key={j}>
        <button className="citation" onClick={() => reveal(j, line)}>Transcript {j + 1} · Line {line}</button>
        <blockquote>{text}</blockquote></div>)}</div>
      <details><summary>How the score was calculated</summary><ul>{result.factors.map(factor => <li key={factor}>{factor}</li>)}</ul></details>
    </article>;
  }

  return <main><header><h1>Deposition review</h1><p>Compare two accounts from the same witness and inspect the testimony behind each finding.</p></header>
    <form onSubmit={analyze}><div className="pair">{transcripts.map((text, i) =>
      <label key={i}>Transcript {i + 1}<textarea ref={el => { editors.current[i] = el; }} value={text} required
        maxLength={50000} readOnly={loading} spellCheck={false} onChange={event => {
          setResults(null); setError("");
          setTranscripts(transcripts.map((old, j) => i === j ? event.target.value : old));
        }}/></label>)}</div>
      <div className="actions"><button disabled={loading || transcripts.some(t => !t.trim())}>{loading ? "Comparing testimony…" : "Compare transcripts"}</button>
      <small>Comparison sends both transcripts to Groq.</small></div></form>
    {error && <p role="alert">{error}</p>}
    <section aria-live="polite">{results && <>
      <h2>Review findings · Groq</h2>
      <p>{results.filter(r => r.type !== "FALSE_POSITIVE").length} potential contradictions · {results.filter(r => r.type === "FALSE_POSITIVE").length} false positives</p>
      {results.length === 0 && <p>No apparent discrepancies found in this comparison.</p>}
      {results.map(card)}
    </>}</section></main>;
}

createRoot(document.getElementById("root")).render(<DepositionChecker />);
