"""Song analysis: constant-tempo beat grid, per-beat energy, drop detection, repeated notes."""
from __future__ import annotations

import numpy as np
import librosa

SR = 22050
HOP = 256


def _grid_score(env_s: np.ndarray, fps: float, period: float, phases: np.ndarray, duration: float) -> np.ndarray:
    k = np.arange(int(duration / period))
    idx = np.round((phases[:, None] + k[None, :] * period) * fps).astype(int)
    valid = idx < len(env_s)
    return np.where(valid, env_s[np.minimum(idx, len(env_s) - 1)], 0).sum(axis=1)


def _fit_grid(beat_times: np.ndarray, onset_env: np.ndarray, duration: float) -> tuple[float, float]:
    """Fit a constant-tempo grid (t0, period): EDM tempo is fixed, so search period and phase that best
    line up with onsets across the whole song (the tracker's own tempo is quantized and can drift)."""
    fps = SR / HOP
    p0 = float(np.median(np.diff(beat_times)))
    env_s = np.convolve(onset_env, [0.25, 0.5, 0.25], mode="same")
    phases_coarse = np.arange(0, p0, 1 / fps)
    best = (-1.0, p0, 0.0)
    for period in np.linspace(p0 * 0.97, p0 * 1.03, 241):
        sc = _grid_score(env_s, fps, period, phases_coarse[phases_coarse < period], duration)
        i = int(np.argmax(sc))
        if sc[i] > best[0]:
            best = (float(sc[i]), float(period), float(phases_coarse[i]))
    _, period, phase = best
    # Fine pass
    for _ in range(2):
        periods = np.linspace(period * 0.999, period * 1.001, 41)
        phases = np.arange(phase - 2 / fps, phase + 2 / fps, 0.1 / fps)
        top = (-1.0, period, phase)
        for pr in periods:
            sc = _grid_score(env_s, fps, pr, phases, duration)
            i = int(np.argmax(sc))
            if sc[i] > top[0]:
                top = (float(sc[i]), float(pr), float(phases[i]))
        _, period, phase = top
    return phase % period, period


def analyze_song(wav_path: str) -> dict:
    y, sr = librosa.load(wav_path, sr=SR, mono=True)
    duration = len(y) / sr
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP)
    tempo, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_env, sr=sr, hop_length=HOP, start_bpm=126, tightness=400
    )
    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=HOP)
    if len(beat_times) < 8:
        raise RuntimeError("Could not find a steady beat in this song.")
    t0, period = _fit_grid(beat_times, onset_env, duration)
    beats = np.arange(t0, duration, period)
    eighths = np.arange(t0, duration, period / 2)

    # Spectral features
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=HOP))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    bass = S[(freqs >= 20) & (freqs <= 150)].sum(axis=0)
    rms = librosa.feature.rms(S=S, frame_length=2048, hop_length=HOP)[0]
    chroma = librosa.feature.chroma_stft(S=S**2, sr=sr, hop_length=HOP)
    fps = sr / HOP

    def per_interval(feat: np.ndarray, times: np.ndarray, step: float) -> np.ndarray:
        out = np.zeros(len(times))
        for i, t in enumerate(times):
            a, b = int(t * fps), int((t + step) * fps)
            seg = feat[..., a:max(a + 1, b)]
            out[i] = float(seg.mean()) if seg.size else 0.0
        return out

    beat_rms = per_interval(rms, beats, period)
    beat_bass = per_interval(bass, beats, period)
    beat_onset = per_interval(onset_env, beats, period / 4)

    def norm(x: np.ndarray) -> np.ndarray:
        lo, hi = np.percentile(x, 2), np.percentile(x, 98)
        return np.clip((x - lo) / (hi - lo + 1e-9), 0, 1)

    energy = 0.5 * norm(beat_rms) + 0.3 * norm(beat_bass) + 0.2 * norm(beat_onset)

    # Repeated-note detection at eighth-note resolution.
    e_chroma = np.zeros((len(eighths), 12))
    e_onset = np.zeros(len(eighths))
    for i, t in enumerate(eighths):
        a = int(t * fps)
        b = int((t + period / 2) * fps)
        if a < chroma.shape[1]:
            e_chroma[i] = chroma[:, a:max(a + 1, b)].mean(axis=1)
            e_onset[i] = onset_env[a:max(a + 1, min(b, a + 4))].max()
    norms = np.linalg.norm(e_chroma, axis=1) + 1e-9
    sim = np.zeros(len(eighths))
    sim[1:] = (e_chroma[1:] * e_chroma[:-1]).sum(axis=1) / (norms[1:] * norms[:-1])
    onset_thr = np.percentile(e_onset, 60)
    repeat = (sim > 0.93) & (e_onset > onset_thr) & (np.roll(e_onset, 1) > onset_thr)
    repeat[0] = False

    # Waveform peaks for the UI
    n_peaks = 4000
    block = max(1, len(y) // n_peaks)
    trimmed = y[: block * (len(y) // block)].reshape(-1, block)
    peaks = np.abs(trimmed).max(axis=1)
    peaks = peaks / (peaks.max() + 1e-9)

    return {
        "duration": duration,
        "bpm": 60.0 / period,
        "period": period,
        "beats": beats.round(4).tolist(),
        "energy": energy.round(4).tolist(),
        "bass": norm(beat_bass).round(4).tolist(),
        "eighths": eighths.round(4).tolist(),
        "repeat": repeat.astype(int).tolist(),
        "peaks": peaks.round(3).tolist(),
        "peaks_dt": block / sr,
    }


def beat_index(music: dict, t: float) -> int:
    beats = music["beats"]
    return int(np.clip(round((t - beats[0]) / music["period"]), 0, len(beats) - 1))


def detect_drop(music: dict, start: float, end: float) -> float:
    """The downbeat with the largest rise in bass/energy inside [start, end]."""
    beats = np.array(music["beats"])
    bass = np.array(music["bass"])
    energy = np.array(music["energy"])
    i0 = beat_index(music, start) + 8
    i1 = beat_index(music, end) - 4
    if i1 <= i0:
        i0, i1 = beat_index(music, start) + 1, max(beat_index(music, end), beat_index(music, start) + 2)
    best_i, best = i0, -1e9
    for i in range(max(i0, 4), min(i1, len(beats) - 4) + 1):
        before = slice(max(0, i - 8), i)
        after = slice(i, min(len(beats), i + 8))
        score = (bass[after].mean() - bass[before].mean()) + 0.6 * (energy[after].mean() - energy[before].mean())
        # Drops usually follow a dip right before them (riser / silence).
        score += 0.3 * (energy[i] - energy[max(0, i - 1)])
        if score > best:
            best, best_i = score, i
    return float(beats[best_i])
