import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type ComprehensibleLearningPortal from "./main";
import { speakEnglishText } from "./speech";

export const STUDY_VIEW_TYPE = "clp-study";
export type StudyTab = "vocabulary" | "grammar" | "mistakes" | "shadowing" | "progress";
export type ReviewStatus = "new" | "learning" | "review" | "mastered";

export interface StudySource {
	kind: "epub" | "youtube" | "pdf" | "note";
	path: string;
	label: string;
	context: string;
	timestamp?: number;
	/** Stable companion/highlight identity for idempotent bridge imports. */
	bridgeId?: string;
}

export interface VocabularyRecord {
	id: string;
	term: string;
	lemma: string;
	translation: string;
	ipa?: string;
	partOfSpeech?: string;
	explanation?: string;
	source: StudySource;
	seen: number;
	status: ReviewStatus;
	createdAt: number;
	updatedAt: number;
	/** Idempotency keys for user-approved legacy imports. */
	migrationKeys?: string[];
	bridgeIds?: string[];
}

export interface GrammarRecord {
	id: string;
	title: string;
	content: string;
	grammarPoints: string[];
	syntaxTree: string;
	source: StudySource;
	createdAt: number;
	updatedAt: number;
}

export interface MistakeRecord {
	id: string;
	original: string;
	correction: string;
	category: string;
	explanation: string;
	status: "open" | "learning" | "resolved";
	source: StudySource;
	createdAt: number;
	updatedAt: number;
}

export interface ShadowingAttempt {
	createdAt: number;
	input: string;
	score: number;
	differences: string[];
}

export interface ShadowingRecord {
	id: string;
	text: string;
	source: StudySource;
	attempts: ShadowingAttempt[];
	createdAt: number;
	updatedAt: number;
}

export interface StudyData {
	vocabulary: VocabularyRecord[];
	grammar: GrammarRecord[];
	mistakes: MistakeRecord[];
	shadowing: ShadowingRecord[];
}

export interface StudyPreferences {
	markdownExportPath: string;
}

export const DEFAULT_STUDY_PREFERENCES: StudyPreferences = {
	markdownExportPath: "Library/Study Export.md",
};

export const DEFAULT_STUDY_DATA: StudyData = {
	vocabulary: [],
	grammar: [],
	mistakes: [],
	shadowing: [],
};

const TAB_LABELS: Record<StudyTab, string> = {
	vocabulary: "Vocabulary",
	grammar: "Grammar",
	mistakes: "Mistakes",
	shadowing: "Shadowing",
	progress: "Progress",
};

export class StudyView extends ItemView {
	private activeTab: StudyTab = "vocabulary";

	constructor(leaf: WorkspaceLeaf, private plugin: ComprehensibleLearningPortal) {
		super(leaf);
	}

	getViewType(): string { return STUDY_VIEW_TYPE; }
	getDisplayText(): string { return "Study"; }
	getIcon(): string { return "graduation-cap"; }

	async onOpen(): Promise<void> { this.render(); }
	refresh(): void { this.render(); }

