import { describe, expect, it } from 'vitest'
import { blocksText, cleanInline, inlineCode, l0Markdown, l0Text, parseBoxTable, stripTokens, tableText } from '../src/index.js'

const md = (s: string, o = {}): string => blocksText(l0Markdown(s, o).blocks)

describe('L0: markdown', () => {
  it('frontmatter, картинки, html-комменты, сноски — выкидываются; ссылка → текст; голый URL — прочь', () => {
    const src = [
      '---',
      'title: x',
      '---',
      '# Заголовок',
      '',
      'Текст со [ссылкой](https://example.com/a) и сноской[^1]. ![картинка](a.png) <!-- коммент -->',
      'Адрес https://example.com/x?y=1 в тексте и [https://example.com](https://example.com).',
      '',
      '[^1]: Сноска.',
    ].join('\n')
    expect(md(src)).toBe('# Заголовок\n\nТекст со ссылкой и сноской. Адрес в тексте и.')
  })

  it('блок кода — фраза или ничего', () => {
    const src = 'До.\n\n```ts\nconst a = 1\n```\n\nПосле.'
    expect(md(src)).toBe('До.\n\nПропущен блок кода.\n\nПосле.')
    expect(md(src, { code: 'skip' })).toBe('До.\n\nПосле.')
  })

  it('инлайн-код: слово — текстом; путь/флаг — по политике', () => {
    expect(md('Вызови `fetch` и `runz-run`.')).toBe('Вызови fetch и runz-run.')
    expect(md('Файл `~/.runz/config.md` и флаг `--print`.')).toBe('Файл runz config.md и флаг print.')
    expect(md('Файл `~/.runz/config.md`.', { inlineCode: 'announce' })).toBe('Файл код.')
    expect(md('Файл `~/.runz/config.md`.', { inlineCode: 'skip' })).toBe('Файл.')
    expect(inlineCode('a3f9c21')).toBe('')
    expect(inlineCode('UND_ERR_HEADERS_TIMEOUT')).toBe('UND ERR HEADERS TIMEOUT')
  })

  it('хэши — прочь (с цифрой и буквой); числа и слова — нет', () => {
    expect(cleanInline('коммит (ef31633) ушёл, хэш dad59e6f, число 1234567, слово deadbeef, тире — ef31633, конец')).toBe(
      'коммит ушёл, хэш, число 1234567, слово deadbeef, тире, конец',
    )
    expect(cleanInline('Текст[1] с пометкой[уточнить] и [источник не указан 100 дней].')).toBe('Текст с пометкой и.')
  })

  it('мусор-токены (DEV-250 §2): ключи любой длины, префиксы, JWT, UUID, base64, ?key=', () => {
    // Кейс приёмки DEV-248: ключ из 48 hex читался посимвольно.
    const key = '84b871fc0a1e9d3c55b2e7f4a6c8d0e1f3a5b7c9d1e3f5a77606'
    expect(cleanInline(`Новый ключ: ${key}, сохрани его.`)).toBe('Новый ключ, сохрани его.')
    expect(cleanInline('Ключ 84b871fc…77606 в конфиге.')).toBe('Ключ в конфиге.')
    expect(cleanInline('Открой https://speak.notreal.studio/tts?key=abc123XYZ&text=привет и speak.notreal.studio/tts?key=s3cr3t&voice=Kore — работает.')).toBe('Открой и — работает.')
    expect(cleanInline('Токен OpenAI: sk-proj-AbCdEf1234567890xyz, GitHub ghp_16C7e42F292c6912E7710c838347Ae178B4a, Slack xoxb-123456-abcdef.')).toBe('Токен OpenAI, GitHub, Slack.')
    expect(cleanInline('Заголовок Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc123 и всё.')).toBe('Заголовок Authorization и всё.')
    expect(cleanInline('JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig_x в куке.')).toBe('JWT в куке.')
    expect(cleanInline('Google AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY и ya29.a0AfH6SMBx1234567890.')).toBe('Google и.')
    expect(cleanInline('UUID 123e4567-e89b-12d3-a456-426614174000 записи.')).toBe('UUID записи.')
    expect(cleanInline('base64: dGhpcyBpcyBhIHNlY3JldCBrZXkgMTIz== конец.')).toBe('base64 конец.')
    expect(cleanInline('Сессия ksacxf8kk2p5x7q9w3e1r5t8y2u4 — своя.')).toBe('Сессия — своя.')
    // Не мусор: слова, числа, имена моделей, CamelCase, пакеты.
    const keep = 'Слова остаются: deadbeef, 1234567, gemini-3.5-transcribe-preview, TranscribeAudio, nr-speak, sk-1, DEV-250.'
    expect(cleanInline(keep)).toBe(keep)
    expect(stripTokens('без токенов')).toBe('без токенов')
  })

  it('мусор-токены в инлайн-коде и markdown', () => {
    expect(md('Ключ: `84b871fc0a1e9d3c55b2e7f4a6c8d0e1f3a5b7c9d1e3f5a77606`.')).toBe('Ключ.')
    expect(md('Вызов `sk-abc123def456ghi` и [панель](https://x.io/?token=abc).')).toBe('Вызов и панель.')
    expect(inlineCode('ghp_16C7e42F292c6912E7710c838347Ae178B4a')).toBe('')
  })

  it('списки → предложения; вложенные — подряд', () => {
    expect(md('Итог:\n\n- первое\n- второе\n  - вложенное\n- третье!')).toBe('Итог:\n\nпервое. второе. вложенное. третье!')
  })

  it('gfm-таблица: маленькая — построчно, большая — объявить; режимы', () => {
    const small = '| | басис | окно |\n|---|---|---|\n| RTP | 96.1 % | 96–96.2 |\n| Хит | 24 % | 23–27 |'
    expect(md(small)).toBe('RTP: басис — 96.1 %; окно — 96–96.2. Хит: басис — 24 %; окно — 23–27.')
    expect(md(small, { tables: 'announce' })).toBe('Таблица, 2 строки, колонки: басис, окно.')
    expect(md(small, { tables: 'skip' })).toBe('')
    const wide = '| a | b | c | d | e |\n|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 |'
    expect(md(wide)).toBe('Таблица, 1 строка, колонки: a, b, c, d, e.')
    const tall = '| a | b |\n|---|---|\n' + Array.from({ length: 9 }, (_, i) => `| ${i} | x |`).join('\n')
    expect(md(tall)).toBe('Таблица, 9 строк, колонки: a, b.')
  })

  it('box-drawing таблица посреди markdown', () => {
    const src = ['Таргеты:', '', '┌──────┬──────┐', '│      │ окно │', '├──────┼──────┤', '│ RTP  │ 96   │', '├──────┼──────┤', '│ Хит  │ 23   │', '└──────┴──────┘', '', 'Дальше.'].join('\n')
    expect(md(src)).toBe('Таргеты:\n\nRTP: окно — 96. Хит: окно — 23.\n\nДальше.')
    expect(parseBoxTable(['│ a │ b │', '├───┼───┤', '│ 1 │ 2 │'])).toEqual([['a', 'b'], ['1', '2']])
  })

  it('цитата → абзацы; заголовок документа — первый заголовок или первое предложение', () => {
    const r = l0Markdown('> Важно: это цитата. Вторая фраза.\n\nТекст.')
    expect(r.blocks).toEqual([
      { kind: 'quote', text: 'Важно: это цитата. Вторая фраза.' },
      { kind: 'para', text: 'Текст.' },
    ])
    expect(r.title).toBe('Важно: это цитата.')
    expect(l0Markdown('# Глава\n\nТекст.').title).toBe('Глава')
  })

  it('числа не трогаются', () => {
    expect(md('RTP 96.153 %, 1/80.10, 0.008 п.п., ±0.16.')).toBe('RTP 96.153 %, 1/80.10, 0.008 п.п., ±0.16.')
  })
})

describe('L0: простой текст', () => {
  it('абзацы, box-таблица, чистка; markdown не разбирается', () => {
    const r = l0Text('Раз *два*\nтри.\n\n┌──┬──┐\n│ a│ b│\n├──┼──┤\n│ 1│ 2│\n└──┴──┘\nКонец https://x.io.')
    expect(r.blocks).toEqual([
      { kind: 'para', text: 'Раз *два* три.' },
      { kind: 'table', text: '1: b — 2.' },
      { kind: 'para', text: 'Конец.' },
    ])
  })

  it('tableText: одна колонка, пустые ячейки', () => {
    expect(tableText([['имя'], ['Аня'], ['Боря']])).toBe('Аня. Боря.')
    expect(tableText([['', 'x', 'y'], ['a', '', '2']])).toBe('a: y — 2.')
  })
})
