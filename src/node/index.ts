/**
 * `@notrealstudio/speak/node` — Node-половина: конфиг движков из цепочки runz, токен
 * gcloud, кэш кусков на диске, ffmpeg, html → markdown (Defuddle).
 */

export { defaultVoiceProvider, engineFromCtx, enginesFromCtx, fileCache, gcloudToken, isVertex, listOf, providerOf, speakOpt } from './config.js'
export type { EngineFromCtxOpts, EnginesFromCtxOpts, VoiceProvider } from './config.js'
export { diskCache } from './cache.js'
export { ffmpegRunner } from './ffmpeg.js'
export { formatOf, htmlToMarkdown, normalize } from './html.js'
export type { InputFormat } from './html.js'
export { INLINE_MAX, audioDuration, createListener, deleteFile, ffprobeOf, listenModelOf, listenerFromCtx, prepareAudio, truncatedAt, uploadFile } from './stt.js'
export type { FilesApiOpts, Listened, Listener, ListenerOpts, UploadedFile } from './stt.js'
