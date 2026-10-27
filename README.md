# @notrealstudio/speak

Текст → речь (и обратно) для любых проектов: движки за одним интерфейсом `TtsEngine` — Gemini 3.8 TTS
в Vertex AI (OAuth) и в AI Studio (ключ, свои голоса Voice design), маршрут по голосу между
ними, Google Cloud TTS Chirp 3 HD, Microsoft Edge read-aloud (бесплатно, без ключа), любой
OpenAI-совместимый `/v1/audio/speech` (локальный mlx-audio и подобные). Сверху — единый
каталог голосов с полными именами (`vertex:Kore`, `edge:ru-RU-SvetlanaNeural`) и резолвом
коротких, нормализатор L0 (markdown/html/текст → текст для слуха: без кода, ссылок, хэшей,
ключей и токенов, таблицы построчно), книги → markdown (fb2, epub, pdf, docx), нарезка на куски
под лимиты движков, синтез куска с кэшем по хэшу — потоком, по мере синтеза (первый звук до
конца куска) — и перекодирование в mp3/wav/opus/pcm через ffmpeg. Ядро без Node (HTTP — инъекцией `fetch`);
Node-половина (`/node`) — конфиг из цепочки runz, токен gcloud, кэш на диске, ffmpeg,
html → markdown через Defuddle.

## Быстрый старт

```ts
import { createSpeaker, l0Markdown, segment } from '@notrealstudio/speak'
import { bookToMarkdown, diskCache, enginesFromCtx, fileCache, ffmpegPipe, ffmpegRunner } from '@notrealstudio/speak/node'

const engines = enginesFromCtx(ctx, { cache: fileCache('voices.json', '.') }) // ctx — IContext runz
const speaker = createSpeaker({ engines, defaultVoice: 'vertex:Sulafat', favorites: ['Sulafat', 'Leda', 'Enceladus'], cache: diskCache('speak-cache'), ffmpeg: ffmpegRunner(), ffmpegPipe: ffmpegPipe() })
const { markdown, title } = await bookToMarkdown(bytes, 'book.fb2')   // fb2 / fb2.zip / epub / pdf / docx

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

**Без сети (DEV-513).** `say` — системный синтез macOS (`./node`: `createSayEngine`, голоса
`say -v '?'`, по умолчанию `Milena`, `$say_voice` блока `## $speak`); `enginesFromCtx` включает
его сам на darwin (`$engines` — выключить). Звук — WAV, темп — перекодировщиком. Piper — следующий
кандидат тем же контрактом (звучит лучше, но ставится отдельно).

**Свои серверы речи (DEV-520).** `omnivoice` (лаптоп, GPU) и `pocket` (m2, CPU) — сервер
`serve/local_tts.py` (`--engine omnivoice|pocket`; plist m2 — `serve/studio.pocket-tts.plist`,
лаптоп — `serve/omnivoice-serve.cmd` задачей при входе), поток PCM 24 кГц по предложениям.
`createLocalEngine({kind, baseUrl, loadSample})`; голос — путь к образцу (`omnivoice:~/…/denis-11s.wav`,
текст образца — соседний `.txt`; образец уходит на сервер один раз `PUT /v1/voices/<хэш>`, сервер
держит промпт в памяти), `design:<атрибуты>` (OmniVoice; у pocket — его голос по умолчанию), пусто —
голос сервера по умолчанию. Конфиг — `$omnivoice_url`, `$pocket_url` блока `## $speak`; оба есть —
`omnivoice` с автопереходом (`createFallbackEngine`): нет первого звука за `$omnivoice_first_ms`
(2000) или ошибка до первого звука — фраза уходит `pocket`, лаптоп пропускается
`$omnivoice_cooldown_ms` (60 000); `$omnivoice_fallback: off` — без перехода. Звук запасного
помечен `fallback` и в кэш кусков не ложится.

**Нормализатор L0.** `l0Markdown(md, opts)` / `l0Text(text, opts)` → `{title, blocks: [{kind, text}]}`;
`blocksText(blocks)` — текст для глаз (`--print`). Выкидывает frontmatter, картинки, адреса
ссылок, голые URL, сноски, HTML и мусор-токены (`stripTokens`, всегда): hex от 7 символов с
цифрой и буквой без верхней границы, сокращённые ключи `84b8…7760`, UUID, base64/base64url от 20
символов (оба регистра и цифра), ключи по префиксам `sk-`/`pk_`/`rk_`, `ghp_`/`gho_`/`github_pat_`,
`xoxb-`, `AIza…`, `ya29.`, JWT `eyJ…`, `Bearer <токен>`, адрес без схемы с `?key=`/`token=` —
целиком; «ключ: <токен>» → «ключ»; блок кода —
«Пропущен блок кода.» (`code: 'skip'` — ничего); инлайн-код — слово текстом, путь/флаг по
`inlineCode: read|announce|skip`; таблицы gfm и box-drawing — до 4×8 построчно
«строка: колонка — значение; …», больше — «Таблица, N строк, колонки: …»
(`tables: rows|announce|skip`); списки — предложениями. Числа не трогает (это L1).
Node: `normalize(src, 'text'|'markdown'|'html', opts)`, `htmlToMarkdown(html, url)` (Defuddle +
linkedom), `formatOf(name)`.

