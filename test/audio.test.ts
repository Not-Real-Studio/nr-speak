import { describe, expect, it } from 'vitest'
import { atempo, concat, convert, ffmpegArgs, finalizeWav, parseWav, wavHeader } from '../src/index.js'

const PCM = 'audio/l16; rate=24000; channels=1'

describe('аудио', () => {
  it('WAV: заголовок ↔ разбор; стримовый заголовок → честные размеры', () => {
    const pcm = new Uint8Array([1, 2, 3, 4])
    const wav = concat([wavHeader(24000, 4), pcm])
    expect(parseWav(wav)).toEqual({ pcm, rate: 24000 })
    const streamed = finalizeWav(concat([wavHeader(24000), pcm]))
    const v = new DataView(streamed.buffer)
    expect(v.getUint32(40, true)).toBe(4)
    expect(v.getUint32(4, true)).toBe(40)
  })

  it('без ffmpeg: mp3 → mp3, PCM → wav/pcm, wav → pcm', async () => {
    const mp3 = new Uint8Array([9, 9])
    expect(await convert({ data: mp3, mime: 'audio/mpeg' }, 'mp3')).toBe(mp3)
    const pcm = new Uint8Array([1, 2])
    expect(await convert({ data: pcm, mime: PCM }, 'pcm')).toEqual(pcm)
    expect(parseWav(await convert({ data: pcm, mime: PCM }, 'wav')).pcm).toEqual(pcm)
    expect(await convert({ data: concat([wavHeader(24000, 2), pcm]), mime: 'audio/wav' }, 'pcm')).toEqual(pcm)
  })

  it('нужен ffmpeg — понятная ошибка; с ffmpeg — аргументы по mime, формату и темпу', async () => {
    await expect(convert({ data: new Uint8Array(2), mime: PCM }, 'mp3')).rejects.toThrow(/нужен ffmpeg/)
    const seen: string[][] = []
    const ffmpeg = async (args: string[]): Promise<Uint8Array> => {
      seen.push(args)
      return new Uint8Array([7])
    }
    expect(await convert({ data: new Uint8Array(2), mime: PCM }, 'mp3', { ffmpeg })).toEqual(new Uint8Array([7]))
    expect(seen[0]).toEqual(['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0', '-c:a', 'libmp3lame', '-b:a', '64k', '-ar', '24000', '-ac', '1', '-f', 'mp3', 'pipe:1'])
    // mp3 с темпом — через ffmpeg; wav на выходе — с заголовком.
    await convert({ data: new Uint8Array(2), mime: 'audio/mpeg' }, 'mp3', { ffmpeg, speed: 1.5 })
    expect(seen[1]).toContain('atempo=1.5')
    const wav = await convert({ data: new Uint8Array(2), mime: 'audio/mpeg' }, 'wav', { ffmpeg })
    expect(parseWav(wav).pcm).toEqual(new Uint8Array([7]))
    expect(ffmpegArgs('audio/mpeg', 'opus')).toContain('libopus')
  })

  it('atempo: цепочка за пределами 0.5…2', () => {
    expect(atempo(1.25)).toBe('atempo=1.25')
    expect(atempo(3)).toBe('atempo=2,atempo=1.5')
    expect(atempo(0.25)).toBe('atempo=0.5,atempo=0.5')
  })
})
