import { App, Modal, Notice, Platform, TFile, normalizePath, setIcon } from "obsidian";
import { LIBRARY_ROOT, sanitizeFileName } from "./library-scan";
import type { ImportJob } from "./import-jobs";
import { parseYoutubeInput } from "./youtube";

export type ImportStage = "idle" | "validating" | "reading" | "saving" | "preparing" | "extracting" | "segmenting" | "translating" | "indexing" | "complete" | "failed" | "cancelled";

export interface ImportProgress {
	stage: ImportStage;
	message: string;
	current?: number;
	total?: number;
	jobId?: string;
}

export interface ContentImportHost {
	app: App;
	openEpubInNewTab(filePath: string): Promise<void>;
	prepareImportedEpub(filePath: string, onProgress: (progress: ImportProgress) => void): Promise<string>;
	importYoutubeUrl(url: string, onProgress: (progress: ImportProgress) => void): Promise<void>;
	getImportJobs(): ImportJob[];
	cancelImportJob(id: string): void;
	retryImportJob(id: string, onProgress: (progress: ImportProgress) => void): Promise<void>;
}

export interface EpubImportResult {
	files: TFile[];
	errors: string[];
}

const BOOKS_FOLDER = normalizePath(`${LIBRARY_ROOT}/Books`);

async function ensureFolder(app: App, path: string): Promise<void> {
	const parts = normalizePath(path).split("/").filter(Boolean);
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!app.vault.getAbstractFileByPath(current)) await app.vault.createFolder(current);
	}
}

function uniqueVaultPath(app: App, folder: string, fileName: string): string {
	const dot = fileName.lastIndexOf(".");
	const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
	const extension = dot > 0 ? fileName.slice(dot) : "";
	let candidate = normalizePath(`${folder}/${fileName}`);
	let counter = 2;
	while (app.vault.getAbstractFileByPath(candidate)) {
		candidate = normalizePath(`${folder}/${stem} ${counter++}${extension}`);
	}
	return candidate;
}

function looksLikeEpub(bytes: ArrayBuffer): boolean {
	const header = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 4));
	return header.length >= 2 && header[0] === 0x50 && header[1] === 0x4b;
}

export class ContentImportService {
	constructor(private app: App) {}

	async importEpubFiles(
		files: File[],
		onProgress: (progress: ImportProgress) => void,
	): Promise<EpubImportResult> {
		await ensureFolder(this.app, BOOKS_FOLDER);
		const imported: TFile[] = [];
		const errors: string[] = [];

		for (let index = 0; index < files.length; index++) {
			const file = files[index];
			const position = { current: index + 1, total: files.length };
			onProgress({ stage: "reading", message: `${file.name} okunuyor…`, ...position });
			try {
				if (!file.name.toLowerCase().endsWith(".epub")) throw new Error("Dosya EPUB değil.");
				const bytes = await file.arrayBuffer();
				if (!looksLikeEpub(bytes)) throw new Error("Geçerli bir EPUB arşivi değil.");

				onProgress({ stage: "saving", message: `${file.name} kütüphaneye ekleniyor…`, ...position });
				const safeStem = sanitizeFileName(file.name.replace(/\.epub$/i, "").trim()) || "Kitap";
				const path = uniqueVaultPath(this.app, BOOKS_FOLDER, `${safeStem}.epub`);
				imported.push(await this.app.vault.createBinary(path, bytes));
			} catch (error) {
				errors.push(`${file.name}: ${(error as Error).message}`);
			}
		}

		if (imported.length) {
			onProgress({
				stage: "preparing",
				message: imported.length === 1 ? "Kitap okuma için hazırlanıyor…" : "Kitaplar okuma için hazırlanıyor…",
				current: imported.length,
				total: files.length,
			});
		}
		onProgress({
			stage: errors.length && !imported.length ? "failed" : "complete",
			message: imported.length
				? `${imported.length} kitap hazır.`
				: "Hiçbir kitap içe aktarılamadı.",
			current: imported.length,
			total: files.length,
		});
		return { files: imported, errors };
	}
}

export class ContentImportModal extends Modal {
	private readonly service: ContentImportService;
	private busy = false;
	private statusEl: HTMLElement | null = null;
	private historyEl: HTMLElement | null = null;
	private activeJobId: string | null = null;
	private historyRefreshTimer: number | null = null;

	constructor(app: App, private host: ContentImportHost) {
		super(app);
		this.service = new ContentImportService(app);
	}

