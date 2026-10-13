"""Builds the single-file game.

  python3 tools/build.py [owner/repo]

Writes index.html (a full page, served by GitHub Pages) and
dist/daily-red.html (the same page without the document wrapper).
"""
import base64, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('DAILY_RED_REPO', '')
V = os.path.join(ROOT, 'vendor', 'gbajs')
FILES = ['util.js', 'core.js', 'arm.js', 'thumb.js', 'mmu.js', 'io.js', 'audio.js', 'video.js',
         'video/software.js', 'irq.js', 'keypad.js', 'sio.js', 'savedata.js', 'gpio.js', 'gba.js']

def read(*p):
    with open(os.path.join(ROOT, *p), encoding='utf-8') as f:
        return f.read()

parts = []
for name in FILES:
    s = read('vendor', 'gbajs', name)
    if name == 'gba.js':
        assert 'this.keypad.registerHandlers();' in s
        s = s.replace('this.keypad.registerHandlers();', '/* input is handled by the page */')
    if name == 'keypad.js':
        s += '\nGameBoyAdvanceKeypad.prototype.pollGamepads = function() {};\n'
    if name == 'savedata.js':
        # replaceData must also rebuild the bank views, or a loaded save is ignored
        s += '''
FlashSavedata.prototype.replaceData = function(memory) {
	MemoryView.prototype.replaceData.call(this, memory);
	this.bank0 = new DataView(this.buffer, 0, 0x00010000);
	this.bank1 = this.buffer.byteLength > 0x00010000 ? new DataView(this.buffer, 0x00010000) : null;
	this.bank = this.bank0;
};
'''
    parts.append('// ---- gbajs/%s ----\n%s' % (name, s))

license_text = read('vendor', 'gbajs', 'COPYING').replace('*/', '* /')
emu = '/*\n gbajs, a GBA emulator in JavaScript.\n' + license_text + '*/\n' + '\n'.join(parts)
with open(os.path.join(V, 'bios.bin'), 'rb') as f:
    bios = base64.b64encode(f.read()).decode()

body = (read('src', 'page.html')
        + '\n<script>\nwindow.DAILY_RED_REPO=' + json.dumps(REPO) + ';\n'
        + "window.DAILY_RED_BIOS=Uint8Array.from(atob('" + bios + "'),c=>c.charCodeAt(0));\n</script>\n"
        + '<script>\n' + emu + '\n</script>\n'
        + '<script>\n' + read('src', 'core.js') + '\n</script>\n'
        + '<script>\n' + read('src', 'app.js') + '\n</script>\n')

os.makedirs(os.path.join(ROOT, 'dist'), exist_ok=True)
with open(os.path.join(ROOT, 'dist', 'daily-red.html'), 'w', encoding='utf-8') as f:
    f.write(body)
page = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        '</head>\n<body>\n' + body + '</body>\n</html>\n')
with open(os.path.join(ROOT, 'index.html'), 'w', encoding='utf-8') as f:
    f.write(page)
print('built index.html (%d bytes) for repo %r' % (len(page), REPO))
