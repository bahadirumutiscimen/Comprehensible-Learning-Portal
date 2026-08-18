import type { EpubBook } from "./epub";
import { isRegisterableBlock, REGISTERABLE_BLOCK_SELECTOR } from "./pretext-layer";
import { normalizeSourceText, sourceHash, type TranslationPair, type TranslationUnit } from "./translation-service";

export interface EpubChapterUnits {
	spineIndex: number;
	href: string;
	label: string;
	units: TranslationUnit[];
}

export interface BilingualBookData {
	filePath: string;
	title: string;
	sourceFingerprint: string;
	updatedAt: number;
	translatedChapters: number[];
	paragraphs: Record<string, TranslationPair>;
}

export interface EpubTranslationProgress {
	total: number;
	completed: number;
	validTranslatedChapters: number[];
}

/**
 * EPUB spines commonly contain cover/title documents with no readable text.
 * Keep checkpoints in raw spine order, but report progress only for chapters
 * that actually contain translation units.
 */
export function epubTranslationProgress(
	chapters: EpubChapterUnits[],
	translatedChapters: number[],
): EpubTranslationProgress {
	const translatable = chapters.filter((chapter) => chapter.units.length > 0);
	const validSpines = new Set(translatable.map((chapter) => chapter.spineIndex));
	const validTranslatedChapters = translatedChapters.filter((spineIndex) => validSpines.has(spineIndex));
	return {
		total: translatable.length,
		completed: new Set(validTranslatedChapters).size,
		validTranslatedChapters,
	};
}

export async function extractEpubTranslationUnits(book: EpubBook): Promise<EpubChapterUnits[]> {
	const chapters: EpubChapterUnits[] = [];
	for (let spineIndex = 0; spineIndex < book.spine.length; spineIndex++) {
		const item = book.spine[spineIndex];
		const file = book.zip.file(book.opfDir + item.href);
		if (!file) continue;
		const html = await file.async("string");
		const doc = new DOMParser().parseFromString(html, "text/html");
		const blocks = Array.from(doc.body.querySelectorAll<HTMLElement>(REGISTERABLE_BLOCK_SELECTOR));
		const units: TranslationUnit[] = [];
		let paragraphIndex = 0;
		for (const block of blocks) {
			if (!isRegisterableBlock(block)) continue;
			const text = normalizeSourceText(block.textContent ?? "");
			const id = `s${spineIndex}-p${paragraphIndex++}`;
			if (!text) continue;
			units.push({ id, text, sourceHash: sourceHash(text) });
		}
		chapters.push({
			spineIndex,
			href: item.href,
			label: chapterLabel(book, item.href, spineIndex),
			units,
		});
	}
	return chapters;
}

export function createBilingualBook(filePath: string, book: EpubBook, chapters: EpubChapterUnits[]): BilingualBookData {
	const fingerprint = sourceHash(chapters.flatMap((chapter) => chapter.units).map((unit) => unit.sourceHash).join("|"));
	return {
		filePath,
		title: book.title,
		sourceFingerprint: fingerprint,
		updatedAt: Date.now(),
		translatedChapters: [],
		paragraphs: {},
	};
}

export function decorateBilingualContent(root: HTMLElement, data: BilingualBookData | undefined): void {
	if (!data) return;
	for (const spine of Array.from(root.querySelectorAll<HTMLElement>(".clp-spine-item"))) {
		const spineIndex = Number.parseInt(spine.dataset.spineIndex ?? "0", 10);
		const blocks = Array.from(spine.querySelectorAll<HTMLElement>(REGISTERABLE_BLOCK_SELECTOR));
		let paragraphIndex = 0;
		for (const block of blocks) {
			if (!isRegisterableBlock(block) || block.closest(".clp-bilingual-pair")) continue;
			const paraId = `s${spineIndex}-p${paragraphIndex++}`;
			const pair = data.paragraphs[paraId];
			if (!pair || pair.sourceHash !== sourceHash(block.textContent ?? "")) continue;
			const wrapper = document.createElement("div");
			wrapper.className = "clp-bilingual-pair";
			wrapper.dataset.paraId = paraId;
			block.before(wrapper);
			block.classList.add("clp-bilingual-source");
			wrapper.appendChild(block);
			const translation = document.createElement("div");
			translation.className = "clp-bilingual-translation";
			translation.lang = "tr";
			translation.textContent = pair.translation;
			wrapper.appendChild(translation);
		}
	}
}

function chapterLabel(book: EpubBook, href: string, index: number): string {
	const flat: { label: string; href: string }[] = [];
	const visit = (items: EpubBook["toc"]): void => {
		for (const item of items) { flat.push({ label: item.label, href: item.href }); visit(item.children); }
	};
	visit(book.toc);
	const normalized = href.split("#", 1)[0];
	const tocLabel = flat.find((item) => item.href.split("#", 1)[0] === normalized)?.label?.replace(/\s+/g, " ").trim() ?? "";
	const heading = book.spineLabels?.[index]?.replace(/\s+/g, " ").trim();
	if (heading && (!tocLabel || /[\u0400-\u04ff]/u.test(tocLabel) || /^(?:c?tapt|start|contents?)$/iu.test(tocLabel))) return heading;
	return tocLabel || heading || `Bölüm ${index + 1}`;
}
