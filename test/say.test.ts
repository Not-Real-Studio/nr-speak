import { describe, expect, it } from 'vitest'
import { createSayEngine, parseSayVoices } from '../src/node/say.js'
import { resolveVoice } from '../src/catalog.js'

const OUT = 'Milena              ru_RU    # Здравствуйте! Меня зовут Милена.\nAlex                en_US    # Most people recognize me by my voice.\nEddy (Russian (Russia)) ru_RU    # Привет!\n'

describe('say (DEV-513)', () => {
  it('каталог голосов из say -v ?', () => {
    expect(parseSayVoices(OUT).map((v) => [v.id, v.lang])).toEqual([
      ['Milena', 'ru-RU'],
      ['Alex', 'en-US'],
      ['Eddy (Russian (Russia))', 'ru-RU'],
    ])
  })

  it('синтез — WAV из временного файла, голос по умолчанию Milena', async () => {
    const calls: string[][] = []
    const e = createSayEngine({
      exec: async (_bin, args) => {
        calls.push(args)
        if (args[0] === '-v' && args[1] === '?') return OUT
        const { writeFile } = await import('node:fs/promises')
        await writeFile(args[args.indexOf('-o') + 1]!, new Uint8Array(100))
        return ''
      },
    })
    const chunks = []
    for await (const c of e.speak('привет', '', {})) chunks.push(c)
    expect(chunks[0]!.mime).toBe('audio/wav')
    expect(calls[0]!.slice(0, 2)).toEqual(['-v', 'Milena'])
    expect(await resolveVoice({ say: e }, 'say:milena')).toEqual({ engine: 'say', voice: 'Milena' })
  })
})