**Куски.** `segment(blocks, {maxChars=1500, maxBytes=3600, first=250, second?})` → `[{text, kind}]`
(`second` — разгон 250 → 400 → потолок):
заголовок — отдельный кусок, первый — короткий, режет по абзацам → предложениям → запятым →
пробелам. `segmentText(text)` — для простого текста.

**Звук.** `createSpeaker({engines, defaultVoice, cache?, ffmpeg?})`: `synth(text, req, format)`
— один кусок, ключ кэша `sha256(engine|voice|instruct|speed|text).<формат>`, повтор — без
синтеза (`stats: {synth, hits}`); `stream(texts, req, format)` — куски подряд: кусок не из кэша
идёт **потоком** — кадры движка (PCM Gemini) → `ffmpegPipe` (`-flush_packets 1`) → наружу сразу,
копия ложится в кэш по завершении (клиент ушёл посреди — ffmpeg и движок обрываются, кэш не
пишется); mp3 движка (Edge) — без ffmpeg; без `ffmpegPipe` — кусок целиком, как раньше;
следующий кусок синтезируется заранее, с первого звука текущего; ошибка до первого байта —
исключением из первого `next()` (wav — один стримовый заголовок, `finalizeWav` чинит размеры
для файла). `convert(audio, format, {speed, ffmpeg})`: mp3 → mp3 и PCM ↔ wav/pcm без
ffmpeg, остальное — ffmpeg (`ffmpegArgs`, темп — `atempo`).

**Node.** `enginesFromCtx(ctx, {cache})` — движки из `~/.runz/config.md`: `vertex` и `chirp` —
`## $provider vertex` с `$project` (токен `gcloud auth application-default print-access-token`,
`$gcloud` — путь), `studio` — `## $provider google` с `$api_key`, `edge` — всегда, `openai` —
`$openai_provider` блока `## $speak` → `## $provider <имя>` (`$base_url`, `$model`, `$api_key`;
модель — `$openai_model` блока `## $speak`, если у провайдера своей нет — llm-gate; звук приходит
потоком — куски по мере ответа сервера, PCM по чётной границе),
`$engines` — явный список. `engineFromCtx`/`providerOf`/`gcloudToken`/`fileCache` — прежний
выбор одного движка сервиса voice nrchat (`$voice_provider`). `diskCache(dir)`,
`ffmpegRunner(bin?)`, `ffmpegPipe(bin?)` (труба для потока).

**Книги (Node).** `sniffBook(bytes, name?)` — формат по сигнатуре (`%PDF`; zip: epub —
`META-INF/container.xml`, docx — `word/document.xml`, fb2.zip — `*.fb2`; `<FictionBook`), затем
`bookToMarkdown(bytes, name?, {notes?, pdftotext?}) → {format, title, author?, markdown}` (до 50 МБ,
`BOOK_MAX_BYTES`); книга — `#`, главы — `##`… по вложенности; `tidyBook` снимает обвязку Project
Gutenberg, разделы «Примечания», оглавления ссылками на файлы и склеивает «Глава I» + название.
- `fb2ToMarkdown` — свой разбор (linkedom, XML): кодировка из декларации (utf-8, windows-1251),
  `section/title` по вложенности, `p`, `emphasis`/`strong`, `poem/stanza/v` — строками, `epigraph`/
  `cite` — цитатой, `subtitle`, таблицы; `binary` и сноски — прочь (`notes: true` — в конец);
  главы абзацем (`<p><strong>Глава II</strong></p>`) — заголовками.
- `epubToMarkdown` — fflate + OPF: метаданные, spine (без `linear="no"`, без служебных
  `title/about/cover/pg-header…`), заголовок главы из nav/NCX, если в тексте его нет;
  xhtml → markdown — `htmlToMd` (turndown; самозакрытые теги XHTML раскрываются, сноски `<sup>` —
  прочь, заголовки `role="heading"` Wikisource).
