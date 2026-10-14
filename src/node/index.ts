/**
 * `@notrealstudio/speak/node` — Node-половина: конфиг движков из цепочки runz, токен
 * gcloud, кэш кусков на диске, ffmpeg, html → markdown (Defuddle).
 */

export { defaultVoiceProvider, engineFromCtx, enginesFromCtx, fileCache, gcloudToken, isVertex, listOf, providerOf, speakOpt } from './config.js'
export type { EngineFromCtxOpts, EnginesFromCtxOpts, VoiceProvider } from './config.js'
export { diskCache } from './cache.js'
export { ffmpegPipe, ffmpegRunner } from './ffmpeg.js'
export { formatOf, htmlToMarkdown, normalize } from './html.js'
export type { InputFormat } from './html.js'
export { INLINE_MAX, LISTEN_ENGINES, OPENAI_INLINE_MAX, audioDuration, createListener, deleteFile, ffprobeOf, listenModelOf, listenerFromCtx, listenerOver, parseListenModel, prepareAudio, truncatedAt, uploadFile } from './stt.js'
export type { FilesApiOpts, ListenEngine, Listened, Listener, ListenerOpts, UploadedFile } from './stt.js'
export { BOOK_FORMATS, BOOK_MAX_BYTES, NO_TEXT_LAYER, bookToMarkdown, docxToMarkdown, epubToMarkdown, fb2ToMarkdown, htmlToMd, mdEscape, pdfLayoutToMarkdown, pdfToMarkdown, sniffBook, tidyBook, xmlEncoding } from './book.js'
export type { Book, BookFormat, BookOpts } from './book.js'
