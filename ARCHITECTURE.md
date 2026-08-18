# Architecture

## Confirmed product decisions

- This is a completely new Obsidian plugin.
- The product name is **Comprehensible Learning Portal**.
- The plugin id is `comprehensible-learning-portal`.
- The author is **Bahadır Umut İşçimen** and the project URL is
  `https://github.com/bahadirumutiscimen/Comprehensible-Learning-Portal`.
- Third Mind Reader is the reader and annotation foundation.
- Existing source plugins are implementation sources, not runtime dependencies.
- EPUB and YouTube import are one-click user operations.
- YouTube paragraphs use long pauses and topic changes as boundaries.
- Import continues through processing and translation without exposing internal
  commands to the user.
- Settings are managed from Obsidian's plugin settings.
- Codex is the default translation backend and is pinned to `gpt-5.4-mini`;
  other providers remain optional and keep their own configured models.
- OpenCode and pi are optional desktop CLI backends. Portal discovers their
  executables and provider/model catalogs, then runs learning prompts without
  tools, extensions, skills, context files or persistent pi sessions.
- Google Gemini is a first-class API provider with Secret Storage credentials,
  live `models.list` discovery and `generateContent` transport.
- Google Antigravity is a separate Interactions API backend because
  `gemini-3.7-flash` is an Antigravity agent model rather than a standalone
  `generateContent` model. Portal disables its tools/environment and storage.
- Import and AI preparation run on desktop; synchronized prepared content is
  read on mobile.
- EPUB translation is delivered progressively by chapter.
- Study lives in the Portal, with optional Markdown export.
- A YouTube playlist URL imports only the selected video. Missing captions ask
  before local Whisper; screenshots are manual.
- The first release retains native PDF reading/Gloss. Kindle export,
  microphone capture and pronunciation scoring are deferred.
- The visible vault structure must remain compact; development files, templates,
  and translation logs are not user-facing content.

## Module boundaries

```text
src/
  app/             Plugin lifecycle, commands, views, and routing
  reader/          EPUB/PDF rendering, pagination, highlights, and annotations
  library/         Unified books and YouTube library
  import/          Import jobs and progress orchestration
    epub/          EPUB metadata, assets, and bilingual preparation
    youtube/       Captions, transcription, timing, and paragraph segmentation
  translation/     Provider-independent translation and paragraph alignment
  hover/           Word/sentence hit testing and the unified Gloss card
  study/           Vocabulary, grammar, mistakes, shadowing, and progress
  settings/        Settings schema, onboarding, validation, and diagnostics
  storage/         Content index, cache, migration, and export
  ui/              Shared components and design tokens
```

The current reader foundation is intentionally kept operational while code is
moved into these boundaries. Each extraction must preserve a buildable plugin.

## Content pipeline

```text
User input
  -> source validation
  -> metadata extraction
  -> timed/chapter text extraction
  -> semantic paragraph construction
  -> contextual translation
  -> source/translation alignment
  -> library indexing
  -> reader delivery
```

Each stage writes a checkpoint. Failed or cancelled imports resume from the last
completed checkpoint instead of repeating completed AI work.

## Implemented production slice (2026-08-18)

- Import jobs are persisted in plugin data, serialized through one AI lane, and
  expose stop/retry controls. Interrupted jobs resume from their last chapter.
- Codex is a real desktop adapter, not a placeholder: command discovery,
  isolated read-only execution, JSONL usage parsing, strict paragraph alignment,
  timeout and process termination are implemented.
- EPUB spine blocks receive stable paragraph ids and source hashes. Completed
  chapters are cached and become available in the reader without modifying the
  original archive.
- Reader modes cover English, bilingual and Turkish views, with automatic,
  horizontal and vertical pair layouts. EPUB navigation independently offers
  the original horizontal pagination or a continuous vertical flow; both reuse
  the same sanitized spine DOM, paragraph ids, Gloss and saved highlights.
- Captioned single-video YouTube URLs produce timestamped bilingual story notes
  under `Library/YouTube`; caption cleanup and paragraph boundaries use adaptive
  pauses plus conservative AI analysis of adjacent candidate passages. AI
  boundaries are additive, and a local linguistic heuristic remains the safe
  fallback when the configured backend is unavailable. The resulting paragraph model is kept
  in a bounded persistent cache keyed by video and segmentation settings, so a
  cancelled retry resumes without fetching captions or running Whisper again.
