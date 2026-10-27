@echo off
rem DEV-520: OmniVoice (k2-fsa, fp16, GPU) на :8095 — сервер speak, лог E:\nr\tts\omnivoice.log.
rem Запускается задачей планировщика studio-omnivoice при входе; перезапуск при падении — цикл ниже.
rem Установка: serve\install-omnivoice.cmd (venv E:\nr\tts\venv, кэши uv/HF — на E:, на C: места нет).
set HF_HOME=E:\nr\tts\hf
set HF_HUB_OFFLINE=1
set PYTHONUNBUFFERED=1
set PYTHONIOENCODING=utf-8
cd /d E:\nr\tts
:loop
E:\nr\tts\venv\Scripts\python.exe E:\nr\tts\local_tts.py --engine=omnivoice --port=8095 --host=0.0.0.0 --data=E:\nr\tts\data --default-voice=denis-11s >> E:\nr\tts\omnivoice.log 2>&1
echo %date% %time% exit %errorlevel%, restart in 10s >> E:\nr\tts\omnivoice.log
timeout /t 10 /nobreak >nul
goto loop