	onOpen(): void {
		this.modalEl.addClass("clp-import-modal");
		this.titleEl.setText("İçerik ekle");
		this.contentEl.empty();
		if (Platform.isMobile) {
			this.contentEl.createEl("p", {
				cls: "clp-import-intro",
				text: "EPUB ve YouTube içe aktarma masaüstünde yapılır. Masaüstünde hazırlanan ve senkronlanan kitapları ya da video hikâyelerini bu cihazda okuyabilirsin.",
			});
			return;
		}

		this.contentEl.createEl("p", {
			cls: "clp-import-intro",
			text: "Kitabını seç veya YouTube bağlantısını yapıştır. Kalan adımları portal tamamlar.",
		});

		const choices = this.contentEl.createEl("div", { cls: "clp-import-choices" });
		this.renderEpubChoice(choices);
		this.renderYoutubeChoice(choices);
		this.statusEl = this.contentEl.createEl("div", { cls: "clp-import-status", attr: { "aria-live": "polite" } });
		this.historyEl = this.contentEl.createEl("div", { cls: "clp-import-history" });
		this.renderHistory();
		// A reopened modal has no live progress callback from the original import
		// action. Poll the persisted in-memory job list so the current and queued
		// items become visible and keep moving without restarting the import.
		this.historyRefreshTimer = window.setInterval(() => this.renderHistory(), 1000);
	}

	onClose(): void {
		if (this.historyRefreshTimer !== null) window.clearInterval(this.historyRefreshTimer);
		this.historyRefreshTimer = null;
		this.contentEl.empty();
	}

	private renderEpubChoice(parent: HTMLElement): void {
		const card = parent.createEl("section", { cls: "clp-import-choice" });
		const icon = card.createEl("div", { cls: "clp-import-choice-icon" });
		setIcon(icon, "book-open");
		const copy = card.createEl("div", { cls: "clp-import-choice-copy" });
		copy.createEl("h3", { text: "EPUB kitabı" });
		copy.createEl("p", { text: "Kitabı kütüphaneye ekler ve okuma ekranını hazırlar." });

		const input = card.createEl("input");
		input.type = "file";
		input.accept = ".epub,application/epub+zip";
		input.multiple = true;
		input.addClass("clp-visually-hidden");

		const button = card.createEl("button", { cls: "mod-cta", text: "EPUB seç" });
		button.addEventListener("click", () => {
			if (!this.busy) input.click();
		});
		input.addEventListener("change", () => {
			const files = Array.from(input.files ?? []);
			if (files.length) void this.importEpubs(files);
		});
	}

