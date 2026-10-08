# @notrealstudio/speak

Текст → речь (и обратно) для любых проектов: движки за одним интерфейсом `TtsEngine` — Gemini 3.8 TTS
в Vertex AI (OAuth) и в AI Studio (ключ, свои голоса Voice design), маршрут по голосу между
ними, Google Cloud TTS Chirp 3 HD, Microsoft Edge read-aloud (бесплатно, без ключа), любой
OpenAI-совместимый `/v1/audio/speech` (локальный mlx-audio и подобные). Сверху — единый
каталог голосов с полными именами (`vertex:Kore`, `edge:ru-RU-SvetlanaNeural`) и резолвом
коротких, нормализатор L0 (markdown/html/текст → текст для слуха: без кода, ссылок, хэшей,
таблицы построчно), нарезка на куски под лимиты движков, синтез куска с кэшем по хэшу и
перекодирование в mp3/wav/opus/pcm через ffmpeg. Ядро без Node (HTTP — инъекцией `fetch`);
Node-половина (`/node`) — конфиг из цепочки runz, токен gcloud, кэш на диске, ffmpeg,
html → markdown через Defuddle.

## Быстрый старт

```ts
import { createSpeaker, l0Markdown, segment } from '@notrealstudio/speak'
import { diskCache, enginesFromCtx, fileCache, ffmpegRunner } from '@notrealstudio/speak/node'

const engines = enginesFromCtx(ctx, { cache: fileCache('voices.json', '.') }) // ctx — IContext runz
const speaker = createSpeaker({ engines, defaultVoice: 'vertex:Sulafat', favorites: ['Sulafat', 'Leda', 'Enceladus'], cache: diskCache('speak-cache'), ffmpeg: ffmpegRunner() })

const { blocks } = l0Markdown(markdown)                        // нормализатор L0
const texts = segment(blocks).map((s) => s.text)               // куски 1–1.5K символов, первый короткий
for await (const bytes of speaker.stream(texts, { voice: 'Svetlana' }, 'mp3')) out.write(bytes)

const one = await speaker.synth('Привет', { voice: 'chirp:Aoede', speed: 1.2 }, 'mp3') // {data, cached, key, voice}
```

## API

**Движки** (`TtsEngine`: `voices`, `design`, `speak(text, voice, opts, signal) → AsyncIterable<{data, mime}>`):

| Фабрика | Движок | Звук | Темп | Голоса |
|---|---|---|---|---|
| `createVertexEngine({project, token})` | Gemini 3.8 Flash TTS, Vertex AI | PCM стримом (SSE) | ffmpeg | 30 студийных (`Kore`, `Puck`, …) |
| `createGeminiEngine({apiKey, cache})` | Gemini TTS, AI Studio | PCM стримом | ffmpeg | студийные + свои `voice_…` (`design`) |
| `createRoutedEngine(studio, vertex)` | `voice_…` → AI Studio, остальное → Vertex | | | |
| `createChirpEngine({project, token})` | Cloud TTS Chirp 3 HD | mp3 или wav, целиком | свой | `ru-RU-Chirp3-HD-*` |
| `createEdgeEngine({client?})` | Edge read-aloud (`msedge-tts`) | mp3 стримом | свой | `ru-RU-SvetlanaNeural`, … |
| `createOpenAIEngine({baseUrl, model})` | любой `/v1/audio/speech` | mp3 или pcm | свой | из опций |

`SpeakOpts`: `instruct` (тон — Gemini/OpenAI), `speed` (только движкам с `nativeSpeed`),
`format: 'mp3'|'pcm'` (подсказка: кто умеет mp3 сам — отдаёт его без перекодирования).
`coalesce` — склейка мелких кадров PCM для провода.

**Голоса.** `catalog(engines, {engine?}) → {voices: [{id, engine, voice, lang, gender, tier}], errors}`
— `favorite: true` у голосов из `favorites` (полное имя или голос без префикса; избранные — первыми); тиры: `vertex` premium, `studio` cheap, `chirp`/`edge` free, `openai` local; упавший
движок — в `errors`, остальные отдаются. `resolveVoice(engines, name, {engine?, defaultVoice?})`:
`vertex:Kore` — как есть; короткое имя — Vertex → Studio → Chirp → Edge → OpenAI (точный id
без регистра, затем однозначная часть: `Svetlana` → `edge:ru-RU-SvetlanaNeural`,
`chirp:Aoede` → `chirp:ru-RU-Chirp3-HD-Aoede`).

**Нормализатор L0.** `l0Markdown(md, opts)` / `l0Text(text, opts)` → `{title, blocks: [{kind, text}]}`;
`blocksText(blocks)` — текст для глаз (`--print`). Выкидывает frontmatter, картинки, адреса
ссылок, голые URL, сноски, HTML, хэши (`[0-9a-f]{7,40}` с цифрой и буквой); блок кода —
«Пропущен блок кода.» (`code: 'skip'` — ничего); инлайн-код — слово текстом, путь/флаг по
`inlineCode: read|announce|skip`; таблицы gfm и box-drawing — до 4×8 построчно
«строка: колонка — значение; …», больше — «Таблица, N строк, колонки: …»
(`tables: rows|announce|skip`); списки — предложениями. Числа не трогает (это L1).
Node: `normalize(src, 'text'|'markdown'|'html', opts)`, `htmlToMarkdown(html, url)` (Defuddle +
linkedom), `formatOf(name)`.

