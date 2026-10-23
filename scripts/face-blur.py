"""Blur every face in a video (or image) before publishing, and prove it with a re-detection pass. 2026-10-23.

Why not just `deface`: it detects frame by frame with one detector, so a face missed on one frame flashes through, and it
drops the audio. This keeps the parts that matter for privacy:

  1. ffmpeg pre-pass: optional trim (--ss/--t), applies phone rotation, scales so the long side is --long (default 1920)
  2. detection with two detectors, merged (recall over precision):
       CenterFace (bundled with deface, good on small/side faces) + OpenCV YuNet (FaceDetectorYN)
  3. temporal hold: every box is kept for --hold frames before and after it was seen, then grown by --scale
  4. blur (Gaussian ellipse; or --mode mosaic|solid) and encode with the original audio (H.264 CRF 18 + AAC)
  5. verify: both detectors run again on the output at a lower threshold; any hit is reported with its frame number,
     and a contact sheet (--sheet) shows sampled frames with the blurred regions outlined for a human check

Setup (once, outside the repo):
  uv venv --python 3.12 <dir>/.venv && uv pip install --python <dir>/.venv/Scripts/python.exe deface opencv-python onnxruntime numpy
  YuNet model: downloaded on first run to <cache>/face_detection_yunet_2023mar.onnx (sha256 checked)
Usage:
  <venv-python> scripts/face-blur.py in.mp4 out.mp4 [--ss 12.5 --t 20] [--long 1920] [--hold 8] [--scale 1.6]
       [--cf 0.3] [--yn 0.6] [--mode blur|mosaic|solid] [--sheet sheet.jpg] [--report report.json] [--ffmpeg ffmpeg]
  Exit code 3 when the verify pass still finds a face (the output is written anyway, for review).
Images: in.jpg out.jpg works too (single frame, no audio).
"""
import argparse, hashlib, json, os, subprocess, sys, tempfile, urllib.request
import cv2
import numpy as np
from deface.centerface import CenterFace

YUNET_URL = 'https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx'
YUNET_SHA = '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'
IMG_EXT = ('.jpg', '.jpeg', '.png', '.webp', '.bmp')


def yunet_path(cache):
    os.makedirs(cache, exist_ok=True)
    p = os.path.join(cache, 'face_detection_yunet_2023mar.onnx')
    if not os.path.exists(p):
        urllib.request.urlretrieve(YUNET_URL, p)
    if hashlib.sha256(open(p, 'rb').read()).hexdigest() != YUNET_SHA:
        os.remove(p); sys.exit('YuNet model checksum mismatch; deleted, rerun to fetch again')
    return p


