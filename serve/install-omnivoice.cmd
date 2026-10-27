@echo off
rem DEV-520: OmniVoice на лаптопе (RTX 3060 Laptop 6 ГБ). Команда установки — из DEV-517 (voice-lab i-omnivoice.cmd).
set UV=C:\Users\Denis\AppData\Local\Programs\Python\Python310\Scripts\uv.exe
set HF_HOME=E:\nr\tts\hf
set UV_CACHE_DIR=E:\nr\tts\uv-cache
set TEMP=E:\nr\tts\tmp
set TMP=E:\nr\tts\tmp
mkdir E:\nr\tts\tmp 2>nul
cd /d E:\nr\tts
if not exist venv\Scripts\python.exe %UV% venv venv --python 3.12 > install.log 2>&1
set VIRTUAL_ENV=E:\nr\tts\venv
set PATH=E:\nr\tts\venv\Scripts;%PATH%
%UV% pip install --link-mode=copy --torch-backend=cu128 torch==2.8.0 torchaudio==2.8.0 omnivoice soundfile numpy > install.log 2>&1
python -c "import torch;print('TORCH',torch.__version__,torch.cuda.is_available())" >> install.log 2>&1
python -c "from huggingface_hub import snapshot_download as s; print(s('k2-fsa/OmniVoice'))" >> install.log 2>&1
echo INSTALL-DONE >> install.log
