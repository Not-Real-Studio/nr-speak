"""
Локальный сервер речи для speak (DEV-520): OmniVoice (k2-fsa, GPU) и PocketTTS-RU (Shtorm, CPU)
за одним OpenAI-совместимым API. Модель грузится и прогревается на старте, синтез — по
предложениям, звук уходит клиенту по мере готовности (chunked, PCM s16le 24 кГц моно).

  python local_tts.py --engine omnivoice --port 8095 --data E:/nr/tts/data
  python local_tts.py --engine pocket --port 8096 --data ~/nr/tts/data

API:
  GET  /health                 {ok, engine, model, device, voices, busy, uptime}
  GET  /v1/audio/voices        {voices: [{id, text}]}
  PUT  /v1/voices/<id>         {audio: base64 WAV, text?} — образец клона; хранится на диске,
                               подготовленный промпт — в памяти (на каждую фразу не перечитывается)
  POST /v1/audio/speech        {input, voice?, response_format: pcm|wav, instructions?}
                               voice — id образца, `design:<атрибуты>` (OmniVoice), пусто — по
                               умолчанию; неизвестный образец — 404 code voice_not_found

Один синтез за раз (замок): GPU и CPU m2 не делятся. Темп — не здесь: speak ставит его ffmpeg.
"""

import argparse
import base64
import io
import json
import os
import re
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import soundfile as sf

OUT_RATE = 24000
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
VOWELS = re.compile(r"[аеёиоуыэюяАЕЁИОУЫЭЮЯ]")
SENTENCE = re.compile(r"(?<=[.!?…])\s+")


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def sentences(text, max_chars=300):
    """Предложения; длинное — по запятым, чтобы первый звук не ждал абзац."""
    out = []
    for s in SENTENCE.split(text.strip()):
        s = s.strip()
        while len(s) > max_chars:
            cut = max(s.rfind(", ", 0, max_chars), s.rfind(" — ", 0, max_chars), s.rfind(" ", 0, max_chars))
            cut = cut if cut > 20 else max_chars
            out.append(s[: cut + 1].strip())
            s = s[cut + 1 :].strip()
        if s:
            out.append(s)
    return out


