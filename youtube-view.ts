import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon, type ViewStateResult } from "obsidian";
import type ComprehensibleLearningPortal from "./main";
import type { QuickLookupRequest } from "./quick-lookup";
import type { StudySource } from "./study";
import { speakEnglishText } from "./speech";

export const YOUTUBE_STORY_VIEW_TYPE = "clp-youtube-story";

interface YoutubeStoryParagraph {
	id: string;
	start: number;
	source: string;
	translation: string;
}

interface YoutubeStoryDocument {
	videoId: string;
	title: string;
	paragraphs: YoutubeStoryParagraph[];
}

export class YoutubeStoryView extends ItemView {
	private filePath = "";
	private file: TFile | null = null;
	private story: YoutubeStoryDocument | null = null;
	private iframe: HTMLIFrameElement | null = null;
	private paragraphEls: HTMLElement[] = [];
	private activeIndex = -1;
	private translationsVisible = true;
	private playerReady = false;
	private currentTime = 0;

	constructor(leaf: WorkspaceLeaf, private plugin: ComprehensibleLearningPortal) {
		super(leaf);
	}

	getViewType(): string { return YOUTUBE_STORY_VIEW_TYPE; }
	getDisplayText(): string { return this.story?.title || this.file?.basename || "YouTube Story"; }
	getIcon(): string { return "youtube"; }

	getState(): Record<string, unknown> { return { file: this.filePath }; }

	async setState(state: Record<string, unknown>, result: ViewStateResult): Promise<void> {
		await super.setState(state, result);
		this.filePath = typeof state.file === "string" ? state.file : "";
		await this.loadStory();
	}

	async onOpen(): Promise<void> {
		this.registerDomEvent(window, "message", (event: MessageEvent) => this.onPlayerMessage(event));
		if (this.filePath) await this.loadStory();
	}

	async onClose(): Promise<void> {
		window.speechSynthesis.cancel();
		await super.onClose();
	}

