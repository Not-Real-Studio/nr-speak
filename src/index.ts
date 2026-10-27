/**
 * `@notrealstudio/speak` — текст → речь (DEV-247, speak-core-spec). Без Node: HTTP —
 * инъекцией `fetch`, кэш и ffmpeg — инъекцией (Node-реализации — `@notrealstudio/speak/node`).
 *
 *   движки     createVertexEngine · createGeminiEngine (AI Studio) · createRoutedEngine ·
 *              createChirpEngine · createEdgeEngine · createOpenAIEngine · createLocalEngine
 *              (OmniVoice, pocket) · createFallbackEngine — всё за TtsEngine
 *   голоса     catalog · resolveVoice (`vertex:Kore`, короткое имя: Vertex → Studio → Chirp → Edge)
 *   текст      l0Markdown · l0Text (нормализатор L0) → segment / segmentText (куски)
 *   речь→текст createGeminiTranscriber (Gemini 3.5 Transcribe) · segmentsOf · sniffAudio
 *   звук       createSpeaker (синтез куска с кэшем, поток кусков) · convert · wavHeader
 */

export * from './types.js'
export * from './gemini.js'
export * from './chirp.js'
export * from './edge.js'
export * from './openai.js'
export * from './local.js'
export * from './catalog.js'
export * from './segment.js'
export * from './normalize.js'
export * from './audio.js'
export * from './speaker.js'
export * from './stt.js'
export * from './live.js'
export * from './poll-live.js'
