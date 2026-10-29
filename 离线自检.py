"""不连接微信或 TTS，仅检查 DLL 哈希和 SILK 编码回解。测试音为程序生成。"""
from pathlib import Path
import hashlib, json, math, struct, subprocess, sys, tempfile, wave

root=Path(__file__).resolve().parent
manifest=json.loads((root/'native/build.json').read_text(encoding='utf-8-sig'))
assert hashlib.sha256((root/'native/version.dll').read_bytes()).hexdigest()==manifest['sha256'], 'DLL hash mismatch'
with tempfile.TemporaryDirectory(prefix='dsh-voice-selftest-') as tmp:
    tmp=Path(tmp); src=tmp/'generated-tone.wav'; silk=tmp/'test.silk'; decoded=tmp/'decoded.wav'
    with wave.open(str(src),'wb') as f:
        f.setparams((1,2,24000,0,'NONE','not compressed'))
        f.writeframes(b''.join(struct.pack('<h',int(2000*math.sin(2*math.pi*440*i/24000))) for i in range(24000)))
    subprocess.run([sys.executable,str(root/'voice-bridge/tools/silk_encode.py'),str(src),str(silk),'--decode',str(decoded)],check=True)
    with wave.open(str(decoded)) as f: seconds=f.getnframes()/f.getframerate()
    assert 0.9<seconds<1.1, seconds
print(json.dumps({'dllHash':True,'silkRoundTrip':True,'wechatMessagesSent':0}))
