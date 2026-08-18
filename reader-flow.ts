export function clampReaderFraction(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export function readerScrollOffset(fraction: number, scrollHeight: number, clientHeight: number): number {
	return clampReaderFraction(fraction) * Math.max(0, scrollHeight - clientHeight);
}

export function readerScrollFraction(scrollTop: number, scrollHeight: number, clientHeight: number): number {
	const max = Math.max(0, scrollHeight - clientHeight);
	return max > 0 ? clampReaderFraction(scrollTop / max) : 1;
}

export function readerSectionIndex(fraction: number, sectionCount: number): number {
	if (sectionCount <= 1) return 0;
	return Math.min(sectionCount - 1, Math.floor(clampReaderFraction(fraction) * sectionCount));
}
