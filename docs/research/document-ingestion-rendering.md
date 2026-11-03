# Candidate document ingestion and resume rendering for ATS parsing

- Issue: [#6](https://github.com/dlopezkluever/Jobaculator/issues/6) (Phase 0 map: [#1](https://github.com/dlopezkluever/Jobaculator/issues/1))
- Researched: 2026-11-03. Every claim cites a source in [Sources](#sources). Where evidence is secondary, anecdotal, or unretrieved, the text says so.
- Status: recommendation only. Final decisions are made later with the user.

## Short answer

- **Ingestion (a):** Use a hybrid. Keep the original file bytes. Extract text deterministically in Node (`pdfjs-dist` for PDF text layers, `mammoth` for DOCX). Send PDFs natively to Claude (Haiku 5.5 or Sonnet 5.5) for structuring into CandidateFacts, because Claude sees both each page's text and its image. Use the deterministic text to check the model's output against the source. Cost is a fraction of a cent per resume on Haiku 5.5 and about 8 cents on Opus 5.5 (estimates below). Native PDF input has no published resume-accuracy benchmark, so measure it on a fixture set before committing.
- **Rendering (b):** Recommend **Typst** as the resume PDF renderer. It writes tagged PDF by default, has a PDF/UA-1 mode, is a 17.5 MB binary with no browser needed, and is Apache-2.0. Keep **HTML→PDF via Chromium** as the fallback. Chromium is already needed by the Phase 0 browser runtime, so its marginal infra cost is low, but its memory cost on a 4 GB VPS is unmeasured. Reject LaTeX for Phase 0. Treat DOCX generation as an optional later export, not the primary output.
- **ATS rules that hold regardless of renderer:** single column, no tables or text boxes for layout, contact details in the body (not header/footer), no graphics, real selectable text (no flattened or image-only PDFs), and under 2.5 MB. The only primary ATS parse-limit source found (Greenhouse) states all of these.

## Constraints applied

From the map Notes (#1) and the PRD:

- Fixed infra ≤ $20/month on one ~4 GB VPS, single user, AI agents write all code, TypeScript lean, BYO Anthropic and OpenAI keys ([#1 Notes](https://github.com/dlopezkluever/Jobaculator/issues/1); [PRD §64–§68](../../init-prd.md)).
- PRD §33: resumes "should remain visually professional and machine-readable." §34: per-application bespoke generated versions from base families. FR-018: role-specific resume. FR-025: "retain the exact artifacts submitted" (so the rendered bytes must be stored, not re-rendered). FR-001/FR-002: accept multiple candidate documents and extract structured information. §7.2 lists resumes, CVs, transcripts, LinkedIn exports, and miscellaneous files as sources, and says "simple file upload plus conversational ingestion is sufficient." §9 asks for provenance on claims where cheap.
- PRD §68–§71: a Browser Runtime is part of the alpha topology, and browser sessions are capped (`MAX_BROWSER_SESSIONS=2`). Any Chromium-based rendering competes with that cap.

---

## (a) Ingestion

### Options

| Option | What it gives | Accepts | Cost | Notes |
|---|---|---|---|---|
| Node extraction, PDF: `pdfjs-dist` (Apache-2.0) | Text items with positions from the PDF text layer | PDF with text layer | No per-use cost; CPU only | Scanned PDFs yield no text. Text order from raw runs is an approximation. |
| Node extraction, PDF: `unpdf` (MIT) | Wrapper around PDF.js for serverless/Node | PDF | No per-use cost | Thin wrapper; same limits as PDF.js. |
| Node extraction, DOCX: `mammoth` (BSD-2-Clause) | HTML or raw text from DOCX | DOCX (not .doc) | No per-use cost | Drops underlining and comments by default; tables kept but borders ignored. |
| Native PDF to Claude | Per page: extracted text plus a page image, both sent to the model | PDF, no passwords/encryption | Tokens (see below) | Sees layout and visual content (charts, icons). |
| Native file to OpenAI Responses API | PDF with text+images on vision models; DOCX text only | PDF (50 MB), DOCX | Tokens | DOCX loses embedded images and charts. Chat Completions accepts only PDF. |

### Facts

- **Claude PDF input.** Each page is converted to an image and its text is extracted; "Claude analyzes both the text and images." Limits: request size 128 MB on the first-party API; 600 pages per request (100 when the context window is under 1M tokens); standard PDF with no passwords or encryption. Both limits apply to the whole request payload. [S1]
- **Claude and DOCX.** "Binary formats such as .xlsx or .docx are not supported in document blocks, so convert them to text or PDF first." [S1]
- **Claude token cost.** "Each page typically uses 1,500–3,000 tokens depending on content density," plus image tokens. Image tokens are `⌈width/28⌉ × ⌈height/28⌉` per image; standard models resize to a 1,568 px maximum edge, and high-resolution mode on Claude 4.7+ goes higher. By our arithmetic, a letter page scaled to the standard 1,568 px edge is roughly 2,500 image tokens. [S1][S4]
- **OpenAI PDF input.** Each file must be under 50 MB, and a single request's combined files are capped at 50 MB. The page does not state a page limit or a per-page token figure; it says parsing "can increase token usage." [S2]
- **OpenAI DOCX.** "Yes, in the Responses API, which accepts `.docx` as an `input_file`. For non-PDF documents, the API extracts text only and doesn't extract embedded images or charts. Chat Completions accepts only PDF files." [S2]
- **Mammoth.** Converts DOCX to HTML (`convertToHtml`) or plain text (`extractRawText`), with warnings returned in `messages`. Markdown output is deprecated. Images are inline by default. Underlining is ignored by default and comments are ignored. "the conversion is unlikely to be perfect for more complicated documents." [S6]
- **PDF.js.** `getTextContent()` returns text items with `str` and position fields. The official API pages were not retrievable in this session. The only field-level detail came from secondary sources, so confirm the `TextItem` typings and the text-order behaviour during a spike. [S8] [unverified: official API page]
- **Scanned PDFs.** Claude and OpenAI both send page images, so a scanned resume is still readable by vision models. The PDF.js and Mammoth sources do not address scanned input, so the design must detect "no text layer" and route to the vision path. [S1][S2]

### Accuracy on resumes

No primary benchmark measures LLM resume extraction, native PDF versus extracted text. The indirect evidence:

- OmniDocBench (CVPR 2025, arXiv 2412.07626) is a general PDF-parsing benchmark across 9 document types, scoring end-to-end, task-level and attribute-level. It is peer-reviewed but not about resumes. [S19]
- A community repo, PDF-Bench (November 2025, README table, not peer-reviewed), reports GPT-5.1 at 92% edit similarity, Gemini 3 Pro at 87%, Claude Sonnet 4.5 at 80%, Azure Document Intelligence at 88%, and pypdfium2 at 78%. Its sample and metric are small and self-defined. [S20]
- arXiv 2510.09722 (October 2025) proposes automated field-level evaluation for list-style fields such as work experience. The abstract was retrieved, but its accuracy numbers were not. [S21]

Conclusion: the accuracy question for resumes is open. A fixture set of 20–30 real resumes, scored on field-level accuracy, is the cheapest way to answer it. This should be a Tracer Bullet 1 spike, not a research question.

### Cost estimate (for planning, not measured)

Assumptions: 2-page resume, about 2,250 text tokens and 2,500 image tokens per page, so roughly 9,500 input tokens. Structured JSON output about 2,000 tokens.

| Model (per MTok, input / output) | Per resume, approx. | Source |
|---|---|---|
| Claude Haiku 5.5 ($0.10 / $0.50, prompts ≤100k) | ~$0.002 | [S3] |
| Claude Sonnet 5.5 ($2 / $10) | ~$0.04 | [S3] |
| Claude Opus 5.5 ($4 / $20) | ~$0.08 | [S3] |
| OpenAI gpt-5.4-mini ($0.75 / $4.50) | ~$0.02 | [S5] |
| OpenAI gpt-5-nano ($0.05 / $0.40) | ~$0.001 | [S5] |

Batch processing is 50% off on Claude ([S3]) and on OpenAI batch tiers ([S5]). Cost is not a decision driver at this volume. The decision driver is accuracy, which is unmeasured.

### Recommendation (a)

1. **Store the original bytes** with a SHA-256 hash and the upload metadata. Every extracted fact should point back to the source file (PRD §9 provenance).
2. **Route by file type and text layer:**
   - PDF with a text layer: send natively to Claude for structuring. Also run PDF.js to get raw text, and use it to check that every email, phone, date, and employer name in the output appears in the raw text (a grounding check).
   - PDF without a text layer: send natively to Claude. No text-layer check is possible, so flag these for user review.
   - DOCX: Mammoth to text, then text-only LLM structuring. (Or send DOCX to OpenAI, which accepts it as text-only input, if OpenAI is the chosen model.)
3. **Structure into a versioned CandidateFact schema** with a JSON-schema-validated output, so the model's output is checked by code, not trusted.
4. **Evaluate before committing:** build the 20–30 resume fixture set and measure native-PDF against text-only extraction on the same fixtures.

Interface this exposes to neighbours: `ingestDocument(file) → { sourceId, sha256, mime, rawText?, hasTextLayer, structuredFacts }`, with a `hasTextLayer` flag the Knowledge Base can use to decide whether to ask for review.

---

## (b) Rendering

### Options

| Option | Output | Tagged PDF | Footprint | Template flexibility | Notes |
|---|---|---|---|---|---|
| **Typst** (CLI or Node binding) | PDF, optional PDF/UA-1 | Yes, default | ~17.5 MB compressed Linux binary | Typst markup; deterministic; data-driven via JSON or Typst code | Pre-1.0 (current v0.15.1 [S11]). Node bindings vary in maturity. |
| HTML→PDF via Chromium (`page.pdf`) | PDF | Experimental, default true in Puppeteer | Headless shell 126.9 MB zip; full Chrome 201.3 MB zip | HTML/CSS; very flexible; agents write HTML well (judgment) | Shares the Browser Runtime already in the Phase 0 topology. Text layer not verified by a primary source. |
| LaTeX | PDF | Yes, via `\DocumentMetadata{tagging=on}`, pdfLaTeX or LuaLaTeX only [S14] | Multi-GB TeX Live install (not retrieved) | Strong typesetting; heavy template work | Tagging still being adapted across packages [S14]. |
| DOCX generation (`docx`, MIT) | DOCX | Not applicable | Pure JS library | Tables, headers, footers supported [S7] | Not a PDF. Rendering DOCX to PDF needs an office engine (not researched). |

### ATS evidence

Primary ATS and parser sources found:

- **Greenhouse (official help article "Unsuccessful resume parse").** "Greenhouse Recruiting can't parse resumes larger than 2.5MB." Failure modes it names: image uploads rather than documents; "graphics, photos, or word art"; "spaces between the letters"; "Complex resumes with tables, headers, and footers"; "Resumes with the name and contact information in the header, footer, or text box"; "a columned layout"; and "Resumes without clear sections and differing formats throughout each section." On failure, the resume is attached and the candidate fields must be entered by hand. [S15]
- **Workable (official help).** Acceptable types are ".doc", ".docx", ".pdf", ".rtf", and ".odt". No size limit is stated. It says "image-based CVs and CVs in any language" are parsed for name, contact, social links, and profile picture. [S16]
- **Textkernel (parser vendor, developer docs).** It "Accepts input documents in every commercial resume document format," including Microsoft Word (DOCX) and PDF. For scanned PDFs, OCR is an optional add-on, and "images take considerably longer to parse." The FAQ says it handles single- and multi-column resumes. Its docs do not address tables or text-layer behaviour. [S17]
- **Lever (official help, retrieved only as a search snippet).** The snippet states Lever parses Word (including .docx), PDF, RTF, WordPerfect, HTML, MS Office HTML, and ODF, and that JPG and PNG cannot be parsed. The page itself could not be fetched. [S18] [unverified: page not retrieved]
- **Workday.** No official resume-format article was retrieved. Third-party guides say scanned PDFs often fail, and a 5 MB limit appears on one employer's page. Treat as unverified. [unverified: third-party search results only, no primary URL retrieved]

Conflict to note: Greenhouse (official) says columned layouts cause parse failures, and Textkernel (vendor) says it handles multi-column. The conservative choice for ATS parsing across vendors is a single column.

Across Greenhouse and Workable, both PDF and DOCX are accepted. No primary source found says one format is parsed better, so PDF versus DOCX is a judgment call. Third-party guides favour a text-based PDF, but these are secondary.

### Template implications

Concrete rules, each traceable to a source above:

- Single column, no layout tables, no text boxes, no sidebars. [S15]
- Name and contact details in the body, not in a header or footer. [S15]
- No photos, icons, graphics, or word art. [S15]
- Real selectable text. No letter-spaced headings. No flattened or image-only PDFs. [S15][S17]
- Standard section headings in a consistent order. [S15]
- Under 2.5 MB. Embed fonts (subset). [S15]

Per-application variation fits a data-driven design: the LLM outputs a validated ResumeDocument (sections, bullets, emphasis, order), and a fixed template family renders it. Variation then lives in data, not layout code. Base families (PRD §34) are template variants that share the same ResumeDocument schema.

### Footprint on a small VPS

- Typst CLI: the v0.15.1 Linux musl tarball is 17,462,992 bytes (17.5 MB). Apache-2.0. Rendering footprint not measured. [S11][S9]
- Chromium: the headless shell zip for Chrome 156.0.8078.80 is 126,922,702 bytes (126.9 MB). The full Chrome zip is 201,329,937 bytes (201.3 MB). Memory per render is not measured. [S13]
- Puppeteer exposes `tagged` (experimental, default true) and `preferCSSPageSize`. [S12]
- LaTeX: install size not retrieved (TeX Live pages returned errors). [unverified]
- Node libraries: `docx` 9.15.1 (MIT), `mammoth` 1.13.0 (BSD-2-Clause), `pdfjs-dist` 6.5.438 (Apache-2.0), `unpdf` 2.1.0 (MIT), `puppeteer-core` 25.16.0 (Apache-2.0). Versions and licenses from the npm registry, queried 2026-11-03. [S22]
- The npm package named `typst` (0.10.0-8, published 2023) is stale. Do not use it. `@myriaddreamin/typst-ts-node-compiler` 0.7.0 (Apache-2.0, updated 2026-06-29) is the current Node binding candidate, but its maturity is unverified. [S22]

### Recommendation (b)

1. **Primary renderer: Typst.** Reasons: tagged PDF by default, a PDF/UA-1 mode with alt-text checks, no browser dependency, a small deterministic binary, and Apache-2.0. Invoke the CLI as a subprocess behind a `Renderer` interface, rather than depending on an unmaintained Node binding.
2. **Fallback: HTML→PDF via Chromium**, reusing the Browser Runtime, if a Tracer Bullet 1 spike shows Typst templates are too hard for agents to produce reliably.
3. **Reject LaTeX for Phase 0.** Tagging is still being rolled out across packages, the install is heavy (size unverified), and template authoring is slower for agents.
4. **DOCX export: defer.** Not needed for Phase 0. If added, use `docx` (MIT) with single-column, no-table output.
5. **Verify the output:** after rendering, extract text with PDF.js and check it against the ResumeDocument (contact fields present, section headings in order, all bullets present). This catches broken text order before submission.

Interface this exposes: `renderResume(doc: ResumeDocument, template: TemplateId) → { bytes, mime: "application/pdf", sha256, extractedText }`. The `bytes` and `sha256` are stored as the submitted artifact (FR-025). `verifyResumeText(extractedText, doc) → issues[]` is a separate step so verification does not depend on the renderer.

---

## Open risks

1. **Chromium and Typst text-layer quality is unverified by primary sources.** A Chromium forum thread reports print-to-PDF lacking searchable text, but it is old and anecdotal. [S23] A Tracer Bullet 1 spike should render a fixture resume with each candidate and check extracted text order.
2. **No primary evidence on LLM resume-extraction accuracy.** Native PDF versus text-only is unmeasured. The fixture-set spike decides this. [S19][S20]
3. **Vendor parser behaviour is mostly unverified** beyond Greenhouse, Workable, and Textkernel. Lever is known only from a search snippet. Workday is unverified. An ATS adapter that ships with a parser-specific template will need its own check.
4. **Typst is pre-1.0** (v0.15.1). Pin the version. Its Node binding (`@myriaddreamin/typst-ts-node-compiler`) is a secondary dependency whose stability is unverified.
5. **Chromium memory on a 4 GB VPS is unmeasured.** Rendering competes with `MAX_BROWSER_SESSIONS=2` (PRD §71). Measure before choosing it as the fallback.
6. **Claude request limits (128 MB, 600 pages) and pricing change over time.** The figures here are from the docs as retrieved on 2026-11-03. Re-check at build time. Sonnet 5 introductory pricing was superseded by the standard price, per footnote. [S1][S3]
7. **Visual token cost can exceed the standard estimate** on high-resolution mode for Claude 4.7+, up to 4,784 tokens per image. [S4]
8. **Mammoth drops underlining and comments** by default. If the candidate's DOCX relies on either, text fidelity suffers. [S6]
9. **PDF.js text-order behaviour is unverified** against official docs. Multi-column input may produce interleaved text. [S8] [unverified: official API page]

## Facts downstream decisions depend on

- Claude accepts PDF natively (text plus page images) on Haiku 5.5, Sonnet 5.5, and Opus 5.5. It does not accept DOCX in document blocks. [S1]
- OpenAI accepts DOCX as text-only via the Responses API, and PDF up to 50 MB. [S2]
- Per-resume LLM cost for ingestion is around $0.002 (Haiku 5.5) to $0.08 (Opus 5.5) for a 2-page resume, before batch discounts. [S3][S5]
- Typst 0.15.1 writes tagged PDF by default and offers PDF/UA-1 via `--pdf-standard ua-1`. [S9]
- Puppeteer's `tagged` PDF option is experimental and defaults to true. [S12]
- Greenhouse (official) rejects resumes over 2.5 MB and fails on columns, tables, headers/footers, text boxes, graphics, and letter-spaced text. [S15]
- Textkernel (vendor) needs an OCR add-on for scanned PDFs. [S17]
- Stored submitted artifacts must be the exact rendered bytes (FR-025). [PRD]

## Sources

Retrieved 2026-11-03 unless noted.

- [S1] Anthropic PDF support: https://platform.claude.com/docs/en/build-with-claude/pdf-support (the `anthropic.com/en/docs` URL redirects here; the page links the Files docs for the DOCX note)
- [S2] OpenAI PDF file inputs: https://developers.openai.com/api/docs/guides/pdf-files (the `platform.openai.com` URL redirects here)
- [S3] Anthropic pricing: https://platform.claude.com/docs/en/about-claude/pricing
- [S4] Anthropic vision (image token formula and resizing): https://platform.claude.com/docs/en/build-with-claude/vision
- [S5] OpenAI pricing: https://developers.openai.com/api/docs/pricing
- [S6] Mammoth.js README: https://github.com/mwilliamson/mammoth.js
- [S7] docx README: https://github.com/dolanmiu/docx
- [S8] PDF.js FAQ: https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions (used only for the "no text-order statement" finding; field-level API detail is unverified)
- [S9] Typst PDF reference: https://typst.app/docs/reference/pdf/
- [S10] Typst accessible PDF (secondary to S9 for the same claims): https://typst.app/blog/2025/accessible-pdf
- [S11] Typst v0.15.1 release assets (GitHub API, published 2026-07-17): https://github.com/typst/typst/releases
- [S12] Puppeteer PDF options: https://pptr.dev/api/puppeteer.pdfoptions
- [S13] Chrome for Testing version manifest and downloads (sizes via HTTP Content-Length): https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json
- [S14] LaTeX tagging, search snippet only: https://tug.org/mactex/taggingproject.html and https://latex-project.org/news/2025/06/02/issue41-of-latex2e-released (the TUG page returned 403)
- [S15] Greenhouse, "Unsuccessful resume parse": https://support.greenhouse.io/hc/en-us/articles/200989175-Unsuccessful-resume-parse
- [S16] Workable, accepted CV file types: https://help.workable.com/hc/en-us/articles/115012661408
- [S17] Textkernel TK Platform file formats: https://developers.textkernel.com/TKPlatform/master/file-formats/ and Tx Platform v9 resume parser specs: https://developer.textkernel.com/tx-platform/v9/resume-parser/overview/specs/
- [S18] Lever, "Understanding Resume Parsing", search snippet only: https://help.lever.co/hc/en-us/articles/20087345054749 (page returned a loading error)
- [S19] OmniDocBench, CVPR 2025, arXiv 2412.07626: https://arxiv.org/html/2412.07626v2
- [S20] PDF-Bench community README (not peer-reviewed): https://github.com/applied-artificial-intelligence/pdf-parser-benchmark
- [S21] arXiv 2510.09722, abstract only: https://arxiv.org/abs/2510.09722
- [S22] npm registry (`npm view`), queried 2026-11-03, for versions, licenses, and modification dates of `docx`, `mammoth`, `pdfjs-dist`, `unpdf`, `puppeteer-core`, `typst`, `@myriaddreamin/typst-ts-node-compiler`, `@react-pdf/renderer`, and `pdf-parse`.
- [S23] Chromium print-to-PDF text selection, Vivaldi forum (old and anecdotal): https://forum.vivaldi.net/topic/32803/print-to-pdf-should-output-as-selectable-text/11

## What was not verified

- Official pdf.js API field definitions (`TextItem`, text-order behaviour). Only secondary sources were available.
- Lever's official parse-format list (search snippet only).
- Workday's accepted formats and limits (no primary source).
- Chromium `page.pdf` text-layer correctness and memory per render.
- LaTeX install size.
- Resume-specific LLM extraction accuracy (no primary benchmark).
- Typst render time and memory on the target VPS.
