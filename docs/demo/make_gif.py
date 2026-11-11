# record.mjs 가 찍은 프레임(docs/demo/frames)을 자막을 붙여 README 용 GIF 로 만든다
# 실행 : python docs/demo/make_gif.py   (Pillow 필요)
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
FRAMES = HERE / 'frames'
FONT = 'C:/Windows/Fonts/malgun.ttf'
FONT_BOLD = 'C:/Windows/Fonts/malgunbd.ttf'
INK = (25, 31, 40)
BLUE = (49, 130, 246)


def font(size, bold=False):
    return ImageFont.truetype(FONT_BOLD if bold else FONT, size)


def wrap(draw, text, fnt, width):
    """자막을 width 안에 들어가게 여러 줄로 나눈다"""
    lines, line = [], ''
    for ch in text:
        if draw.textlength(line + ch, font=fnt) > width:
            lines.append(line)
            line = ch
        else:
            line += ch
    if line:
        lines.append(line)
    return lines


def caption_bar(img, text, label=None):
    """그림 아래에 짙은 자막 띠를 붙인다 (label 은 왼쪽 파란 꼬리표)"""
    w = img.width
    fnt = font(20)
    tmp = ImageDraw.Draw(img)
    left = 24
    if label:
        left += int(tmp.textlength(label, font=font(18, True))) + 36
    lines = wrap(tmp, text, fnt, w - left - 24) if text else []
    h = max(64, 24 + 30 * max(1, len(lines)))
    out = Image.new('RGB', (w, img.height + h), INK)
    out.paste(img, (0, 0))
    d = ImageDraw.Draw(out)
    y0 = img.height
    if label:
        lw = int(d.textlength(label, font=font(18, True))) + 20
        d.rounded_rectangle([24, y0 + 16, 24 + lw, y0 + 48], radius=8, fill=BLUE)
        d.text((34, y0 + 18), label, font=font(18, True), fill='white')
    for i, line in enumerate(lines):
        d.text((left, y0 + 14 + 30 * i), line, font=fnt, fill='white')
    return out


def load(name):
    meta = json.loads((FRAMES / name / 'frames.json').read_text(encoding='utf-8'))
    imgs = []
    for f in meta['frames']:
        img = Image.open(FRAMES / name / f['file']).convert('RGB')
        if meta.get('crop'):
            img = img.crop(tuple(meta['crop']))
        imgs.append((img, f))
    return meta, imgs


def save_gif(frames, durations, out, width):
    """프레임 크기를 맞추고 팔레트로 줄여 GIF 로 저장한다"""
    h = max(f.height for f in frames)
    norm = []
    for f in frames:
        canvas = Image.new('RGB', (f.width, h), INK)
        canvas.paste(f, (0, 0))
        if canvas.width != width:
            canvas = canvas.resize((width, round(canvas.height * width / canvas.width)), Image.LANCZOS)
        norm.append(canvas.convert('P', palette=Image.ADAPTIVE, colors=128))
    norm[0].save(out, save_all=True, append_images=norm[1:], duration=durations, loop=0, optimize=True, disposal=2)
    print(out.name, f'{out.stat().st_size // 1024} KB', f'{sum(durations) / 1000:.1f}s')


def simple(name, out_name):
    meta, imgs = load(name)
    frames = [caption_bar(img, f['caption']) for img, f in imgs]
    save_gif(frames, [f['ms'] for _, f in imgs], HERE / out_name, meta.get('width', 960))


def batch(out_name):
    """v0 · v2 를 같은 순간끼리 나란히 붙이고, 찍을 때 센 커밋 수로 자막을 만든다"""
    _, v0 = load('3-batch-v0')
    _, v2 = load('3-batch-v2-microtask')
    gap, head = 24, 56
    frames, durations = [], []
    steps = ['패널을 연다 — 커밋 기록은 최근 순', '같은 칸에 착수 1번', '1초 타이머가 한 번 울림 (엔진 이벤트 밖의 setter 2개)']
    for i, ((a, fa), (b, fb)) in enumerate(zip(v0, v2)):
        w = a.width + gap + b.width
        canvas = Image.new('RGB', (w, a.height + head), (242, 244, 246))
        d = ImageDraw.Draw(canvas)
        d.text((16, 14), 'v0 배칭 없음', font=font(22, True), fill=INK)
        d.text((a.width + gap + 16, 14), 'v2 마이크로태스크 배칭', font=font(22, True), fill=BLUE)
        canvas.paste(a, (0, head))
        canvas.paste(b, (a.width + gap, head))
        if 'move' in fa:
            text = f"{steps[i]} → 커밋 v0 {fa['move']}번 · v2 {fb['move']}번"
        elif 'tick' in fa:
            text = f"{steps[i]} → 커밋 v0 {fa['tick']}번 · v2 {fb['tick']}번"
        else:
            text = steps[i]
        frames.append(caption_bar(canvas, text, label=f'{i + 1}/{len(v0)}'))
        durations.append(fa['ms'])
    save_gif(frames, durations, HERE / out_name, frames[0].width)


if __name__ == '__main__':
    simple('1-diff-patch', 'demo-1-diff-patch.gif')
    simple('2-hooks-render', 'demo-2-hooks-render.gif')
    batch('demo-3-batching.gif')