- YouTube Library cards open a dedicated player/transcript view. Timestamp
  clicks seek the embedded player, YouTube `infoDelivery` messages drive the
  active paragraph, translations can be hidden, progress is persisted, and
  paragraphs can be sent directly to Grammar or Shadowing. Manual frame capture
  first crops the timestamp-nearest public YouTube storyboard cell and stores it
  below the story's Screenshots folder. A short yt-dlp/ffmpeg media-section
  download is retained only as a fallback; no video is downloaded merely by
  opening the story.
- When direct and yt-dlp caption acquisition both fail, the default `ask`
  policy offers a local Whisper fallback. After explicit consent it downloads
  temporary audio with yt-dlp, converts it to mono 16 kHz WAV using ffmpeg,
  supports Python Whisper or whisper.cpp JSON output, honors cancellation and
  deletes the temporary directory in `finally`.
- Desktop helper discovery includes Homebrew and user-local paths. The local
  Whisper path supports both Python and current whisper.cpp JSON schemas,
  automatically resolves the product-local `base.en` model, retries a failed
  Metal run on CPU, and retries YouTube audio with the embedded public client
  when the default client is rejected by GVS/PO-token enforcement.
- Manual video images use the timestamp-nearest public YouTube storyboard cell
  first. This keeps the operation small and functional without cookies or a PO
  token; the short media-section downloader remains a fallback for videos that
  do not expose storyboards.
- Selection TTS uses the operating system's English speech voice.
- The selection GlossBar and delayed desktop word hover open one shared quick
  lookup card. Settings select either contextual Turkish support or a
  monolingual, learner-friendly English definition; both return lemma, IPA, POS
  and a compact usage explanation. Language is part of the cache identity, so
  switching modes cannot reuse a result from the other language. TTS and
  Vocabulary actions reuse the unified Study store. The card can be pinned,
  dismissed with Escape, and opened for
  the current selection with the `L` shortcut. Trigger, delay, scope, layout,
  auto-speak, stop-on-close and the bounded context-aware cache are user
  settings. Mobile uses selection/tap.
- AI Gloss defaults are product-specific: Turkish explanations, contextual
  English vocabulary/collocations, grammar and syntax analysis, and friendly
  learner corrections. This installation has no user-authored prompt set, so
  migration v3 replaces every earlier general-reader prompt unconditionally.
- YouTube behavior has its own settings section: caption language/type,
  adaptive or custom pauses, topic boundaries, automatic translation, output
  folder, playlist policy, yt-dlp fallback and yt-dlp/ffmpeg diagnostics.
- The unified Study view is registered with Vocabulary, Grammar, Mistakes,
  Shadowing and Progress tabs. Reader selections can be saved to Vocabulary
  with source context, duplicate/Seen counting, IPA/POS/contextual Turkish AI
  enrichment and review state. Grammar selections generate Turkish analysis
  and a syntax tree. Shadowing provides system TTS, typed comparison, a score,
  word differences and automatic Mistakes records.
- Companion annotations expose Vocabulary, Grammar and Shadowing bridge actions.
  Stable source/range ids make repeated clicks idempotent. Completed bilingual
  EPUB pairs can also be exported to deterministic Markdown without modifying
  the source archive or invoking AI again.
- Legacy migration is consent-gated in Settings. No source `data.json` is read
  at plugin load; the user must request a read-only dry-run. The scanner projects
  only durable vocabulary/annotation fields, explicitly excludes credentials,
  prompts, caches and lookup history, then reports per-plugin counts. Applying a
  report requires a second confirmation, uses stable idempotency markers and
  verifies every imported record. It never disables or removes source plugins.

Applying the consent-gated legacy migration and real-device acceptance remain
explicit gates. Playlist expansion, PDF translation, mobile-side AI imports,
Kindle export and pronunciation scoring with a microphone are deferred; typed
shadowing comparison is implemented.

## Runtime dependencies

The finished plugin must not depend on another Obsidian community plugin.
Bundled JavaScript libraries are allowed. Optional local tools and AI providers
are surfaced through diagnostics and never appear as separate workflow buttons.

## Data principles

- Source EPUB files are never modified.
- API credentials use Obsidian secret storage.
- Internal caches and job state are not shown as vault learning notes.
- User-authored annotations remain portable and recoverable.
- Generated Markdown is optional output, not a requirement of the reader.

## Deferred scope

- Optional non-Codex provider fallback order beyond explicitly selected
  providers.
- YouTube playlist expansion.
- Bilingual PDF translation.
- Mobile-side AI imports.
- Kindle export, microphone capture and pronunciation scoring.
