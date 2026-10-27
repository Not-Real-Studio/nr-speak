"""
Замер сервера local_tts на месте (DEV-520): фразы подряд `--minutes` минут, по каждой — время до
первого звука и RTF; раз в 10 с — nvidia-smi (температура, частота, причины тротлинга, память)
или RSS процесса на маке. Итог — JSON в `--out` и строкой в stdout.

  python bench.py --url http://127.0.0.1:8095 --voice denis-11s --minutes 30 --out bench.json
"""

import argparse
import json
import shutil
import statistics
import subprocess
import threading
import time
import urllib.request

PHRASES = [
    "Привет! Слышу тебя хорошо, давай продолжим.",
    "Сегодня я разобрал задачу про голос чата: лаптоп отвечает первым, а макбук страхует.",
    "Хорошо, давай так и сделаем.",
    "Он посмотрел на неё долгим взглядом, потом отвернулся к окну и сказал, что поезд уже ушёл.",
    "Проверил три варианта, второй быстрее всех, но звучит хуже; я бы взял первый.",
    "Ладно. Тогда завтра утром.",
]


def speak(url, voice, text):
    body = json.dumps({"input": text, "voice": voice, "response_format": "pcm"}).encode()
    req = urllib.request.Request(f"{url}/v1/audio/speech", data=body, headers={"content-type": "application/json"})
    t0 = time.time()
    first = None
    n = 0
    with urllib.request.urlopen(req, timeout=120) as r:
        while True:
            b = r.read1(65536) if hasattr(r, "read1") else r.read(65536)
            if not b:
                break
            if first is None:
                first = time.time() - t0
            n += len(b)
    dt = time.time() - t0
    secs = n / 2 / 24000
    return {"first": first or dt, "total": dt, "audio": secs, "rtf": dt / max(secs, 0.01)}


def gpu():
    if not shutil.which("nvidia-smi"):
        return None
    q = "temperature.gpu,clocks.sm,clocks.max.sm,memory.used,power.draw,clocks_throttle_reasons.active"
    try:
        out = subprocess.run(["nvidia-smi", f"--query-gpu={q}", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10).stdout.strip()
        t, sm, smax, mem, pw, thr = [x.strip() for x in out.split(",")]
        return {"temp": int(t), "sm": int(sm), "sm_max": int(smax), "mem": int(mem), "power": float(pw) if pw not in ("[N/A]", "") else None, "throttle": thr}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8095")
    ap.add_argument("--voice", default="")
    ap.add_argument("--minutes", type=float, default=30)
    ap.add_argument("--out", default="bench.json")
    a = ap.parse_args()

    runs, samples, stop = [], [], threading.Event()

    def watch():
        while not stop.is_set():
            g = gpu()
            if g:
                samples.append({"t": round(time.time() - t0), **g})
            stop.wait(10)

    t0 = time.time()
    th = threading.Thread(target=watch, daemon=True)
    th.start()
    i = 0
    end = t0 + a.minutes * 60
    while time.time() < end:
        try:
            r = speak(a.url, a.voice, PHRASES[i % len(PHRASES)])
            r["t"] = round(time.time() - t0)
            runs.append(r)
        except Exception as e:  # noqa: BLE001
            runs.append({"t": round(time.time() - t0), "error": str(e)})
        i += 1
        if i % 20 == 0:
            ok = [r for r in runs[-20:] if "rtf" in r]
            print(f"{round(time.time() - t0)} с: {i} фраз, RTF {statistics.median([r['rtf'] for r in ok]):.2f}, первый {statistics.median([r['first'] for r in ok]) * 1000:.0f} мс, gpu {samples[-1] if samples else '-'}", flush=True)
        json.dump({"runs": runs, "gpu": samples}, open(a.out, "w"), ensure_ascii=False)
    stop.set()
    ok = [r for r in runs if "rtf" in r]
    q = lambda xs, p: sorted(xs)[min(len(xs) - 1, int(len(xs) * p))] if xs else None  # noqa: E731
    temps = [s["temp"] for s in samples if "temp" in s]
    thr = [s for s in samples if s.get("throttle") not in (None, "0x0000000000000000", "0x0000000000000001")]
    summary = {
        "phrases": len(runs),
        "errors": len(runs) - len(ok),
        "rtf_median": statistics.median([r["rtf"] for r in ok]) if ok else None,
        "first_ms_median": round(statistics.median([r["first"] for r in ok]) * 1000) if ok else None,
        "first_ms_p90": round(q([r["first"] for r in ok], 0.9) * 1000) if ok else None,
        "rtf_first5min": statistics.median([r["rtf"] for r in ok if r["t"] < 300]) if ok else None,
        "rtf_last5min": statistics.median([r["rtf"] for r in ok if r["t"] > a.minutes * 60 - 300]) if ok else None,
        "gpu_mem_max_mb": max([s["mem"] for s in samples if "mem" in s], default=None),
        "temp_max": max(temps, default=None),
        "temp_median": statistics.median(temps) if temps else None,
        "sm_min": min([s["sm"] for s in samples if "sm" in s], default=None),
        "throttled_samples": len(thr),
        "throttle_reasons": sorted({s["throttle"] for s in thr}),
    }
    json.dump({"summary": summary, "runs": runs, "gpu": samples}, open(a.out, "w"), ensure_ascii=False, indent=1)
    print("SUMMARY", json.dumps(summary, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
