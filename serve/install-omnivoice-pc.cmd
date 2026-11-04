@echo off
rem DEV-646: OmniVoice на PC, RTX 3060 (cuda 0). Окружение и кэши — E:\nr\tts.
set UV=F:\Win\miniconda3\Scripts\uv.exe
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
