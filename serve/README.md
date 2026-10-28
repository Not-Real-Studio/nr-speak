# serve — свои серверы речи (DEV-520)

`local_tts.py` — один сервер на два движка speak: `omnivoice` (k2-fsa/OmniVoice, fp16, GPU) и
`pocket` (PocketTTS-RU Shtorm, CPU, ударения silero-stress). API и протокол — шапка файла; клиент —
`createLocalEngine` (`src/local.ts`), конфиг — `$omnivoice_url`, `$pocket_url` блока `## $speak`.
`bench.py` — замер на месте (RTF, первый звук, память, температура и тротлинг GPU).

## Где стоит

| машина | движок | порт | как запущен | данные |
|---|---|---|---|---|
| m2 (`100.73.94.99`) | pocket | 8096 | launchd `studio.pocket-tts` (`studio.pocket-tts.plist`) | `~/nr/tts` (venv, `data/voices`, `hf`), лог `~/nr/logs/pocket-tts.log` |
| laptop (`100.116.193.14`) | omnivoice | 8095 | задача планировщика `studio-omnivoice` при входе → `omnivoice-serve.cmd` (цикл перезапуска) | `E:\nr\tts` (venv, `data\voices`, `hf`), лог `E:\nr\tts\omnivoice.log` |

Установка: m2 — `uv venv ~/nr/tts/venv --python 3.12` + `uv pip install pocket-tts soundfile torch silero-stress numpy`;
лаптоп — `install-omnivoice.cmd` (кэши uv/HF/TEMP — на E:, на C: места нет). Обновить сервер — скопировать
`local_tts.py` (m2 — `scp` + `launchctl kickstart -k gui/$(id -u)/studio.pocket-tts`; лаптоп — ssh не пускает,
через nr-mcp laptop), перезапуск лаптопа — закрыть окно `studio-omnivoice` и запустить задачу.

## Замеры 27.10.2026

| | pocket, m2 (CPU) | omnivoice, laptop (RTX 3060 Laptop) |
|---|---|---|
| RTF, медиана | 0.17 (304 фразы за 4 мин, 0 ошибок) | 6.5 (8 фраз за 5 мин) |
| первый звук на сервере | 51 мс (p90 55) | 18.5 с медиана |
| первый звук через speak с m4, mp3 | ~110–140 мс | — (переход на pocket за 1.5 с) |
| память | RSS 1.15–1.7 ГБ, своп m2 не растёт | VRAM 5.0 ГБ из 6 |
| температура | — | 92–95 °C, SM 210 МГц из 2100, тротлинг `0x20` (SW thermal) во всех 33 замерах, в простое тоже |

Лаптоп до ремонта охлаждения для голоса не годится: OmniVoice в 35 раз медленнее, чем на
4060 Ti у DEV-517. Цепочка работает и так — omnivoice не даёт звука за порог, фраза уходит pocket.

Грабли: `ProcessType Background` в plist на m2 сажает процесс на E-ядра — RTF 1.0 вместо 0.17;
RUAccent (DEV-517) на свежих transformers падает (`token_type_ids`) и держит 3+ ГБ — заменён
silero-stress; односложным словам ударение снимается.

## Включено 28.10.2026

`~/.runz/config.md` на m4, блок `## $speak` (копия до правки — `/tmp/runz-config.bak-1754`): `$omnivoice_url`,
`$pocket_url` и голос по умолчанию `$voice: omnivoice:~/Studio/data/voice-lab/local/samples/denis-11s.wav`
(клон Denis, omnivoice → pocket), было `openai:vertex:Sulafat`; Google — выбором голоса. `studio.speak`
перезапущен (до этого жил с 22.10, без DEV-513/520). После слияния правки speaker.ts можно писать `$voice: @denis-local`.

Через speak на m4 (mp3, первый байт): первая фраза 2.1 с (лаптоп в тротлинге, переход на pocket по порогу 1.5 с),
следующие 0.20–0.21 с (лаптоп в паузе 5 мин, сразу pocket), `@denis-pocket` 0.12 с, `openai:vertex:Sulafat` 3.7 с.
e2e-live `acceptance-voice-rp` (VRP-1, «Разговор» в RP) на lab — passed.
