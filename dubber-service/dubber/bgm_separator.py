import os, shutil, subprocess
import numpy as np
from .utils import log

def _extract_full_audio(video_path, out_wav):
    r = subprocess.run(
        ["ffmpeg","-y","-i",video_path,"-ar","44100","-ac","2","-vn",out_wav],
        capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"FFmpeg audio extract failed:\n{r.stderr[-400:]}")

def _load_wav(path):
    import soundfile as sf, torch
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    return torch.from_numpy(data.T), sr

def _save_wav(tensor, path, sr):
    import soundfile as sf
    data = np.clip(tensor.cpu().numpy().T, -1.0, 1.0)
    sf.write(path, data, sr)

def separate_background(video_path, output_dir="workspace"):
    os.makedirs(output_dir, exist_ok=True)
    full_audio = os.path.join(output_dir, "original_full.wav")
    bgm_path   = os.path.join(output_dir, "background.wav")
    log("BGM_SEP", "Extracting full audio ...")
    _extract_full_audio(video_path, full_audio)
    try:
        import torch
        from demucs.apply      import apply_model
        from demucs.pretrained import get_model
        # Env-configurable device: CPU by default (desktop), CUDA on a GPU host
        # (e.g. Colab) via DEMUCS_DEVICE=cuda. Fall back to CPU if CUDA is asked
        # for but unavailable.
        demucs_device = (os.getenv("DEMUCS_DEVICE", "cpu").strip().lower() or "cpu")
        if demucs_device == "cuda" and not torch.cuda.is_available():
            log("BGM_SEP", "DEMUCS_DEVICE=cuda but no CUDA available — using cpu")
            demucs_device = "cpu"
        log("BGM_SEP", f"Loading demucs htdemucs model (device={demucs_device}) ...")
        model = get_model("htdemucs"); model.eval()
        wav, sr = _load_wav(full_audio)
        if sr != model.samplerate:
            import torch.nn.functional as F
            wav = F.interpolate(wav.unsqueeze(0), scale_factor=model.samplerate/sr,
                                mode="linear", align_corners=False).squeeze(0)
        if wav.shape[0]==1 and model.audio_channels==2: wav=wav.repeat(2,1)
        elif wav.shape[0]>2: wav=wav[:2]
        ref=wav.mean(0); wav=(wav-ref.mean())/(ref.std()+1e-8)
        with torch.no_grad():
            sources=apply_model(model,wav.unsqueeze(0),device=demucs_device,progress=True)[0]
        vocal_idx=model.sources.index("vocals")
        bg=torch.stack([sources[i] for i in range(len(model.sources)) if i!=vocal_idx]).sum(0)
        bg=bg*(ref.std()+1e-8)+ref.mean()
        _save_wav(bg, bgm_path, model.samplerate)
        log("BGM_SEP", f"Background saved -> {bgm_path}")
        return bgm_path
    except Exception as e:
        import traceback; traceback.print_exc()
        log("BGM_SEP", f"demucs failed: {e} — falling back.")
        shutil.copy(full_audio, bgm_path)
        return bgm_path