class Detector:
    """Both detectors on a copy scaled so the long side is det_long (faces stay above YuNet's ~10 px floor at 960 for
    phone footage); boxes are returned in the coordinates of the frame passed in."""
    def __init__(self, cache, det_long=960):
        # onnxruntime lists AzureExecutionProvider first on some builds, which is not a local device: pin the CPU provider.
        # Without the `onnx` package deface silently falls back to OpenCV DNN, which was ~20x slower here.
        import onnxruntime
        prov = 'CPUExecutionProvider' if 'CPUExecutionProvider' in onnxruntime.get_available_providers() else None
        self.cf = CenterFace(backend='onnxrt', override_execution_provider=prov)
        self.yn = cv2.FaceDetectorYN.create(yunet_path(cache), '', (320, 320), 0.5, 0.3, 5000)
        self.det_long = det_long

    def __call__(self, frame, cf_thr, yn_thr):
        h, w = frame.shape[:2]
        r = min(1.0, self.det_long / max(h, w))
        small = cv2.resize(frame, (int(w * r) // 32 * 32 or 32, int(h * r) // 32 * 32 or 32), interpolation=cv2.INTER_AREA) if r < 1 else frame
        sx, sy = w / small.shape[1], h / small.shape[0]
        boxes = []
        dets, _ = self.cf(small, threshold=cf_thr)
        for d in dets:
            boxes.append([float(d[0]) * sx, float(d[1]) * sy, float(d[2]) * sx, float(d[3]) * sy, float(d[4]), 'cf'])
        self.yn.setInputSize((small.shape[1], small.shape[0])); self.yn.setScoreThreshold(yn_thr)
        _, faces = self.yn.detect(small)
        if faces is not None:
            for f in faces:
                x, y, bw, bh = map(float, f[:4])
                boxes.append([x * sx, y * sy, (x + bw) * sx, (y + bh) * sy, float(f[-1]), 'yn'])
        return boxes


def grow(b, s, w, h):
    x1, y1, x2, y2 = b[:4]; cx, cy = (x1 + x2) / 2, (y1 + y2) / 2; bw, bh = (x2 - x1) * s, (y2 - y1) * s
    bh = max(bh, bw * 1.15)  # faces are taller than wide; cover hair/chin
    return [max(0, int(cx - bw / 2)), max(0, int(cy - bh / 2)), min(w, int(cx + bw / 2)), min(h, int(cy + bh / 2))]


def apply(frame, boxes, mode):
    h, w = frame.shape[:2]
    for x1, y1, x2, y2 in boxes:
        if x2 - x1 < 2 or y2 - y1 < 2: continue
        roi = frame[y1:y2, x1:x2]
        if mode == 'solid':
            rep = np.zeros_like(roi)
        elif mode == 'mosaic':
            k = max(2, (x2 - x1) // 10)
            rep = cv2.resize(cv2.resize(roi, (max(1, (x2 - x1) // k), max(1, (y2 - y1) // k)), interpolation=cv2.INTER_LINEAR), (x2 - x1, y2 - y1), interpolation=cv2.INTER_NEAREST)
        else:
            k = max(31, ((x2 - x1) // 2) | 1)
            rep = cv2.GaussianBlur(roi, (k, k), 0); rep = cv2.GaussianBlur(rep, (k, k), 0)
        mask = np.zeros(roi.shape[:2], np.uint8)
        cv2.ellipse(mask, ((x2 - x1) // 2, (y2 - y1) // 2), ((x2 - x1) // 2, (y2 - y1) // 2), 0, 0, 360, 255, -1)
        m = cv2.GaussianBlur(mask, (0, 0), max(1, (x2 - x1) / 30))[..., None] / 255.0
        frame[y1:y2, x1:x2] = (rep * m + roi * (1 - m)).astype(np.uint8)
    return frame


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input'); ap.add_argument('output')
    ap.add_argument('--ss', type=float); ap.add_argument('--t', type=float)
    ap.add_argument('--long', type=int, default=1920)
    ap.add_argument('--hold', type=int, default=8)
    ap.add_argument('--det-long', type=int, default=960, help='long side used for detection (boxes map back to full size)')
    ap.add_argument('--step', type=int, default=2, help='detect every Nth frame; --hold bridges the gaps (hold >= step)')
    ap.add_argument('--verify-step', type=int, default=2)
    ap.add_argument('--scale', type=float, default=1.6)
    ap.add_argument('--cf', type=float, default=0.3)
    ap.add_argument('--yn', type=float, default=0.6)
    ap.add_argument('--verify-cf', type=float, default=0.4)
    ap.add_argument('--verify-yn', type=float, default=0.75)
    ap.add_argument('--mode', default='blur', choices=['blur', 'mosaic', 'solid'])
    ap.add_argument('--sheet'); ap.add_argument('--report')
    ap.add_argument('--ffmpeg', default=os.environ.get('FFMPEG', 'ffmpeg'))
    ap.add_argument('--ffprobe', default=os.environ.get('FFPROBE'))
    ap.add_argument('--fps', type=float, default=30, help='output frame rate (0 keeps the source rate)')
    ap.add_argument('--cache', default=os.path.join(os.path.expanduser('~'), '.cache', 'face-blur'))
    a = ap.parse_args()
    a.hold = max(a.hold, a.step)
    det = Detector(a.cache, a.det_long)

    if a.input.lower().endswith(IMG_EXT):  # single image
        img = cv2.imread(a.input); h, w = img.shape[:2]
        boxes = [grow(b, a.scale, w, h) for b in det(img, a.cf, a.yn)]
        out = apply(img.copy(), boxes, a.mode); cv2.imwrite(a.output, out)
        left = det(out, a.verify_cf, a.verify_yn)
        rep = {'input': a.input, 'output': a.output, 'faces': len(boxes), 'verify_hits': len(left)}
        print(json.dumps(rep));
        if a.report: json.dump(rep, open(a.report, 'w'), indent=1)
        sys.exit(3 if left else 0)

    tmp = tempfile.mkdtemp(prefix='faceblur-')
    pre = os.path.join(tmp, 'pre.mp4')
    trim = (['-ss', str(a.ss)] if a.ss is not None else []) + (['-t', str(a.t)] if a.t is not None else [])
    scale = f"scale='if(gt(iw,ih),{a.long},-2)':'if(gt(iw,ih),-2,{a.long})'"
    # Phone footage is often HDR10 (PQ) or HLG in BT.2020; converting it to 8-bit without tone mapping makes it grey and flat
    ffprobe = a.ffprobe or os.path.join(os.path.dirname(a.ffmpeg), 'ffprobe' + os.path.splitext(a.ffmpeg)[1])
    trc = subprocess.run([ffprobe, '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_transfer', '-of', 'csv=p=0', a.input],
                         capture_output=True, text=True).stdout.strip()
    hdr = trc in ('smpte2084', 'arib-std-b67')
    tone = ('zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,' if hdr else '')
    vf = tone + scale + (f',fps={a.fps}' if a.fps else '')
    subprocess.run([a.ffmpeg, '-v', 'error', '-y', *trim, '-i', a.input, '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14',
                    '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
                    '-c:a', 'aac', '-b:a', '192k', pre], check=True)
    cap = cv2.VideoCapture(pre); fps = cap.get(cv2.CAP_PROP_FPS) or 30
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    # pass 1: detect
    per = []
    while True:
        ok, f = cap.read()
        if not ok: break
        per.append(det(f, a.cf, a.yn) if len(per) % a.step == 0 else [])
    cap.release(); n = len(per)

    # temporal hold + grow
    held = []
    for t in range(n):
        bs = [b for k in range(max(0, t - a.hold), min(n, t + a.hold + 1)) for b in per[k]]
        held.append([grow(b, a.scale, w, h) for b in bs])

    # pass 2: blur and encode with the original (trimmed) audio
    out_tmp = os.path.join(tmp, 'blur.mp4')
    enc = subprocess.Popen([a.ffmpeg, '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{w}x{h}', '-r', str(fps), '-i', '-',
                            '-i', pre, '-map', '0:v', '-map', '1:a?', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
                            '-c:a', 'copy', '-movflags', '+faststart', '-shortest', out_tmp], stdin=subprocess.PIPE)
    cap = cv2.VideoCapture(pre); t = 0; samples = []
    every = max(1, n // 12)
    while True:
        ok, f = cap.read()
        if not ok: break
        b = held[t] if t < n else []
        g = apply(f, b, a.mode)
        enc.stdin.write(g.tobytes())
        if a.sheet and t % every == 0 and len(samples) < 12:
            s = g.copy()
            for x1, y1, x2, y2 in b: cv2.rectangle(s, (x1, y1), (x2, y2), (0, 255, 255), 3)
            cv2.putText(s, f'#{t} faces:{len(per[t]) if t < n else 0}', (20, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (0, 255, 255), 4)
            samples.append(s)
        t += 1
    cap.release(); enc.stdin.close(); enc.wait()
    os.replace(out_tmp, a.output)

    # pass 3: verify on the published file
    cap = cv2.VideoCapture(a.output); hits = []; t = 0
    while True:
        ok, f = cap.read()
        if not ok: break
        if t % a.verify_step == 0:
            for b in det(f, a.verify_cf, a.verify_yn):
                # a hit centred inside a blurred region is the blurred blob itself (still head-shaped); one outside is a miss
                cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
                covered = any(x1 <= cx <= x2 and y1 <= cy <= y2 for x1, y1, x2, y2 in (held[t] if t < n else []))
                hits.append({'frame': t, 'box': [round(v) for v in b[:4]], 'score': round(b[4], 2), 'by': b[5], 'inside_blur': covered})
        t += 1
    cap.release()

    if a.sheet and samples:
        th = [cv2.resize(s, (360, int(360 * h / w))) for s in samples]
        while len(th) % 4: th.append(np.zeros_like(th[0]))
        cv2.imwrite(a.sheet, np.vstack([np.hstack(th[i:i + 4]) for i in range(0, len(th), 4)]))
    rep = {'input': a.input, 'output': a.output, 'size': [w, h], 'fps': round(fps, 2), 'frames': n,
           'frames_with_faces': sum(1 for p in per if p), 'detections': sum(len(p) for p in per),
           'hdr_tonemapped': hdr, 'verify_hits_outside_blur': sum(1 for x in hits if not x['inside_blur']),
           'verify_hits_inside_blur': sum(1 for x in hits if x['inside_blur']),
           'verify_frames_outside': sorted({x['frame'] for x in hits if not x['inside_blur']})[:50], 'sheet': a.sheet}
    print(json.dumps(rep))
    if a.report: json.dump({**rep, 'hits': hits[:500]}, open(a.report, 'w'), indent=1)
    sys.exit(3 if rep['verify_hits_outside_blur'] else 0)


if __name__ == '__main__':
    main()
