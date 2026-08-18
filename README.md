# Comprehensible Learning Portal

Comprehensible Learning Portal is a new Obsidian learning environment built
around unified bilingual EPUB and YouTube reading, with the foundation's native
PDF reading and Gloss support retained.

The project starts with the proven reader, library, annotation, and AI surfaces
from Third Mind Reader and brings the following workflows into one plugin:

- bilingual EPUB reading;
- story-like YouTube transcripts split by pauses and topic changes;
- contextual paragraph translation;
- hover and selection translation inside the reader;
- vocabulary, grammar, shadowing, and progress tools;
- one-click content import with resumable background jobs;
- a single professional settings area.

Codex is the default translation backend. Its executable is discovered from
the local installation, while Portal fixes the learning model to
`gpt-5.4-mini`; the user's global Codex model setting is not used.

Desktop learning jobs can alternatively use installed OpenCode or pi agents in
tool-free, temporary sessions. Their configured provider/model catalogs are
listed in Settings. Google Gemini is also available directly through the Gemini
API with Secret Storage credentials and live model discovery; current stable
defaults include `gemini-3.6-flash`, with `gemini-3.5-flash` selectable.
Google Antigravity is exposed separately through the Interactions API. It uses
`gemini-3.7-flash` by default (with 3.6/3.5 alternatives) and Portal sends an
empty tool list, no remote environment, and `store: false` for learning jobs.

## Identity

- Plugin name: `Comprehensible Learning Portal`
- Plugin id: `comprehensible-learning-portal`
- Initial version: `0.1.0`
- Author: `Bahadır Umut İşçimen`
- Project URL: `https://github.com/bahadirumutiscimen/Comprehensible-Learning-Portal`

This is a new plugin and uses its own settings, view identifiers, and data
namespace. It does not modify the installed copies of the source plugins.
Content import and AI preparation run on desktop; synchronized prepared content
remains readable on Obsidian mobile.

## Development status

The reader foundation has been imported under the new plugin identity. The
current production slice also includes:

- persistent, cancellable and resumable import jobs;
- Codex CLI translation with executable discovery, timeout/process kill, JSON
  validation, token accounting and paragraph cache;
- EPUB paragraph extraction with stable ids/source hashes and progressive
  chapter checkpoints;
- source, bilingual and target-only EPUB views with vertical/horizontal/auto
  paragraph-pair layouts, plus selectable horizontal pagination or continuous
  vertical scrolling;
- one-click captioned YouTube story import with rolling-caption cleanup,
  adaptive pause boundaries plus conservative AI topic/scene detection,
  timestamped bilingual Markdown and Library
  indexing, plus a dedicated player view with timestamp seek, active-paragraph
  tracking, translation visibility, direct Grammar/Shadowing capture and an
  explicitly triggered yt-dlp/ffmpeg frame-capture button. The latest 50
  segmented stories are cached so retrying after cancellation does not repeat
  caption download or local Whisper transcription;
- system English TTS from the reader selection toolbar;
- a shared Hover/Gloss quick card with selectable Turkish explanation or
  monolingual English-definition mode, IPA/POS, usage explanation, TTS,
  Vocabulary capture and a language-isolated bounded persistent cache;
- settings diagnostics for Codex plus cache and batching controls;
- English-learning-specific Turkish AI Gloss prompts with complete replacement
  of the unused legacy defaults;
- configurable YouTube captions, paragraph boundaries, translation, storage and
  yt-dlp/ffmpeg diagnostics, with consent-gated local Whisper transcription for
  videos that have no usable captions;
- a unified Study center with AI-enriched Vocabulary and Grammar capture,
  source context, duplicate counting, syntax trees, typed TTS shadowing,
  automatic Mistakes records and review progress;
- an explicit legacy migration center: user-triggered read-only dry-run,
  credential/settings exclusion, second-step confirmation, idempotent import,
  annotation provenance markers and post-import equality verification. Source
  plugins are never disabled or deleted by this flow.
- first-run onboarding, Basic/Advanced settings views, privacy/cost disclosures,
  consolidated local diagnostics, secret-free JSON settings backup/restore and
  one-file Study Markdown export;
- reproducible bilingual EPUB Markdown export built from completed cached pairs,
  without changing the original EPUB;
- keyboard-accessible, pinnable lookup cards and stable annotation-to-Study
  bridge actions that prevent duplicate captures from the same passage.

The remaining product decisions and migration/acceptance work are tracked in
[ARCHITECTURE.md](ARCHITECTURE.md). Observed runtime results and the remaining
device/user gates are recorded separately in [ACCEPTANCE.md](ACCEPTANCE.md).

## Build

```sh
npm ci
npm run build
npm run verify
npm run build:mobile
```

`npm run verify` runs lint, the production TypeScript/bundle build and a static
acceptance audit for plugin identity, source-plugin independence, required
modules, bundle markers and the example EPUB's byte hash. It prints the runtime
Obsidian/YouTube/mobile gates separately instead of treating them as statically
verified.

`npm run build:mobile` stages only `main.js`, `manifest.json`, and `styles.css`
under the operating system's temporary directory, outside the visible Vault.
Pass an explicit destination after `--` when a persistent transfer folder is
needed, for example `npm run build:mobile -- /path/to/output`.

## Mobile installation and vault sync

The compiled `main.js`, `manifest.json`, and `styles.css` are kept in this
repository so the plugin can be installed directly from GitHub with BRAT on
iPhone or iPad. In Obsidian mobile, disable Restricted mode, install BRAT, and
add this repository:

`bahadirumutiscimen/Comprehensible-Learning-Portal`

GitHub is the plugin distribution channel, not a vault synchronisation layer.
Imported EPUB/YouTube files, Study notes, reading positions, and plugin state
belong to the vault and must be synchronised separately. A Git-based vault is
possible with an iOS Git client such as Working Copy: keep the vault in a
separate private repository, clone it on desktop and iPhone/iPad, then pull
before reading and commit/push after editing. Exclude `data.json`, API keys,
and volatile workspace files from that vault repository. Git is best suited to
text notes; large EPUB/media files and simultaneous edits can create conflicts.

EPUB/YouTube importing and local Codex, OpenCode, pi, Whisper, yt-dlp, and
ffmpeg still run on desktop. Mobile reads the prepared content; contextual AI
can use a mobile-capable API provider or queue the request for a desktop run.