	private render(): void {
		this.contentEl.empty();
		this.contentEl.addClass("clp-study-root");
		const header = this.contentEl.createEl("header", { cls: "clp-study-header" });
		const title = header.createEl("div");
		title.createEl("h2", { text: "Study" });
		title.createEl("p", { text: "Okurken topladığın kelimeler, dil bilgisi, hatalar ve shadowing çalışmaları." });
		const exportButton = header.createEl("button", { cls: "clp-study-export" });
		setIcon(exportButton, "download");
		exportButton.createSpan({ text: "Markdown dışa aktar" });
		exportButton.addEventListener("click", () => void (async () => {
			exportButton.disabled = true;
			try {
				const path = await this.plugin.exportStudyMarkdown();
				new Notice(`Study verisi dışa aktarıldı: ${path}`);
			} catch (error) {
				new Notice(`Study dışa aktarılamadı: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				exportButton.disabled = false;
			}
		})());
		const tabs = this.contentEl.createEl("nav", { cls: "clp-study-tabs", attr: { "aria-label": "Study sections" } });
		for (const tab of Object.keys(TAB_LABELS) as StudyTab[]) {
			const button = tabs.createEl("button", { cls: "clp-study-tab", text: TAB_LABELS[tab] });
			button.toggleClass("is-active", tab === this.activeTab);
			button.addEventListener("click", () => { this.activeTab = tab; this.render(); });
		}
		const body = this.contentEl.createEl("main", { cls: "clp-study-body" });
		if (this.activeTab === "vocabulary") this.renderVocabulary(body);
		else if (this.activeTab === "progress") this.renderProgress(body);
		else if (this.activeTab === "grammar") this.renderGrammar(body);
		else if (this.activeTab === "mistakes") this.renderMistakes(body);
		else this.renderShadowing(body);
	}

	private renderVocabulary(parent: HTMLElement): void {
		const records = [...this.plugin.settings.study.vocabulary].sort((a, b) => b.updatedAt - a.updatedAt);
		if (!records.length) { this.renderEmpty(parent, "Okuyucuda bir kelime veya ifade seçip Vocabulary düğmesine bas."); return; }
		for (const record of records) {
			const card = parent.createEl("article", { cls: "clp-study-card" });
			const head = card.createEl("div", { cls: "clp-study-card-head" });
			head.createEl("strong", { text: record.term });
			if (record.ipa) head.createEl("span", { cls: "clp-study-ipa", text: record.ipa });
			head.createEl("span", { cls: `clp-study-status is-${record.status}`, text: statusLabel(record.status) });
			if (record.translation) card.createEl("div", { cls: "clp-study-translation", text: record.translation });
			if (record.partOfSpeech || record.explanation) {
				card.createEl("p", { text: [record.partOfSpeech, record.explanation].filter(Boolean).join(" · ") });
			}
			if (record.source.context) card.createEl("blockquote", { text: record.source.context });
			const meta = card.createEl("div", { cls: "clp-study-meta" });
			meta.createEl("span", { text: `${record.source.label} · ${record.seen} kez görüldü` });
			const advance = meta.createEl("button", { attr: { "aria-label": "İlerlemeyi güncelle" } });
			setIcon(advance, "check-circle-2");
			advance.addEventListener("click", () => void this.advanceVocabulary(record.id));
			this.addDeleteButton(meta, "vocabulary", record.id, `${record.term} kelimesini sil`);
		}
	}

	private renderGrammar(parent: HTMLElement): void {
		const records = this.plugin.settings.study.grammar;
		if (!records.length) { this.renderEmpty(parent, "Okuyucuda zor bir cümleyi seçip Grammar düğmesine bas."); return; }
		for (const record of records) {
			const card = parent.createEl("article", { cls: "clp-study-card" });
			const head = card.createEl("div", { cls: "clp-study-card-head" });
			head.createEl("strong", { text: record.title });
			this.addDeleteButton(head, "grammar", record.id, "Grammar kaydını sil");
			card.createEl("p", { text: record.content });
			if (record.grammarPoints?.length) {
				const list = card.createEl("ul");
				for (const point of record.grammarPoints) list.createEl("li", { text: point });
			}
			if (record.syntaxTree) card.createEl("pre", { cls: "clp-study-syntax", text: record.syntaxTree });
			card.createEl("div", { cls: "clp-study-meta", text: record.source.label });
		}
	}

	private renderMistakes(parent: HTMLElement): void {
		const records = this.plugin.settings.study.mistakes;
		if (!records.length) { this.renderEmpty(parent, "Shadowing yazma karşılaştırmasında bulunan hatalar burada görünecek."); return; }
		for (const record of records) {
			const card = parent.createEl("article", { cls: "clp-study-card" });
			const head = card.createEl("div", { cls: "clp-study-card-head" });
			this.addDeleteButton(head, "mistakes", record.id, "Hata kaydını sil");
			card.createEl("div", { cls: "clp-study-mistake-original", text: record.original });
			card.createEl("div", { cls: "clp-study-mistake-correction", text: record.correction });
			card.createEl("p", { text: `${record.category}: ${record.explanation}` });
			card.createEl("div", { cls: "clp-study-meta", text: `${record.source.label} · ${record.status}` });
		}
	}

	private renderShadowing(parent: HTMLElement): void {
		const records = this.plugin.settings.study.shadowing;
		if (!records.length) { this.renderEmpty(parent, "Okuyucuda bir cümle veya paragraf seçip Shadowing düğmesine bas."); return; }
		for (const record of records) {
			const card = parent.createEl("article", { cls: "clp-study-card clp-study-shadowing" });
			const actions = card.createEl("div", { cls: "clp-study-card-head" });
			actions.createEl("strong", { text: record.source.label });
			const speak = actions.createEl("button", { text: "Dinle" });
			speak.addEventListener("click", () => speakEnglish(
				record.text,
				this.plugin.settings.quickLookup.voiceLocale,
				this.plugin.settings.quickLookup.speechRate,
				this.plugin.settings.quickLookup.voiceName,
			));
			card.createEl("div", { cls: "clp-study-shadowing-source", text: record.text });
			const input = card.createEl("textarea", { attr: { rows: "3", placeholder: "Dinlediğini İngilizce yaz…" } });
			const footer = card.createEl("div", { cls: "clp-study-meta" });
			const latest = record.attempts?.at(-1);
			const result = footer.createEl("span", { text: latest ? `Son puan: %${latest.score}` : "Henüz deneme yok" });
			const compare = footer.createEl("button", { text: "Karşılaştır" });
			compare.addEventListener("click", () => void (async () => {
				if (!input.value.trim()) return;
				const attempt = await this.plugin.submitShadowing(record.id, input.value);
				if (attempt) result.setText(`Puan: %${attempt.score}${attempt.differences.length ? ` · ${attempt.differences.join(", ")}` : ""}`);
			})());
			this.addDeleteButton(footer, "shadowing", record.id, "Shadowing kaydını sil");
		}
	}

	private addDeleteButton(parent: HTMLElement, kind: "vocabulary" | "grammar" | "mistakes" | "shadowing", id: string, label: string): void {
		const button = parent.createEl("button", { cls: "clp-study-delete", attr: { "aria-label": label, title: label } });
		setIcon(button, "trash-2");
		button.addEventListener("click", () => {
			if (!window.confirm(`${label}? Bu işlem geri alınamaz.`)) return;
			void this.plugin.deleteStudyRecord(kind, id);
		});
	}

	private renderProgress(parent: HTMLElement): void {
		const words = this.plugin.settings.study.vocabulary;
		const stats: [string, number][] = [
			["Toplam kelime/ifade", words.length],
			["Öğreniliyor", words.filter((word) => word.status === "learning" || word.status === "review").length],
			["Öğrenildi", words.filter((word) => word.status === "mastered").length],
			["Grammar notu", this.plugin.settings.study.grammar.length],
			["Hata kaydı", this.plugin.settings.study.mistakes.length],
			["Shadowing çalışması", this.plugin.settings.study.shadowing.length],
		];
		const grid = parent.createEl("div", { cls: "clp-study-progress-grid" });
		for (const [label, value] of stats) {
			const card = grid.createEl("div", { cls: "clp-study-progress-card" });
			card.createEl("strong", { text: String(value) });
			card.createEl("span", { text: label });
		}
	}

	private renderEmpty(parent: HTMLElement, text: string): void {
		parent.createEl("div", { cls: "clp-study-empty", text });
	}

	private async advanceVocabulary(id: string): Promise<void> {
		const record = this.plugin.settings.study.vocabulary.find((item) => item.id === id);
		if (!record) return;
		record.status = record.status === "new" ? "learning" : record.status === "learning" ? "review" : "mastered";
		record.updatedAt = Date.now();
		await this.plugin.saveSettings();
		new Notice(`${record.term}: ${statusLabel(record.status)}`);
		this.render();
	}
}

export function compareShadowing(source: string, input: string): ShadowingAttempt {
	const expected = tokenize(source);
	const actual = tokenize(input);
	const distance = levenshtein(expected, actual);
	const score = Math.max(0, Math.round((1 - distance / Math.max(1, expected.length)) * 100));
	const differences: string[] = [];
	const max = Math.max(expected.length, actual.length);
	for (let index = 0; index < max && differences.length < 8; index++) {
		if (expected[index] !== actual[index]) differences.push(`${actual[index] ?? "∅"} → ${expected[index] ?? "∅"}`);
	}
	return { createdAt: Date.now(), input: input.trim(), score, differences };
}

function tokenize(text: string): string[] {
	return text.normalize("NFKC").toLocaleLowerCase("en").match(/[\p{L}\p{N}']+/gu) ?? [];
}

function levenshtein(left: string[], right: string[]): number {
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let row = 1; row <= left.length; row++) {
		const current = [row];
		for (let column = 1; column <= right.length; column++) {
			current[column] = Math.min(
				current[column - 1] + 1,
				previous[column] + 1,
				previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
			);
		}
		previous = current;
	}
	return previous[right.length];
}

function speakEnglish(text: string, locale: string, rate: number, voiceName: string): void {
	speakEnglishText(text, locale, rate, voiceName);
}

export function renderStudyMarkdown(data: StudyData): string {
	const lines: string[] = [
		"---",
		"clp_document: study-export",
		`exported_at: ${new Date().toISOString()}`,
		"---",
		"",
		"# Study Export",
		"",
		"## Vocabulary",
		"",
		"| English | Türkçe | IPA / POS | Seen | Status | Kaynak bağlamı |",
		"|---|---|---|---:|---|---|",
	];
	for (const item of data.vocabulary) {
		lines.push(`| ${cell(item.term)} | ${cell(item.translation)} | ${cell([item.ipa, item.partOfSpeech].filter(Boolean).join(" · "))} | ${item.seen} | ${item.status} | ${cell(item.source.context)} |`);
	}
	lines.push("", "## Grammar", "");
	for (const item of data.grammar) {
		lines.push(`### ${heading(item.title)}`, "", item.content, "");
		for (const point of item.grammarPoints) lines.push(`- ${point}`);
		if (item.syntaxTree) lines.push("", "```text", item.syntaxTree, "```", "");
		lines.push(`Kaynak: ${item.source.label}`, "");
	}
	lines.push("## Mistakes", "");
	for (const item of data.mistakes) {
		lines.push(`- **${item.status} · ${item.category}:** ${item.original} → ${item.correction}${item.explanation ? ` — ${item.explanation}` : ""}`);
	}
	lines.push("", "## Shadowing", "");
	for (const item of data.shadowing) {
		lines.push(`### ${heading(item.source.label)}`, "", `> ${item.text.replace(/\r?\n/g, "\n> ")}`, "");
		for (const attempt of item.attempts) {
			lines.push(`- ${new Date(attempt.createdAt).toLocaleString("tr-TR")} · %${attempt.score}${attempt.differences.length ? ` · ${attempt.differences.join(", ")}` : ""}`);
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd() + "\n";
}

function cell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>").trim();
}

function heading(value: string): string {
	return value.replace(/[\r\n#]+/g, " ").trim() || "Kayıt";
}

function statusLabel(status: ReviewStatus): string {
	return ({ new: "Yeni", learning: "Öğreniliyor", review: "Tekrar", mastered: "Öğrenildi" })[status];
}
