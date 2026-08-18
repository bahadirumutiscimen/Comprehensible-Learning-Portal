/** Shared Web Speech wrapper. Explicitly selecting a natural system voice
 * avoids the robotic default that Electron can choose when `voice` is unset. */
export function listSpeechVoices(locale: string): SpeechSynthesisVoice[] {
	if (!("speechSynthesis" in window)) return [];
	const voices = window.speechSynthesis.getVoices();
	const language = locale.toLowerCase();
	const exact = voices.filter((voice) => voice.lang.toLowerCase() === language);
	const sameLanguage = voices.filter((voice) => voice.lang.toLowerCase().startsWith(language.slice(0, 2)));
	return exact.length ? exact : sameLanguage;
}

export function preferredSpeechVoice(locale: string, preferredName = ""): SpeechSynthesisVoice | undefined {
	const candidates = listSpeechVoices(locale);
	if (!candidates.length) return undefined;
	if (preferredName) {
		const selected = candidates.find((voice) => voice.name === preferredName);
		if (selected) return selected;
	}
	const natural = /(natural|enhanced|premium|neural|samantha|alex|daniel|google|microsoft)/i;
	return candidates.find((voice) => natural.test(voice.name)) ?? candidates[0];
}

export function speakEnglishText(text: string, locale: string, rate: number, preferredName = ""): void {
	if (!text.trim() || !("speechSynthesis" in window)) return;
	const synthesis = window.speechSynthesis;
	synthesis.cancel();
	const utterance = new SpeechSynthesisUtterance(text);
	utterance.lang = locale;
	utterance.rate = rate;
	const voice = preferredSpeechVoice(locale, preferredName);
	if (voice) utterance.voice = voice;
	synthesis.speak(utterance);
	// Voices can arrive just after the first request in Electron. Replace the
	// fallback only while it is still speaking, so the user hears one sentence.
	if (!voice) window.setTimeout(() => {
		if (!synthesis.speaking) return;
		const selected = preferredSpeechVoice(locale, preferredName);
		if (!selected) return;
		synthesis.cancel();
		const retry = new SpeechSynthesisUtterance(text);
		retry.lang = locale;
		retry.rate = rate;
		retry.voice = selected;
		synthesis.speak(retry);
	}, 120);
}