def to_pcm(audio, rate):
    """Тензор/массив float [-1, 1] любой частоты → PCM s16le 24 кГц моно."""
    try:
        import torch

        if isinstance(audio, torch.Tensor):
            audio = audio.detach().float().cpu().numpy()
    except ImportError:
        pass
    a = np.asarray(audio, dtype=np.float32).reshape(-1)
    if rate != OUT_RATE and a.size:
        n = int(round(a.size * OUT_RATE / rate))
        a = np.interp(np.linspace(0, a.size - 1, n), np.arange(a.size), a).astype(np.float32)
    return (np.clip(a, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def wav_header(rate, nbytes):
    import struct

    return b"RIFF" + struct.pack("<I", 36 + nbytes) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", nbytes)


class OmniVoiceEngine:
    name = "omnivoice"

    def __init__(self, args):
        import torch
        from omnivoice import OmniVoice

        self.device = args.device or ("cuda:0" if torch.cuda.is_available() else "cpu")
        self.model_id = args.model or "k2-fsa/OmniVoice"
        dtype = torch.float16 if self.device.startswith("cuda") else torch.float32
        self.tts = OmniVoice.from_pretrained(self.model_id, device_map=self.device, dtype=dtype)
        self.rate = OUT_RATE
        self.default_instruct = args.default_instruct

    def prepare(self, wav_path, text):
        # Промпт клона готовится один раз: у OmniVoice есть create_voice_clone_prompt — им; нет —
        # держим путь и текст (модель читает файл сама).
        make = getattr(self.tts, "create_voice_clone_prompt", None)
        if make:
            try:
                return {"prompt": make(ref_audio=str(wav_path), ref_text=text or None)}
            except Exception as e:  # noqa: BLE001
                log("prompt: create_voice_clone_prompt упал, беру путь:", e)
        return {"ref_audio": str(wav_path), "ref_text": text or None}

    def generate(self, text, voice, instruct):
        kw = {}
        if voice is None:
            kw["instruct"] = instruct or self.default_instruct
        elif "design" in voice:
            kw["instruct"] = voice["design"]
        elif "prompt" in voice:
            kw["voice_clone_prompt"] = voice["prompt"]
        else:
            kw["ref_audio"] = voice["ref_audio"]
            if voice.get("ref_text"):
                kw["ref_text"] = voice["ref_text"]
        out = self.tts.generate(text=text, **{k: v for k, v in kw.items() if v})
        yield to_pcm(out[0], self.rate)


class PocketEngine:
    name = "pocket"

    def __init__(self, args):
        from pocket_tts import TTSModel

        self.device = "cpu"
        self.model_id = args.model or "hf://ArtShtorm/Shtorm-PocketTTS-RU/config.yaml"
        self.tts = TTSModel.load_model(config=self.model_id)
        self.rate = int(self.tts.sample_rate)
        self.accent = None
        self.accent_kind = args.accent
        if args.accent == "silero":
            # Shtorm обучен на ударениях знаком U+0301. silero-stress — 0.6 ГБ с torch и 50 мс на фразу;
            # RUAccent (DEV-517) тянет 3+ ГБ и на свежих transformers падает (token_type_ids).
            import silero_stress

            self.accent = silero_stress.load_accentor()
        elif args.accent == "ruaccent":
            from ruaccent import RUAccent

            self.accent = RUAccent()
            self.accent.load(omograph_model_size=args.accent_model, use_dictionary=True, tiny_mode=args.accent_tiny)

    def prep(self, s):
        if not self.accent:
            return s
        try:
            marked = self.accent(s) if self.accent_kind == "silero" else self.accent.process_all(s)
        except Exception as e:  # noqa: BLE001
            log("ударения: сбой, фраза без них:", e)
            return s
        # Односложным ударение не нужно; `+` перед гласной → гласная + U+0301.
        marked = re.sub(r"(?<!\w)(\w*)\+(\w+)", lambda m: m.group(0) if len(VOWELS.findall(m.group(1) + m.group(2))) > 1 else m.group(1) + m.group(2), marked)
        return re.sub(r"\+(\w)", "\\1\u0301", marked)

    def prepare(self, wav_path, text):
        return {"state": self.tts.get_state_for_audio_prompt(str(wav_path))}

    def generate(self, text, voice, instruct):
        if voice is None or "state" not in voice:
            raise LookupError("pocket: нужен образец клона (voice), голоса по описанию нет")
        for frame in self.tts.generate_audio_stream(voice["state"], self.prep(text)):
            yield to_pcm(frame, self.rate)


class Voices:
    """Образцы на диске (`<data>/voices/<id>.wav` + `.txt`), промпты — в памяти."""

    def __init__(self, engine, data):
        self.engine = engine
        self.dir = Path(data).expanduser() / "voices"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.ready = {}
        self.lock = threading.Lock()

    def ids(self):
        return sorted(p.stem for p in self.dir.glob("*.wav"))

    def text_of(self, vid):
        t = self.dir / f"{vid}.txt"
        return t.read_text("utf-8").strip() if t.exists() else ""

    def put(self, vid, audio, text):
        a, rate = sf.read(io.BytesIO(audio), dtype="float32", always_2d=True)
        if a.shape[0] < rate:
            raise ValueError("образец короче секунды")
        sf.write(self.dir / f"{vid}.wav", a.mean(axis=1), rate, subtype="PCM_16")
        (self.dir / f"{vid}.txt").write_text(text or "", "utf-8")
        with self.lock:
            self.ready.pop(vid, None)
        return self.get(vid)

    def get(self, vid):
        with self.lock:
            hit = self.ready.get(vid)
        if hit is not None:
            return hit
        wav = self.dir / f"{vid}.wav"
        if not wav.exists():
            return None
        t0 = time.time()
        v = self.engine.prepare(wav, self.text_of(vid))
        with self.lock:
            self.ready[vid] = v
        log(f"voice {vid}: готов за {time.time() - t0:.2f} с")
        return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", choices=["omnivoice", "pocket"], required=True)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--model")
    ap.add_argument("--device")
    ap.add_argument("--default-voice", help="id образца по умолчанию (пустой voice)")
    ap.add_argument("--default-instruct", default="male, low pitch", help="OmniVoice: дизайн для пустого voice без образца")
    ap.add_argument("--accent", choices=["silero", "ruaccent", "none"], default="silero", help="pocket: ударения")
    ap.add_argument("--accent-model", default="turbo3.1")
    ap.add_argument("--accent-tiny", action="store_true")
    ap.add_argument("--threads", type=int, default=0, help="потоков torch на CPU (m2 — не всё ядро: там Лена и распознавание)")
    ap.add_argument("--warmup", default="Проверка голоса: раз, два, три.")
    args = ap.parse_args()

    if args.threads:
        import torch

        torch.set_num_threads(args.threads)
    t0 = time.time()
    engine = OmniVoiceEngine(args) if args.engine == "omnivoice" else PocketEngine(args)
    voices = Voices(engine, args.data)
    gen_lock = threading.Lock()
    state = {"busy": False, "started": time.time()}
    log(f"{engine.name}: модель {engine.model_id} на {engine.device} за {time.time() - t0:.1f} с")

    def resolve(vid):
        vid = (vid or "").strip() or (args.default_voice or "")
        if not vid:
            return None
        if vid.startswith("design:"):
            return {"design": vid[len("design:") :].strip()}
        if not SAFE_ID.match(vid):
            raise KeyError(vid)
        v = voices.get(vid)
        if v is None:
            raise KeyError(vid)
        return v

    def synth(text, voice, instruct):
        with gen_lock:
            state["busy"] = True
            try:
                for s in sentences(text):
                    for pcm in engine.generate(s, voice, instruct):
                        yield pcm
            finally:
                state["busy"] = False

    # Прогрев: первая фраза после старта не платит за компиляцию ядер и кэш.
    for vid in [args.default_voice] if args.default_voice else voices.ids()[:1] or [None]:
        try:
            t1 = time.time()
            n = sum(len(b) for b in synth(args.warmup, resolve(vid), None))
            log(f"прогрев ({vid or 'дизайн'}): {n / 2 / OUT_RATE:.2f} с звука за {time.time() - t1:.2f} с")
        except Exception as e:  # noqa: BLE001
            log("прогрев не удался:", e)

    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def send_json(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def error(self, code, message, kind=None):
            self.send_json(code, {"error": {"message": message, **({"code": kind} if kind else {})}})

        def body(self):
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b""
            return json.loads(raw or b"{}")

        def do_GET(self):
            if self.path == "/health":
                return self.send_json(200, {"ok": True, "engine": engine.name, "model": engine.model_id, "device": engine.device, "voices": voices.ids(), "busy": state["busy"], "uptime": round(time.time() - state["started"])})
            if self.path.startswith("/v1/audio/voices"):
                return self.send_json(200, {"voices": [{"id": v, "text": voices.text_of(v)} for v in voices.ids()]})
            self.error(404, "not found")

        def do_PUT(self):
            m = re.match(r"^/v1/voices/([^/?]+)$", self.path)
            if not m or not SAFE_ID.match(m.group(1)):
                return self.error(404, "not found")
            try:
                b = self.body()
                t1 = time.time()
                voices.put(m.group(1), base64.b64decode(b.get("audio") or ""), b.get("text") or "")
                self.send_json(200, {"id": m.group(1), "ms": round((time.time() - t1) * 1000)})
            except Exception as e:  # noqa: BLE001
                self.error(400, f"образец: {e}")

        def do_POST(self):
            if self.path != "/v1/audio/speech":
                return self.error(404, "not found")
            try:
                b = self.body()
            except Exception:  # noqa: BLE001
                return self.error(400, "тело — JSON")
            text = (b.get("input") or "").strip()
            if not text:
                return self.error(400, "пустой input")
            fmt = b.get("response_format") or "pcm"
            if fmt not in ("pcm", "wav"):
                return self.error(400, f"response_format «{fmt}»: есть pcm, wav")
            try:
                voice = resolve(b.get("voice"))
            except KeyError as e:
                return self.error(404, f"нет образца «{e.args[0]}» — загрузите PUT /v1/voices/<id>", "voice_not_found")
            t1 = time.time()
            it = synth(text, voice, (b.get("instructions") or "").strip() or None)
            try:
                first = next(it)
            except StopIteration:
                return self.error(500, "модель не прислала звука")
            except LookupError as e:
                return self.error(400, str(e))
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                return self.error(500, f"{engine.name}: {e}")
            ttfa = time.time() - t1
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav" if fmt == "wav" else f"audio/l16; rate={OUT_RATE}; channels=1")
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("X-First-Audio-Ms", str(round(ttfa * 1000)))
            self.end_headers()
            total = 0

            def chunk(data):
                self.wfile.write(f"{len(data):X}\r\n".encode() + data + b"\r\n")
                self.wfile.flush()

            try:
                if fmt == "wav":
                    chunk(wav_header(OUT_RATE, 0x7FFFFFF0))
                for pcm in [first] if first else []:
                    total += len(pcm)
                    chunk(pcm)
                for pcm in it:
                    if pcm:
                        total += len(pcm)
                        chunk(pcm)
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                it.close()
                log("клиент ушёл посреди синтеза")
                return
            except Exception as e:  # noqa: BLE001
                # Заголовок уже ушёл: обрываем поток без завершающего куска — клиент видит обрыв, не тишину.
                traceback.print_exc()
                log(f"сбой посреди синтеза: {e}")
                self.close_connection = True
                return
            secs = total / 2 / OUT_RATE
            dt = time.time() - t1
            log(f"speech {len(text)} зн., {secs:.2f} с звука за {dt:.2f} с (RTF {dt / max(secs, 0.01):.2f}), первый звук {ttfa * 1000:.0f} мс")

    srv = ThreadingHTTPServer((args.host, args.port), H)
    srv.daemon_threads = True
    log(f"слушаю {args.host}:{args.port}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    os.environ.setdefault("PYTHONUNBUFFERED", "1")
    main()
