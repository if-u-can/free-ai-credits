# Egg interactions implementation plan

> For agentic workers: execute with superpowers:subagent-driven-development. User explicitly requested direct implementation without another planning approval.

**Goal:** Deliver five matching transparent stickers and usable card interactions backed by Cloudflare and Google Sheets.

**Architecture:** Preserve the current static HTML/JSON layout and existing submission Worker. A browser interaction module stores eaten IDs locally. Same-origin Worker endpoints sign requests to the existing Google Apps Script project, which stores ballots, rate limits and a manual review queue in independent Google Sheets tabs. Votes never enter the content publishing queue, call GitHub, or trigger a website rebuild.

**Tech stack:** Vanilla JavaScript, Cloudflare Worker, Google Apps Script/Sheets, WebP/PNG, Node tests.

**Spec:** The user's request in this chat, including faceless eggs, a clearly green eaten check, Eku's unchanged pose with exactly two hands, and Google Sheets as the vote store without GitHub synchronization.

## Global constraints
- Keep all existing egg facts, status, grade, score and report JSON unchanged.
- Respect EGG_GRADING.md and CONTENT_GUIDE.md; reviews require actual evidence.
- Use Cloudflare, preserve the existing submission API, and fail visibly when storage is not configured.
- Four egg images have no eyes, mouth or expression. Eku uses official default clothing and normal pink eyes.
- PNG source delivery and optimized WebP consumption; repository references plus three official Library images were actually inspected.

## Review focus
- Storage denied/corrupt: eaten-state feedback must remain honest.
- Filtering/rendering during requests: pending votes cannot double-submit or lose confirmed results.
- Concurrent votes: locked Google Sheets writes, persisted per-network limits, and retry/partial-write reconciliation must preserve confirmed ballots.
- Backend absent: show unavailable and unknown counts, never simulated persistence.
- Shared networks share a vote identity; document this deliberate abuse-control limitation.

## Tasks
1. [x] Root: generate/inspect five images, save PNG and WebP, document references/prompts.
2. [x] Frontend worker: compact toolbar, combined eaten filters, dates and single review panel, affected tests.
3. [x] Backend and Apps Script workers: signed Google transport, isolated vote tabs, voting/limits/review generation, API/deployment documentation and persistence tests.
4. [ ] Root/reviewer: integration and mobile/browser checks, static data integrity, full test suite before GitHub delivery, draft PR and external deployment status.

## External activation
Cloudflare authentication was confirmed read-only. Prepare and test the concrete candidate before asking for any remaining authorization to publish the authenticated Google web app and configure shared secrets. Verify the live Cloudflare-to-Google flow before claiming production voting works. Visitor requests use the reachable CF domain and do not directly access Google. Existing content publishing remains separate.

## Verified candidate
- Full affected and adjacent suite: 61 passed, 0 failed, 0 skipped, including the actual browser fixture at 320/375/1280px.
- Wrangler production dry run passed; no new cloud deployment has occurred yet.
- Editorial JSON, grading/content guide and existing Apps Script publisher remain byte-for-byte unchanged from main.
- Independent review's failure-path flush and large baseline-cell findings were fixed and re-reviewed. Cached writes recover under the lock, and 750 bad ballots can resolve without exceeding the Sheets cell limit.
- Three independent empty tabs were created in the existing private Google spreadsheet and their final 7/6/13-column headers read back. This does not enable the Google web app or Cloudflare production voting.
