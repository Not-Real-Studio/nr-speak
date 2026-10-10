import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { blocksText, l0Markdown } from '../src/index.js'
import { bookToMarkdown, fb2ToMarkdown, pdfLayoutToMarkdown, sniffBook, tidyBook, xmlEncoding } from '../src/node/index.js'

const fx = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/books/${name}`, import.meta.url)))
const heads = (md: string): string[] => md.split('\n').filter((l) => /^#{1,6} /.test(l))

describe('fb2', () => {
  it('title-info, секции по вложенности, эпиграф и стихи, сноски и binary — прочь', () => {
    const b = fb2ToMarkdown(fx('rich.fb2'))
    expect(b.title).toBe('Пиковая дама (фикстура)')
    expect(b.author).toBe('Александр Сергеевич Пушкин')
    expect(heads(b.markdown)).toEqual(['# Пиковая дама (фикстура)', '## I', '### Вложенная секция', '## II'])
    expect(b.markdown).toContain('> А в ненастные дни  \n> Собирались они  \n> Часто.')
    expect(b.markdown).toContain('Мчатся тучи, вьются тучи;  \nНевидимкою луна')
    expect(b.markdown).toContain('Долгая *зимняя* ночь')
    expect(b.markdown).not.toContain('[1]')
    expect(b.markdown).not.toContain('Нарумов — гвардейский офицер')
    expect(b.markdown).not.toContain('iVBOR')
    // Через L0: строки стиха и абзацы — блоками, разметки нет.
    const text = blocksText(l0Markdown(b.markdown).blocks)
    expect(text).toContain('# II')
    expect(text).not.toMatch(/^>|\*\*Бесы|\*зимняя/m)
  })

  it('windows-1251 из XML-декларации; fb2.zip; сноски в конец по флагу', async () => {
    expect(xmlEncoding(fx('rich.cp1251.fb2'))).toBe('windows-1251')
    const cp = fb2ToMarkdown(fx('rich.cp1251.fb2'))
    expect(heads(cp.markdown)).toEqual(heads(fb2ToMarkdown(fx('rich.fb2')).markdown))
    expect(cp.markdown).toContain('Однажды играли в карты у конногвардейца Нарумова')
    const zip = zipSync({ 'book.fb2': fx('rich.fb2') })
    expect(sniffBook(zip)).toBe('fb2.zip')
    const z = await bookToMarkdown(zip, 'book.fb2.zip')
    expect(z.format).toBe('fb2.zip')
    expect(z.title).toBe('Пиковая дама (фикстура)')
    expect(fb2ToMarkdown(fx('rich.fb2'), { notes: true }).markdown).toContain('Нарумов — гвардейский офицер')
  })
})

/** epub в памяти: container.xml → OPF → nav, три главы (одна — служебная, одна без заголовка). */
function makeEpub(): Uint8Array {
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'OEBPS/content.opf': strToU8(
      '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Повести</dc:title><dc:creator>автор Александр Пушкин</dc:creator></metadata>' +
        '<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="t" href="title.xhtml" media-type="application/xhtml+xml"/><item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/c2.xhtml" media-type="application/xhtml+xml"/><item id="x" href="text/extra.xhtml" media-type="application/xhtml+xml"/></manifest>' +
        '<spine><itemref idref="t"/><itemref idref="c1"/><itemref idref="c2"/><itemref idref="x" linear="no"/></spine></package>',
    ),
    'OEBPS/nav.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc"><ol><li><a href="text/c1.xhtml">Выстрел</a></li><li><a href="text/c2.xhtml#s">Метель</a></li></ol></nav></body></html>'),
    'OEBPS/title.xhtml': strToU8('<html><body><h1>Титул</h1><p>Служебная страница.</p></body></html>'),
    'OEBPS/text/c1.xhtml': strToU8('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><h1>Выстрел</h1><p>Мы стояли в местечке<a href="#n1"><sup>1</sup></a>.</p><div id="sub"/><p>Стихи:<br/>строка два</p></body></html>'),
    'OEBPS/text/c2.xhtml': strToU8('<html><body><p>В конце 1811 года.</p><h2>Примечания</h2><p>1. Сноска.</p></body></html>'),
    'OEBPS/text/extra.xhtml': strToU8('<html><body><p>Вне spine.</p></body></html>'),
  })
}

describe('epub', () => {
  it('spine → главы; заголовок из nav, если в тексте нет; служебные и linear=no — прочь; сноски — прочь', async () => {
    const data = makeEpub()
    expect(sniffBook(data, 'x.epub')).toBe('epub')
    const b = await bookToMarkdown(data, 'x.epub')
    expect(b.title).toBe('Повести')
    expect(b.author).toBe('Александр Пушкин')
    expect(heads(b.markdown)).toEqual(['# Повести', '## Выстрел', '## Метель'])
    expect(b.markdown).toContain('Мы стояли в местечке.')
    expect(b.markdown).not.toMatch(/Служебная|Вне spine|Сноска/)
  })
})

describe('docx', () => {
  it('стили Heading — заголовки; без стилей — короткий жирный абзац; списки', async () => {
    const a = await bookToMarkdown(fx('smotritel.docx'), 'a.docx')
    expect(a.format).toBe('docx')
    expect(heads(a.markdown)).toContain('# Станционный смотритель')
    expect(a.markdown).toContain('Коллежский регистратор')
    const b = await bookToMarkdown(fx('metel-nostyles.docx'), 'b.docx')
    expect(heads(b.markdown).length).toBeGreaterThanOrEqual(1)
    expect(b.markdown).toMatch(/^- {1,3}Марья Гавриловна/m)
  })
})

describe('pdf', () => {
  const page = (n: number, body: string[]): string => ['   Пиковая дама', '', ...body, '', `            — ${n} —`].join('\n')

  it('колонтитулы и номера страниц — прочь; абзац по отступу; перенос через строку и страницу — склеен; глава — заголовок', () => {
    const text = [
      page(1, ['                 I', '', '    Однажды играли в карты у конно‐', 'гвардейца Нарумова. Долгая ночь', 'прошла незаметно.', '    Сели ужинать в пя-']),
      page(2, ['том часу утра. Те, кто', 'остался в выигрыше.', '    Германн был сын обрусевшего немца.']),
      page(3, ['    Третья страница текста.']),
      page(4, ['    Четвёртая страница.']),
    ].join('\f')
    expect(pdfLayoutToMarkdown(text, 'Пиковая дама')).toBe(
      ['# Пиковая дама', '## I', 'Однажды играли в карты у конногвардейца Нарумова. Долгая ночь прошла незаметно.', 'Сели ужинать в пятом часу утра. Те, кто остался в выигрыше.', 'Германн был сын обрусевшего немца.', 'Третья страница текста.', 'Четвёртая страница.'].join('\n\n'),
    )
  })

  const hasPoppler = (() => {
    try {
      execFileSync('pdftotext', ['-v'], { stdio: 'ignore', env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin` } })
      return true
    } catch {
      return false
    }
  })()

  it.skipIf(!hasPoppler)('сигнатура %PDF; скан без текста — честная ошибка', async () => {
    // Минимальный PDF: одна пустая страница, без шрифтов и текста.
    const pdf = strToU8(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
    )
    expect(sniffBook(pdf)).toBe('pdf')
    await expect(bookToMarkdown(pdf, 'scan.pdf')).rejects.toThrow('нет текстового слоя')
  })
})

describe('общее', () => {
  it('tidyBook: обвязка Gutenberg, «Примечания», оглавление ссылками; «Глава I» + название — одним заголовком', () => {
    const md = [
      '# Книга',
      'The Project Gutenberg eBook of X',
      '*** START OF THE PROJECT GUTENBERG EBOOK X ***',
      '- [Глава I](c1.xhtml)',
      '## ГЛАВА I',
      '## СЕРЖАНТ ГВАРДИИ',
      'Текст.',
      '### Примечания',
      '1. Сноска.',
      '## II',
      'Ещё.',
      '*** END OF THE PROJECT GUTENBERG EBOOK X ***',
      'License.',
    ].join('\n\n')
    expect(tidyBook(md)).toBe(['# Книга', 'The Project Gutenberg eBook of X', '## ГЛАВА I. СЕРЖАНТ ГВАРДИИ', 'Текст.', '## II', 'Ещё.'].join('\n\n'))
  })

  it('не книга — ошибка с перечнем форматов', async () => {
    expect(sniffBook(strToU8('просто текст'), 'a.txt')).toBeUndefined()
    await expect(bookToMarkdown(strToU8('просто текст'), 'a.txt')).rejects.toThrow('fb2, fb2.zip, epub, pdf, docx')
  })
})
