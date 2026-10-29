"""把任意音频转成微信语音条用的 SILK（24kHz 单声道，带 0x02 前缀 = 微信格式）。

用法：
  python silk_encode.py in.mp3 out.silk
  python silk_encode.py in.mp3 out.silk --decode out.wav   # 回解校验

依赖：pip install pilk（纯 python 封装，内置 silk 编解码）
"""
import argparse
import os
import subprocess
import sys
import tempfile
import wave

import pilk


def to_pcm24k(src):
    """统一转成 24kHz / 单声道 / 16bit 的 WAV，交给 silk 编码器。"""
    if src.lower().endswith('.wav'):
        with wave.open(src) as w:
            if w.getframerate() == 24000 and w.getnchannels() == 1 and w.getsampwidth() == 2:
                return src, None
    handle, temp = tempfile.mkstemp(suffix='.wav')
    os.close(handle)
    subprocess.run(
        ['ffmpeg', '-y', '-loglevel', 'error', '-i', src, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', temp],
        check=True,
    )
    return temp, temp


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('input')
    parser.add_argument('output')
    parser.add_argument('--decode', help='编码后再解回 wav，用于自检')
    args = parser.parse_args()

    pcm, temp = to_pcm24k(args.input)
    pilk.encode(pcm, args.output, pcm_rate=24000, tencent=True)
    if temp:
        os.unlink(temp)

    with open(args.output, 'rb') as f:
        header = f.read(10)
    size = os.path.getsize(args.output)
    ok = header[:10] == b'\x02#!SILK_V3'
    print(f'{args.output}  {size} 字节  header={header[:10]!r}  合法={ok}')
    if not ok:
        sys.exit(2)

    if args.decode:
        pilk.silk_to_wav(args.output, args.decode)
        with wave.open(args.decode) as w:
            print(f'回解：{w.getnframes() / w.getframerate():.2f}s  {w.getframerate()}Hz  {w.getnchannels()}ch')
    sys.exit(0)


if __name__ == '__main__':
    main()