// Thin wrappers over the Web Speech API (ASR) and speechSynthesis (TTS), zh-CN.

interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}
export interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onspeechstart: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

type RecognitionCtor = new () => Recognition;

export function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const ttsAvailable = () => typeof window !== "undefined" && "speechSynthesis" in window;

/** Removes markdown syntax so TTS does not read symbols aloud. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "（代码略）")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[*_#>~]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
}

export function speak(text: string, onStart: () => void, onEnd: () => void): void {
  const u = new SpeechSynthesisUtterance(speakable(text));
  u.lang = "zh-CN";
  const zh = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith("zh"));
  if (zh) u.voice = zh;
  u.onstart = onStart;
  u.onend = onEnd;
  u.onerror = onEnd;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if (ttsAvailable()) speechSynthesis.cancel();
}
