export type CaptionPreference = "manual-first" | "automatic-first";
export type PauseMode = "adaptive" | "custom";
export type PlaylistBehavior = "selected-video" | "batch" | "reject";
export type CaptionFallback = "off" | "yt-dlp";
export type NoCaptionFallback = "off" | "ask" | "automatic";
export type ScreenshotMode = "off" | "manual";

export interface YoutubeSettings {
	sourceLanguage: string;
	captionPreference: CaptionPreference;
	pauseMode: PauseMode;
	pauseSeconds: number;
	topicTransitions: boolean;
	autoTranslate: boolean;
	outputFolder: string;
	playlistBehavior: PlaylistBehavior;
	captionFallback: CaptionFallback;
	ytDlpCommand: string;
	ffmpegCommand: string;
	noCaptionFallback: NoCaptionFallback;
	whisperCommand: string;
	/** Python Whisper model name, or a whisper.cpp model file path. */
	whisperModel: string;
	screenshotMode: ScreenshotMode;
}

/** Small, durable playlist checkpoint. The generated Markdown stories remain
 *  the source of truth for reading; this record only prevents a later batch
 *  run from downloading/translating the same video again. */
export interface YoutubePlaylistProgress {
	playlistId: string;
	sourceUrl: string;
	videoIds: string[];
	completedVideoIds: string[];
	currentIndex: number;
	updatedAt: number;
}

export const DEFAULT_YOUTUBE_SETTINGS: YoutubeSettings = {
	sourceLanguage: "en",
	captionPreference: "manual-first",
	pauseMode: "adaptive",
	pauseSeconds: 2.8,
	topicTransitions: true,
	autoTranslate: true,
	outputFolder: "Library/YouTube",
	playlistBehavior: "batch",
	captionFallback: "yt-dlp",
	ytDlpCommand: "",
	ffmpegCommand: "",
	noCaptionFallback: "ask",
	whisperCommand: "",
	whisperModel: "base.en",
	screenshotMode: "manual",
};
