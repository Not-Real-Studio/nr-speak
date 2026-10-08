import { describe, expect, it } from 'vitest'
import { blocksText, cleanInline, inlineCode, l0Markdown, l0Text, parseBoxTable, tableText } from '../src/index.js'

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