- `docxToMarkdown` — mammoth → html → turndown; без стилей — короткий жирный абзац = заголовок.
- `pdfToMarkdown` — `pdftotext -layout` (poppler) → `pdfLayoutToMarkdown` (чистая): колонтитулы
  (повтор строк сверху/снизу на ≥30 % страниц) и номера страниц — прочь, абзац — по отступу и
  пустой строке, переносы (`‐`, мягкий, `-` перед строчной) — склеить, в т.ч. через страницу;
  меньше 20 букв на страницу — `NO_TEXT_LAYER` («нет текстового слоя (скан), OCR не поддерживается»).

## Распознавание

Обратное направление — речь → текст: Gemini 3.5 Transcribe (`gemini-3.5-transcribe`) через
Gemini API (AI Studio, ключ), Interactions API `POST /v1beta/interactions`; та же модель на
Vertex AI (`createVertexTranscriber`, OAuth-токен проекта) — `generateContent` с
`generationConfig.audioTranscriptionConfig`.

```ts
import { createGeminiTranscriber, createVertexTranscriber } from '@notrealstudio/speak'
import { listenerFromCtx, audioDuration, ffprobeOf, ffmpegRunner, gcloudToken } from '@notrealstudio/speak/node'

const stt = createGeminiTranscriber({ apiKey })                       // ядро: байты/uri → текст
const t = await stt.transcribe({ data: mp3, mime: 'audio/mp3' }, { language: 'ru', vocabulary: ['runz', 'nrlib'] })
// → { text, language, model, vocabulary: 2 }

const vx = createVertexTranscriber({ project, token: gcloudToken() })  // gemini-3.5-transcribe-preview, global

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
по временному файлу; `listenerFromCtx(ctx, {model?, retries?})` — модель `$listen_model` блока
`## $speak` или `model`: `studio:…` — ключ `## $provider google` (`$studio_provider`), `vertex:…` —
`$project`/`$location`/`$gcloud` провайдера `## $provider vertex` (`$vertex_provider`), звук только
inline (больше `INLINE_MAX` — ошибка 413). `parseListenModel('vertex:')` →
`{engine: 'vertex', model: 'gemini-3.5-transcribe-preview'}`; `listenerOver(engine, prefix, opts)` —
Listener над любым `SttEngine`. `retries: 0` — 429 сразу ошибкой (у потребителя есть фолбэк).
`openai:<модель>` (DEV-283) — OpenAI-совместимый `/v1/audio/transcriptions` (llm-gate: алиас
`$output: transcribe`, фолбэк — на гейте): провайдер `$listen_provider` ?? `$openai_provider`
(`$base_url`, `$api_key`), multipart `verbose_json` + слова, словарь — `prompt`, `diarize`;
до 25 МБ (`OPENAI_INLINE_MAX`). Без модели — ошибка. Клиент — `createOpenAITranscriber({baseUrl, apiKey?, model})`.

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
- AI Studio Tier 1 — 10 запросов в минуту на модель и 100 в сутки; с таймстемпами — до 30 мин звука.
- Transcribe на Vertex (09.10.2026): GA-имя `gemini-3.5-transcribe` проекту — 404 во всех
  локациях, работает `gemini-3.5-transcribe-preview` в `global` (v1beta1). Interactions API у
  Vertex модель не берёт («Unsupported model interaction»). Лимит — токены звука в минуту (~25
  на секунду звука), 429 «Resource has been exhausted» без срока — повторы с паузами 2/6/18 с.
  Словарь с диаризацией Vertex принимает, но теряет половину текста — та же схема двух проходов.
  Ответ: часть на реплику, `audioTranscription: {text, speakerLabel, words: [{word, startOffset,
  endOffset}]}` — `parseVertex`.

- Книги: epub по spec не обязан иметь заголовки в тексте глав — они берутся из nav/NCX; у
  linkedom в режиме `text/xml` `getElementsByTagName('*')` пуст — только `querySelectorAll`;
  самозакрытые `<div/>` XHTML в `text/html` ломают дерево — раскрываются до разбора. pdf без
  poppler — ошибка запуска с подсказкой `brew install poppler`; `pdfjs` не взят (35 МБ, теряет
  мягкие переносы и порядок колонтитулов).
- Поток: `-flush_packets 1` обязателен — без него муксер mp3 держит кадры, и первый байт
  приходит почти с концом куска.

## Тесты

`npm test` (vitest, моки HTTP/WebSocket, без сети), `npm run typecheck`. Живые прогоны — в
appz `speak` (`runz speak say …`).
