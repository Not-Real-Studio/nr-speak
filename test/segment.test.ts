import { describe, expect, it } from 'vitest'
import { bytes, segment, segmentText, sentences } from '../src/index.js'

const sentence = (n: number, len = 80): string => `Предложение номер ${n} ${'слово '.repeat(Math.max(0, Math.floor((len - 30) / 6)))}конец.`

describe('сегменты', () => {
  it('первый кусок короткий, дальше — до потолка; слова не рвутся', () => {
    const para = Array.from({ length: 40 }, (_, i) => sentence(i)).join(' ')
    const segs = segment([{ kind: 'para', text: para }], { first: 200, maxChars: 1000 })
    expect(segs[0]!.text.length).toBeLessThanOrEqual(200 + 90)
    expect(segs[0]!.text.length).toBeGreaterThan(50)
    for (const s of segs.slice(1)) expect(s.text.length).toBeLessThanOrEqual(1000)
    expect(segs.map((s) => s.text).join(' ')).toBe(para)
  })

  it('заголовок — отдельный кусок с точкой (он же короткий первый); абзацы склеиваются, пока влезают', () => {
    const segs = segment(
      [
        { kind: 'heading', text: 'Глава 1' },
        { kind: 'para', text: 'Короткий абзац.' },
        { kind: 'para', text: 'Ещё один.' },
        { kind: 'heading', text: 'Итог?' },
        { kind: 'para', text: 'Всё.' },
      ],
      { first: 10 },
    )
    expect(segs).toEqual([
      { text: 'Глава 1.', kind: 'heading' },
      { text: 'Короткий абзац.\n\nЕщё один.', kind: 'text' },
      { text: 'Итог?', kind: 'heading' },
      { text: 'Всё.', kind: 'text' },
    ])
  })

  it('потолок в байтах: кириллица — 2 байта на букву', () => {
    const para = Array.from({ length: 30 }, (_, i) => sentence(i, 200)).join(' ')
    for (const s of segment([{ kind: 'para', text: para }], { maxChars: 5000, maxBytes: 1000 })) expect(bytes(s.text)).toBeLessThanOrEqual(1000)
  })

  it('предложение длиннее потолка — режется по запятым, затем по пробелам; одно длинное слово — по символам', () => {
    const long = Array.from({ length: 20 }, (_, i) => `часть ${i} текста`).join(', ') + '.'
    const segs = segment([{ kind: 'para', text: long }], { maxChars: 60, first: 60 })
    for (const s of segs) expect(s.text.length).toBeLessThanOrEqual(60)
    expect(segs.map((s) => s.text).join(' ')).toBe(long)
    const word = 'x'.repeat(150)
    expect(segment([{ kind: 'para', text: word }], { maxChars: 60 }).map((s) => s.text.length)).toEqual([60, 60, 30])
  })

  it('предложения: точка, вопрос, многоточие, кавычка после точки', () => {
    expect(sentences('Раз. Два? Три… «Четыре.» Пять!')).toEqual(['Раз.', 'Два?', 'Три…', '«Четыре.»', 'Пять!'])
  })

  it('простой текст — абзацы по пустой строке', () => {
    expect(segmentText('Один.\n\nДва.', { first: 3 }).map((s) => s.text)).toEqual(['Один.', 'Два.'])
  })

  it('разгон: первый ~250, второй до 400, дальше — потолок (DEV-250 §6)', () => {
    const text = Array.from({ length: 60 }, (_, i) => `Предложение номер ${i + 1} про поток звука.`).join(' ')
    const segs = segmentText(text, { first: 250, second: 400, maxChars: 700 }).map((x) => x.text.length)
    expect(segs[0]).toBeLessThanOrEqual(260)
    expect(segs[1]).toBeLessThanOrEqual(400)
    expect(segs[1]).toBeGreaterThan(300)
    expect(Math.max(...segs.slice(2))).toBeLessThanOrEqual(700)
    expect(segs[2]).toBeGreaterThan(600)
  })
})