**Куски.** `segment(blocks, {maxChars=1500, maxBytes=3600, first=250})` → `[{text, kind}]`:
заголовок — отдельный кусок, первый — короткий, режет по абзацам → предложениям → запятым →
пробелам. `segmentText(text)` — для простого текста.

**Звук.** `createSpeaker({engines, defaultVoice, cache?, ffmpeg?})`: `synth(text, req, format)`
— один кусок, ключ кэша `sha256(engine|voice|instruct|speed|text).<формат>`, повтор — без
синтеза (`stats: {synth, hits}`); `stream(texts, req, format)` — куски подряд, следующий
синтезируется, пока отдаётся текущий (wav — один стримовый заголовок, `finalizeWav` чинит
размеры для файла). `convert(audio, format, {speed, ffmpeg})`: mp3 → mp3 и PCM ↔ wav/pcm без
ffmpeg, остальное — ffmpeg (`ffmpegArgs`, темп — `atempo`).

**Node.** `enginesFromCtx(ctx, {cache})` — движки из `~/.runz/config.md`: `vertex` и `chirp` —
`## $provider vertex` с `$project` (токен `gcloud auth application-default print-access-token`,
`$gcloud` — путь), `studio` — `## $provider google` с `$api_key`, `edge` — всегда, `openai` —
`$openai_provider` блока `## $speak` → `## $provider <имя>` (`$base_url`, `$model`, `$api_key`),
`$engines` — явный список. `engineFromCtx`/`providerOf`/`gcloudToken`/`fileCache` — прежний
выбор одного движка сервиса voice nrchat (`$voice_provider`). `diskCache(dir)`,
`ffmpegRunner(bin?)`.

## Распознавание

Обратное направление — речь → текст: Gemini 3.5 Transcribe (`gemini-3.5-transcribe`) через
Gemini API (AI Studio, ключ), Interactions API `POST /v1beta/interactions`.

```ts
import { createGeminiTranscriber } from '@notrealstudio/speak'
import { listenerFromCtx, audioDuration, ffprobeOf, ffmpegRunner } from '@notrealstudio/speak/node'

const stt = createGeminiTranscriber({ apiKey })                       // ядро: байты/uri → текст
const t = await stt.transcribe({ data: mp3, mime: 'audio/mp3' }, { language: 'ru', vocabulary: ['runz', 'nrlib'] })
// → { text, language, model, vocabulary: 2 }

const listener = listenerFromCtx(ctx, { ffmpeg: ffmpegRunner(), duration: (d) => audioDuration(d, ffprobeOf()) })
const m = await listener.transcribe(bytes, { diarize: true, vocabulary })   // любой формат, любой размер
// → { text, segments: [{start, end, text, speaker: 'A'|'B'…}], words, duration, attempts, truncated?, uploaded, converted }
```

`TranscribeOpts`: `language` (BCP-47; нет — автоопределение), `vocabulary` (до 1000 терминов,
`custom_vocabulary`), `segments` (таймстемпы слов → сегменты), `diarize` (спикеры, включает
таймстемпы). Сегменты — `segmentsOf(words)`: смена спикера, конец предложения, пауза > 1 с,
40 слов. Язык провайдер не отдаёт — заданный или по письменности (`guessLanguage`).
`sniffAudio(bytes)` — mime по сигнатуре (wav, mp3, ogg/opus, flac, webm, m4a, aac, aiff).

`/node`: `prepareAudio` — неопознанное → mp3 через ffmpeg; до `INLINE_MAX` (14 МБ) — inline,
больше — `uploadFile` (Files API, resumable) и `deleteFile` после; `audioDuration` — ffprobe
по временному файлу; `listenerFromCtx(ctx)` — ключ `## $provider google` (`$studio_provider`),
модель — `$listen_model` блока `## $speak` (`studio:gemini-3.5-transcribe`).

## Грабли

- Лимит Gemini — ~4000 **байт** на запрос: кириллица — 2 байта на букву, поэтому потолок куска
  и в символах, и в байтах.
- Edge с 12.2025 режет частые запросы по IP (403): движок шлёт строго по одному и на 403
  ждёт 5 и 20 с. Клиент `msedge-tts` грузится лениво.
- Chirp 3 HD по REST — только целиком (стрим — gRPC). API `texttospeech.googleapis.com` в
  проекте должен быть включён.
- Vertex своих голосов (`voice_…`) не видит: они только в AI Studio, маршрут —
  `createRoutedEngine`.
- Transcribe: `custom_vocabulary` провайдер не совмещает ни с диаризацией, ни с таймстемпами
  (400 «incompatible»), а диаризация без таймстемпов слов не отдаёт. Поэтому сегменты со
  словарём — два запроса разом (текст со словарём + слова с временем и спикерами без него) и
  `alignWords` (Нидлман — Вунш по словам): время и спикер переносятся на текст со словарём.
- Transcribe изредка обрывает ответ с таймстемпами при `status: completed` (слова до середины
  записи). `Listener` с `duration` сверяет последнее слово с длительностью и повторяет раз;
  не помогло — `truncated: true`. Реплики разных спикеров модель склеивает без пробела
  («стриминг.Всё») — `parseInteraction` вставляет его.
- AI Studio Tier 1 — 10 запросов в минуту на модель; с таймстемпами — до 30 мин звука.

## Тесты

`npm test` (vitest, моки HTTP/WebSocket, без сети), `npm run typecheck`. Живые прогоны — в
appz `speak` (`runz speak say …`).
