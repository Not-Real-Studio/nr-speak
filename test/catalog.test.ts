import { describe, expect, it } from 'vitest'
import { catalog, matchVoice, resolveVoice } from '../src/index.js'
import { mockEngine } from './helpers.js'

const engines = () => ({
  vertex: mockEngine({ kind: 'vertex', voices: ['Kore', 'Puck'] }).engine,
  studio: mockEngine({ kind: 'gemini', voices: ['voice_abc'] }).engine,
  chirp: mockEngine({ kind: 'chirp', voices: ['ru-RU-Chirp3-HD-Aoede', 'ru-RU-Chirp3-HD-Kore'] }).engine,
  edge: mockEngine({ kind: 'edge', voices: ['ru-RU-SvetlanaNeural', 'ru-RU-DmitryNeural'] }).engine,
})

describe('резолв голосов', () => {
  it('полное имя с префиксом; короткое — Vertex → Studio → Chirp → Edge', async () => {
    const e = engines()
    expect(await resolveVoice(e, 'vertex:Kore')).toEqual({ engine: 'vertex', voice: 'Kore' })
    expect(await resolveVoice(e, 'Kore')).toEqual({ engine: 'vertex', voice: 'Kore' })
    expect(await resolveVoice(e, 'kore')).toEqual({ engine: 'vertex', voice: 'Kore' })
    expect(await resolveVoice(e, 'voice_abc')).toEqual({ engine: 'studio', voice: 'voice_abc' })
    expect(await resolveVoice(e, 'chirp:Aoede')).toEqual({ engine: 'chirp', voice: 'ru-RU-Chirp3-HD-Aoede' })
    expect(await resolveVoice(e, 'ru-RU-Chirp3-HD-Kore')).toEqual({ engine: 'chirp', voice: 'ru-RU-Chirp3-HD-Kore' })
    expect(await resolveVoice(e, 'Svetlana')).toEqual({ engine: 'edge', voice: 'ru-RU-SvetlanaNeural' })
    expect(await resolveVoice(e, 'edge:Dmitry')).toEqual({ engine: 'edge', voice: 'ru-RU-DmitryNeural' })
  })

  it('пусто — голос по умолчанию; явный движок; ошибки — понятные', async () => {
    const e = engines()
    expect(await resolveVoice(e, '', { defaultVoice: 'vertex:Kore' })).toEqual({ engine: 'vertex', voice: 'Kore' })
    expect(await resolveVoice(e, '', { engine: 'edge' })).toEqual({ engine: 'edge', voice: '' })
    expect(await resolveVoice(e, 'Svetlana', { engine: 'edge' })).toEqual({ engine: 'edge', voice: 'ru-RU-SvetlanaNeural' })
    await expect(resolveVoice(e, 'Nobody')).rejects.toThrow(/не найден ни в одном движке/)
    await expect(resolveVoice(e, 'openai:x')).rejects.toThrow(/движок «openai» не настроен/)
    await expect(resolveVoice(e, 'edge:Nobody')).rejects.toThrow(/у движка edge нет голоса/)
    await expect(resolveVoice(e, '')).rejects.toThrow(/голоса по умолчанию нет/)
    // Без Vertex «Kore» ищется дальше — в Chirp.
    const { vertex: _, ...noVertex } = e
    expect(await resolveVoice(noVertex, 'Kore')).toEqual({ engine: 'chirp', voice: 'ru-RU-Chirp3-HD-Kore' })
  })

  it('неоднозначная часть имени — ошибка со списком', () => {
    expect(() => matchVoice(['ru-RU-A-x', 'en-US-A-y'], 'a')).toThrow(/неоднозначен/)
  })
})

describe('каталог', () => {
  it('полные имена, тиры, упавший движок — в errors', async () => {
    const e = { ...engines(), studio: mockEngine({ voices: [] }).engine }
    e.studio.voices = async () => {
      throw new Error('нет ключа')
    }
    const { voices, errors } = await catalog(e)
    expect(voices.find((v) => v.id === 'vertex:Kore')).toMatchObject({ engine: 'vertex', voice: 'Kore', tier: 'premium' })
    expect(voices.find((v) => v.id === 'edge:ru-RU-SvetlanaNeural')).toMatchObject({ tier: 'free' })
    expect(voices.find((v) => v.id === 'chirp:ru-RU-Chirp3-HD-Aoede')).toMatchObject({ tier: 'free' })
    expect(errors).toEqual([{ engine: 'studio', error: 'нет ключа' }])
    expect((await catalog(e, { engine: 'edge' })).voices.map((v) => v.id)).toEqual(['edge:ru-RU-DmitryNeural', 'edge:ru-RU-SvetlanaNeural'])
  })
})