	private async loadStory(): Promise<void> {
		const file = this.app.vault.getFileByPath(this.filePath);
		if (!file) {
			this.contentEl.empty();
			this.contentEl.createEl("div", { cls: "clp-youtube-view-empty", text: "YouTube hikâye notu bulunamadı." });
			return;
		}
		this.file = file;
		try {
			this.story = parseYoutubeStoryMarkdown(await this.app.vault.cachedRead(file));
			this.render();
		} catch (error) {
			this.contentEl.empty();
			this.contentEl.createEl("div", {
				cls: "clp-youtube-view-empty",
				text: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private render(): void {
		const story = this.story;
		if (!story) return;
		this.contentEl.empty();
		this.contentEl.addClass("clp-youtube-view");
		const header = this.contentEl.createEl("header", { cls: "clp-youtube-view-header" });
		const heading = header.createEl("div");
		heading.createEl("h2", { text: story.title });
		heading.createEl("p", { text: "Paragrafa dokunarak videoyu o ana getir; oynatılırken etkin paragraf otomatik izlenir." });
		const controls = header.createEl("div", { cls: "clp-youtube-view-controls" });
		const toggle = controls.createEl("button");
		setIcon(toggle, "languages");
		const toggleLabel = toggle.createSpan({ text: "Türkçeyi gizle" });
		toggle.addEventListener("click", () => {
			this.translationsVisible = !this.translationsVisible;
			this.contentEl.toggleClass("clp-youtube-hide-translation", !this.translationsVisible);
			toggleLabel.setText(this.translationsVisible ? "Türkçeyi gizle" : "Türkçeyi göster");
		});
		const note = controls.createEl("button");
		setIcon(note, "file-text");
		note.createSpan({ text: "Markdown notu" });
		note.addEventListener("click", () => {
			if (this.file) void this.app.workspace.getLeaf("tab").openFile(this.file);
		});
		if (this.plugin.settings.youtube.screenshotMode === "manual") {
			const capture = controls.createEl("button");
			setIcon(capture, "camera");
			capture.createSpan({ text: "Kare yakala" });
			capture.addEventListener("click", () => void (async () => {
				capture.disabled = true;
				try {
					const path = await this.plugin.saveYoutubeScreenshot(story.videoId, story.title, this.currentTime);
					new Notice(`Video karesi kaydedildi: ${path}`);
				} catch (error) {
					new Notice(`Video karesi kaydedilemedi: ${error instanceof Error ? error.message : String(error)}`);
				} finally {
					capture.disabled = false;
				}
			})());
		}

		const layout = this.contentEl.createEl("div", { cls: "clp-youtube-view-layout" });
		const playerWrap = layout.createEl("div", { cls: "clp-youtube-player-wrap" });
		const iframe = playerWrap.createEl("iframe", {
			cls: "clp-youtube-player",
			attr: {
				title: `${story.title} YouTube player`,
				src: `https://www.youtube-nocookie.com/embed/${story.videoId}?enablejsapi=1&playsinline=1&rel=0`,
				allow: "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share",
				allowfullscreen: "true",
			},
		});
		this.iframe = iframe;
		iframe.addEventListener("load", () => {
			this.postPlayer({ event: "listening", id: "clp-youtube-player" });
			this.postPlayer({ event: "command", func: "addEventListener", args: ["onReady"] });
			this.postPlayer({ event: "command", func: "addEventListener", args: ["onStateChange"] });
		});

		const transcript = layout.createEl("div", { cls: "clp-youtube-transcript", attr: { "aria-label": "Çift dilli video metni" } });
		this.paragraphEls = [];
		for (const [index, paragraph] of story.paragraphs.entries()) {
			const card = transcript.createEl("article", { cls: "clp-youtube-transcript-pair" });
			card.dataset.paragraphId = paragraph.id;
			card.dataset.start = String(paragraph.start);
			const row = card.createEl("div", { cls: "clp-youtube-transcript-row" });
			const timestamp = row.createEl("button", { cls: "clp-youtube-timestamp", text: formatTimestamp(paragraph.start) });
			timestamp.addEventListener("click", () => this.seekTo(index));
			const study = row.createEl("div", { cls: "clp-youtube-study-actions" });
			const lookup = study.createEl("button", { attr: { "aria-label": "Seçimi bağlamsal olarak açıkla" } });
			setIcon(lookup, "sparkles");
			const speak = study.createEl("button", { attr: { "aria-label": "İngilizce metni seslendir" } });
			setIcon(speak, "volume-2");
			const vocabulary = study.createEl("button", { attr: { "aria-label": "Seçili kelimeyi Vocabulary'ye kaydet" } });
			setIcon(vocabulary, "book-plus");
			const grammar = study.createEl("button", { attr: { "aria-label": "Grammar'a kaydet" } });
			setIcon(grammar, "braces");
			const shadowing = study.createEl("button", { attr: { "aria-label": "Shadowing'e kaydet" } });
			setIcon(shadowing, "audio-lines");
			const source = card.createEl("div", { cls: "clp-youtube-transcript-source", text: paragraph.source });
			source.lang = "en";
			const translation = card.createEl("div", { cls: "clp-youtube-transcript-translation", text: paragraph.translation });
			translation.lang = "tr";
			const lookupResult = card.createEl("div", { cls: "clp-youtube-lookup-result" });
			lookupResult.hidden = true;
			lookup.addEventListener("click", () => void this.openLookup(paragraph, source, lookupResult, lookup));
			speak.addEventListener("click", () => this.speakEnglish(this.selectedText(source) || paragraph.source));
			vocabulary.addEventListener("click", () => {
				const selected = this.selectedText(source);
				if (!selected) { new Notice("Vocabulary için önce İngilizce paragrafta bir kelime veya ifade seç."); return; }
				void this.plugin.addVocabulary(selected, this.studySource(paragraph));
			});
			grammar.addEventListener("click", () => void this.plugin.addGrammar(this.selectedText(source) || paragraph.source, this.studySource(paragraph)));
			shadowing.addEventListener("click", () => void this.plugin.addShadowing(this.selectedText(source) || paragraph.source, this.studySource(paragraph)));
			card.addEventListener("dblclick", (event) => {
				if ((event.target as Element).closest("button")) return;
				this.seekTo(index);
			});
			this.paragraphEls.push(card);
		}
		this.restorePosition();
	}

	private selectedText(container: HTMLElement): string {
		const selection = window.getSelection();
		if (!selection || selection.isCollapsed || !selection.rangeCount) return "";
		const range = selection.getRangeAt(0);
		if (!container.contains(range.commonAncestorContainer)) return "";
		return selection.toString().replace(/\s+/g, " ").trim();
	}

	private async openLookup(
		paragraph: YoutubeStoryParagraph,
		sourceEl: HTMLElement,
		resultEl: HTMLElement,
		button: HTMLButtonElement,
	): Promise<void> {
		if (!resultEl.hidden) { resultEl.hidden = true; return; }
		const selected = this.selectedText(sourceEl);
		const text = selected || paragraph.source;
		const request: QuickLookupRequest = {
			text,
			context: paragraph.source,
			kind: selected ? lookupKind(selected) : "sentence",
		};
		button.disabled = true;
		resultEl.hidden = false;
		resultEl.setText("Bağlamsal açıklama hazırlanıyor…");
		try {
			const result = await this.plugin.quickLookup(request);
			resultEl.empty();
			const missingMeaning = result.explanationLanguage === "en"
				? "No contextual English definition was produced."
				: "Türkçe karşılık üretilemedi.";
			resultEl.createEl("strong", { text: result.meaning || missingMeaning });
			if (result.lemma || result.ipa || result.partOfSpeech) {
				resultEl.createEl("span", {
					cls: "clp-youtube-lookup-meta",
					text: [result.lemma, result.ipa, result.partOfSpeech].filter(Boolean).join(" · "),
				});
			}
			if (result.explanation) resultEl.createEl("p", { text: result.explanation });
		} catch (error) {
			resultEl.setText(`Açıklama hazırlanamadı: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			button.disabled = false;
		}
	}

	private speakEnglish(text: string): void {
		speakEnglishText(text, this.plugin.settings.quickLookup.voiceLocale, this.plugin.settings.quickLookup.speechRate, this.plugin.settings.quickLookup.voiceName);
	}

	private studySource(paragraph: YoutubeStoryParagraph): StudySource {
		return {
			kind: "youtube",
			path: this.filePath,
			label: this.story?.title ?? this.file?.basename ?? "YouTube",
			context: paragraph.source,
			timestamp: paragraph.start,
		};
	}

	private seekTo(index: number): void {
		const paragraph = this.story?.paragraphs[index];
		if (!paragraph) return;
		this.setActive(index, true);
		this.currentTime = paragraph.start;
		this.postPlayer({ event: "command", func: "seekTo", args: [paragraph.start, true] });
		this.postPlayer({ event: "command", func: "playVideo", args: [] });
		if (!this.playerReady) new Notice("Oynatıcı hazırlanıyor; paragraf seçimi birazdan uygulanacak.");
	}

	private onPlayerMessage(event: MessageEvent): void {
		if (!this.iframe?.contentWindow || event.source !== this.iframe.contentWindow) return;
		if (!/^https:\/\/(?:www\.)?youtube(?:-nocookie)?\.com$/.test(event.origin)) return;
		let payload: unknown = event.data;
		if (typeof payload === "string") {
			try { payload = JSON.parse(payload) as unknown; }
			catch { return; }
		}
		if (!payload || typeof payload !== "object") return;
		const message = payload as { event?: string; info?: { currentTime?: number } };
		if (message.event === "onReady") this.playerReady = true;
		const time = message.info?.currentTime;
		if (typeof time === "number" && Number.isFinite(time)) {
			this.currentTime = time;
			this.syncTime(time);
		}
	}

	private syncTime(time: number): void {
		const paragraphs = this.story?.paragraphs ?? [];
		let index = -1;
		for (let cursor = 0; cursor < paragraphs.length; cursor++) {
			if (paragraphs[cursor].start <= time) index = cursor;
			else break;
		}
		if (index >= 0) this.setActive(index, false);
	}

	private setActive(index: number, scroll: boolean): void {
		if (index === this.activeIndex) return;
		this.paragraphEls[this.activeIndex]?.removeClass("is-active");
		this.activeIndex = index;
		const element = this.paragraphEls[index];
		element?.addClass("is-active");
		if (scroll) element?.scrollIntoView({ behavior: "smooth", block: "center" });
		const total = Math.max(1, this.story?.paragraphs.length ?? 1);
		this.plugin.settings.bookPositions[this.filePath] = {
			...this.plugin.settings.bookPositions[this.filePath],
			pct: Math.min(1, (index + 1) / total),
			lastRead: Date.now(),
		};
		void this.plugin.persistSettings();
		this.plugin.updateLibraryProgress(this.filePath, Math.min(1, (index + 1) / total));
	}

	private restorePosition(): void {
		const pct = this.plugin.settings.bookPositions[this.filePath]?.pct ?? 0;
		if (!pct || !this.paragraphEls.length) return;
		const index = Math.max(0, Math.min(this.paragraphEls.length - 1, Math.round(pct * this.paragraphEls.length) - 1));
		this.setActive(index, false);
	}

	private postPlayer(message: Record<string, unknown>): void {
		this.iframe?.contentWindow?.postMessage(JSON.stringify(message), "*");
	}
}

export function parseYoutubeStoryMarkdown(markdown: string): YoutubeStoryDocument {
	const videoId = frontmatterValue(markdown, "youtube-id");
	const title = frontmatterValue(markdown, "title") || "YouTube Story";
	if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error("YouTube hikâye notunda geçerli video kimliği yok.");
	const paragraphs: YoutubeStoryParagraph[] = [];
	const blockPattern = /<div class="clp-youtube-story-pair"[^>]*data-pair-id="([^"]+)"[^>]*>([\s\S]*?)<\/div>(?=\s*(?:<div class="clp-youtube-story-pair"|$))/g;
	for (const match of markdown.matchAll(blockPattern)) {
		const body = match[2];
		const startMatch = body.match(/youtube\.com\/watch\?v=[^)&\s]+&t=(\d+)s/);
		const sourceMatch = body.match(/<div class="clp-youtube-story-source"[^>]*>([\s\S]*?)<\/div>/);
		const translationMatch = body.match(/<div class="clp-youtube-story-translation"[^>]*>([\s\S]*?)<\/div>/);
		if (!sourceMatch) continue;
		paragraphs.push({
			id: match[1],
			start: Number.parseInt(startMatch?.[1] ?? "0", 10),
			source: htmlText(sourceMatch[1]),
			translation: htmlText(translationMatch?.[1] ?? ""),
		});
	}
	if (!paragraphs.length) throw new Error("YouTube hikâye notunda okunabilir paragraf bulunamadı.");
	return { videoId, title, paragraphs };
}

function frontmatterValue(markdown: string, key: string): string {
	const match = markdown.slice(0, 4000).match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"));
	return (match?.[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
}

function htmlText(value: string): string {
	const document = new DOMParser().parseFromString(`<body>${value}</body>`, "text/html");
	return document.body.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function lookupKind(text: string): QuickLookupRequest["kind"] {
	const words = text.trim().split(/\s+/).filter(Boolean).length;
	if (words <= 1) return "word";
	return words <= 5 && !/[.!?]/.test(text) ? "phrase" : "sentence";
}

function formatTimestamp(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
		: `${minutes}:${String(secs).padStart(2, "0")}`;
}
