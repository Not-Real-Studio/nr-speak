# @notrealstudio/speak

Текст → речь для любых проектов: движки за одним интерфейсом `TtsEngine` — Gemini 3.8 TTS
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
const speaker = createSpeaker({ engines, defaultVoice: 'vertex:Kore', cache: diskCache('speak-cache'), ffmpeg: ffmpegRunner() })

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
— тиры: `vertex` premium, `studio` cheap, `chirp`/`edge` free, `openai` local; упавший
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

## Грабли

- Лимит Gemini — ~4000 **байт** на запрос: кириллица — 2 байта на букву, поэтому потолок куска
  и в символах, и в байтах.
- Edge с 12.2025 режет частые запросы по IP (403): движок шлёт строго по одному и на 403
  ждёт 5 и 20 с. Клиент `msedge-tts` грузится лениво.
- Chirp 3 HD по REST — только целиком (стрим — gRPC). API `texttospeech.googleapis.com` в
  проекте должен быть включён.
- Vertex своих голосов (`voice_…`) не видит: они только в AI Studio, маршрут —
  `createRoutedEngine`.

## Тесты

`npm test` (vitest, моки HTTP/WebSocket, без сети), `npm run typecheck`. Живые прогоны — в
appz `speak` (`runz speak say …`).
