# Acceptance evidence

Last updated: 2026-08-18 (Europe/Istanbul)

This document separates observed runtime evidence from source-level contracts.
A green static audit is not treated as proof of a desktop or mobile interaction.

## Verified in the current workspace

- `npm run verify` passes:
  - 22 YouTube/media pure-behaviour checks;
  - 36 core/import/Study/migration/lookup/reader-flow pure-behaviour checks;
  - TypeScript and production bundle build;
  - 8 clean-Vault installation checks;
  - 18 structural product-contract checks.
- The installed production artifacts and source artifacts have identical
  SHA-256 values. Only `main.js`, `manifest.json`, and `styles.css` are copied;
  the installed `data.json` is not replaced.
- The real Codex adapter resolves
  `/Users/bahadirumutiscimen/.local/bin/codex` (`codex-cli 0.147.0`), returns
  aligned JSON translations and token usage, and serves the second run from
  the translation cache.
- The actual Portal EPUB job for *Future Energy* completed in Obsidian after
  resuming from the earlier Codex `ENOENT` failure. Its persisted result has
  207 unique paragraph IDs, 207 non-empty English sources, 207 non-empty
  Turkish translations, and zero malformed pairs across 15 content spines.
- The imported EPUB and the source EPUB have the same SHA-256:
  `a5bbe4d9dc4158602a6250bab8685b95426e601e579447eb48c88bb2bd806a3a`.
- `npm run smoke:youtube` passes against the plan URL using the production
  yt-dlp/Codex code path: 102 timed caption segments, 29 story paragraphs,
  four AI topic boundaries in the bounded sample, and 2/2 aligned Turkish
  sample translations.
- `npm run smoke:youtube -- --frame-only` selects the timestamp-nearest public
  YouTube storyboard cell and produces a valid 17,891-byte JPEG at 02:05.
  This avoids direct video downloads that can require a YouTube PO token.
- Local transcription is installed and verified:
  - yt-dlp `2026.07.04`;
  - ffmpeg `8.1.2`;
  - whisper.cpp `1.9.2`;
  - official `base.en` model, 147,964,211 bytes, upstream SHA-1
    `137c40403d78fd54d454da0f9bd998f78703390c`.
- `npm run smoke:whisper` passes through the production no-caption fallback:
  yt-dlp embedded-client audio retry, temporary WAV conversion, automatic
  Metal/GPU-to-CPU retry, whisper.cpp JSON parsing, and 10 valid timed English
  segments from the 30-second acceptance sample. Temporary job files are
  removed in `finally`.
- The user-approved read-only legacy migration dry-run completed with report
  fingerprint `1jljvkj`: all six source-plugin data files were readable, zero
  transferable Vocabulary records and zero annotations were found, and no
  warnings were reported. No data was written or applied.

## Still requires external/user evidence

- Visual Obsidian onboarding/settings, reader, Hover/Gloss/TTS, Study, iframe
  seek, and active-paragraph interaction. Orca computer-use currently returns
  `runtime_unavailable`, so these have not been misreported as automated UI
  passes.
- Continuous vertical EPUB scrolling still needs a visual desktop/mobile pass
  for long-book memory, position restore, ToC/search jumps and highlights.
- iPhone/iPad reading and performance on a real device.
- The confirmed product decisions are encoded in `ARCHITECTURE.md`; deferred
  features are explicitly listed as later scope.
- Source plugins may be disabled only after explicit approval. Their folders
  may be removed only after a further, separate explicit approval.

## Reproducible commands

```sh
npm run verify
npm run smoke:codex
npm run smoke:agents
npm run smoke:youtube
npm run smoke:youtube -- --frame-only
npm run smoke:whisper
```