	private renderYoutubeChoice(parent: HTMLElement): void {
		const card = parent.createEl("section", { cls: "clp-import-choice" });
		const icon = card.createEl("div", { cls: "clp-import-choice-icon" });
		setIcon(icon, "youtube");
		const copy = card.createEl("div", { cls: "clp-import-choice-copy" });
		copy.createEl("h3", { text: "YouTube hikâyesi" });
		copy.createEl("p", { text: "Videoyu veya playlisti duraklama ve konu değişimlerine göre çift dilli bir okumaya dönüştürür." });
		const pipeline = card.createEl("details", { cls: "clp-import-pipeline" });
		pipeline.createEl("summary", { text: "Bağlantıdan öğrenme ortamına ne olacak?" });
		const steps = pipeline.createEl("ol");
		for (const step of [
			"Video veya playlist kimliği doğrulanır; playlist seçtiysen videolar sırayla ele alınır.",
			"Altyazı yoksa önce yt-dlp denenir; gerekirse yerel Whisper için senden onay istenir.",
			"Zaman kodları korunur; uzun duraklamalar ve AI konu/sahne geçişleri paragraf sınırı olur.",
			"Her İngilizce paragraf Codex ile bağlamsal bir Türkçe paragrafla eşleştirilir.",
			"Her video tamamlanınca çift dilli hikâye Library/YouTube içine kaydedilir; playlist ilerlemesi de kalıcı yazılır.",
			"Timestamp, aktif paragraf takibi, Gloss, TTS, Vocabulary, Grammar ve Shadowing hazır olur.",
		]) steps.createEl("li", { text: step });

		const form = card.createEl("form", { cls: "clp-import-youtube-form" });
		const input = form.createEl("input", {
			attr: {
				type: "url",
				placeholder: "https://www.youtube.com/watch?v=… veya playlist?list=…",
				"aria-label": "YouTube bağlantısı",
			},
		});
		const button = form.createEl("button", {
			cls: "mod-cta clp-import-youtube-submit",
			text: "YouTube içeriğini analiz et ve içe aktar",
			attr: { "aria-label": "YouTube videosunu veya playlistini analiz et ve içe aktar" },
		});
		button.type = "submit";
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			if (!this.busy) void this.importYoutube(input.value);
		});
	}

	private updateProgress(progress: ImportProgress): void {
		if (progress.jobId) this.activeJobId = progress.jobId;
		if (!this.statusEl) return;
		this.statusEl.empty();
		const row = this.statusEl.createEl("div", { cls: `clp-import-status-row is-${progress.stage}` });
		if (progress.stage !== "complete" && progress.stage !== "failed") {
			row.createEl("span", { cls: "clp-import-spinner" });
		} else {
			setIcon(row.createSpan({ cls: "clp-import-status-icon" }), progress.stage === "complete" ? "circle-check" : "circle-alert");
		}
		row.createSpan({ text: progress.message });
		if (progress.total && progress.total > 1) {
			row.createSpan({ cls: "clp-import-status-count", text: `${progress.current ?? 0}/${progress.total}` });
		}
		if (this.activeJobId && !["complete", "failed", "cancelled"].includes(progress.stage)) {
			const stop = row.createEl("button", { cls: "clp-import-stop", text: "Durdur" });
			stop.addEventListener("click", () => {
				if (this.activeJobId) this.host.cancelImportJob(this.activeJobId);
			});
		}
		this.renderHistory();
	}

	private async importEpubs(files: File[]): Promise<void> {
		this.busy = true;
		try {
			const result = await this.service.importEpubFiles(files, (progress) => this.updateProgress(progress));
			if (result.errors.length) new Notice(result.errors.join("\n"));
			for (const file of result.files) {
				await this.host.prepareImportedEpub(file.path, (progress) => this.updateProgress(progress));
			}
			const first = result.files[0];
			if (first) {
				await this.host.openEpubInNewTab(first.path);
				this.close();
			}
		} finally {
			this.busy = false;
		}
	}

	private async importYoutube(rawUrl: string): Promise<void> {
		let normalizedUrl: string;
		try {
			normalizedUrl = new URL(rawUrl.trim()).toString();
		} catch {
			new Notice("Geçerli bir YouTube bağlantısı gir.");
			return;
		}
		const identity = parseYoutubeInput(normalizedUrl);
		if (!identity.videoId && !identity.playlistId) {
			new Notice("Bağlantıda geçerli bir YouTube video veya playlist kimliği bulunamadı.");
			return;
		}

		this.busy = true;
		try {
			await this.host.importYoutubeUrl(normalizedUrl, (progress) => this.updateProgress(progress));
			const completed = this.activeJobId
				? this.host.getImportJobs().find((job) => job.id === this.activeJobId)?.status === "complete"
				: false;
			if (completed) this.close();
		} finally {
			this.busy = false;
		}
	}

	private renderHistory(): void {
		if (!this.historyEl) return;
		this.historyEl.empty();
		const allJobs = this.host.getImportJobs();
		const priority: Record<ImportJob["status"], number> = {
			running: 0,
			queued: 1,
			paused: 2,
			failed: 3,
			cancelled: 4,
			complete: 5,
		};
		const jobs = [...allJobs]
			.sort((left, right) => priority[left.status] - priority[right.status] || right.updatedAt - left.updatedAt)
			.slice(0, 8);
		if (!jobs.length) return;
		const activeCount = allJobs.filter((job) => ["running", "queued", "paused"].includes(job.status)).length;
		this.historyEl.createEl("h3", { text: activeCount ? `İşlem kuyruğu (${activeCount})` : "Son işlemler" });
		for (const job of jobs) {
			const row = this.historyEl.createEl("div", { cls: `clp-import-history-row is-${job.status}` });
			const copy = row.createEl("div", { cls: "clp-import-history-copy" });
			copy.createEl("strong", { text: job.displayName });
			copy.createEl("span", { text: job.error || `${stageLabel(job.stage)} · ${job.completed}/${job.total || "?"}` });
			if (["failed", "cancelled", "paused"].includes(job.status)) {
				const retry = row.createEl("button", { text: "Devam et" });
				retry.addEventListener("click", () => void this.host.retryImportJob(job.id, (progress) => this.updateProgress(progress)));
			} else if (job.status === "running") {
				const stop = row.createEl("button", { text: "Durdur" });
				stop.addEventListener("click", () => this.host.cancelImportJob(job.id));
			}
		}
	}
}

export function contentImportCapabilityLabel(): string {
	return Platform.isMobileApp ? "Mobil dosya seçici" : "Masaüstü dosya seçici";
}

function stageLabel(stage: ImportJob["stage"]): string {
	return ({
		validating: "Doğrulanıyor",
		saving: "Kaydediliyor",
		extracting: "Metin çıkarılıyor",
		segmenting: "Paragraflar hazırlanıyor",
		translating: "Çevriliyor",
		indexing: "Kütüphaneye ekleniyor",
		complete: "Tamamlandı",
	})[stage];
}
