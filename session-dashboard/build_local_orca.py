#!/usr/bin/env python3
"""Build a separate, reversible Orca 1.4.222 copy with persistent panel data."""
import hashlib
import json
from pathlib import Path
import plistlib
import struct
import subprocess

ROOT = Path(__file__).resolve().parent
SOURCE = Path('/Applications/Orca.app')
TARGET = Path.home() / 'Applications/Orca Dashboard.app'
ASSET = 'out/renderer/assets/PluginPanel-BFzNhXB8.js'


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError('Unsupported Orca renderer; expected code not found')
    return text.replace(old, new, 1)


def patch_renderer(text):
    helper = (ROOT / 'host-patch/panel-data-document.js').read_text()
    text = helper + text
    text = replace_once(text,
        'return(0,v.useEffect)(()=>{if(!s||!_)return;',
        'return(0,v.useEffect)(()=>{if(a.status===`ready`&&l===y&&a.panelData!==void 0)f.current?.contentWindow?.postMessage({type:PANEL_DATA_TYPE,data:a.panelData},`*`)},[a,l,y]),(0,v.useEffect)(()=>{if(!s||!_)return;')
    text = replace_once(text,
        'a.html!==n&&(n=a.html,i+=1,r(e,`healthy`),o({status:`ready`,shellHtml:a.html,documentRevision:i}))',
        '(()=>{const document=readPanelDataDocument(a.html);if(document.identity!==n){n=document.identity;i+=1;r(e,`healthy`);o({status:`ready`,shellHtml:a.html,documentRevision:i,panelData:document.data})}else if(document.data!==void 0){o(previous=>previous.status===`ready`?{...previous,panelData:document.data}:previous)}})()')
    return add_terminal_navigation(text)


def add_terminal_navigation(text):
    helper = (ROOT / 'host-patch/dashboard-terminal-navigation.js').read_text()
    hook = '''(0,v.useEffect)(()=>{if(!s||a.status!==`ready`)return;let active=true;const handler=createDashboardTerminalNavigation({pluginKey:m,panelId:h,getWindow:()=>f.current?.contentWindow??null,getData:()=>a.panelData,isActive:()=>active,focus:terminal=>window.api.runtime.call({method:`terminal.focus`,params:{terminal,navigation:`host`}})});window.addEventListener(`message`,handler);return()=>{active=false;window.removeEventListener(`message`,handler)}},[m,h,s,a]),'''
    return helper + replace_once(text, 'return(0,v.useEffect)(()=>{if(a.status===`ready`', 'return' + hook + '(0,v.useEffect)(()=>{if(a.status===`ready`')


def entries(tree, prefix=''):
    for name, value in tree.items():
        path = prefix + name
        if 'files' in value:
            yield from entries(value['files'], path + '/')
        elif not value.get('unpacked') and 'offset' in value:
            yield path, value


def repack(source, target, renderer_transform=patch_renderer):
    with source.open('rb') as reader:
        sizes = struct.unpack('<4I', reader.read(16))
        tree = json.loads(reader.read(sizes[3]))
        base = 8 + sizes[1]
        files = sorted(entries(tree['files']), key=lambda item: int(item[1]['offset']))
        replacements = {}
        next_offset = 0
        for name, metadata in files:
            old_offset = int(metadata['offset'])
            old_size = metadata['size']
            if name == ASSET:
                reader.seek(base + old_offset)
                data = renderer_transform(reader.read(old_size).decode()).encode()
                replacements[name] = data
                metadata['size'] = len(data)
                block_size = metadata['integrity']['blockSize']
                metadata['integrity']['hash'] = hashlib.sha256(data).hexdigest()
                metadata['integrity']['blocks'] = [hashlib.sha256(data[i:i+block_size]).hexdigest() for i in range(0,len(data),block_size)]
                (ROOT / 'host-patch/PluginPanel.patched.mjs').write_bytes(data)
            metadata['_originalOffset'] = old_offset
            metadata['_originalSize'] = old_size
            metadata['offset'] = str(next_offset)
            next_offset += metadata['size']
        if len(replacements) != 1:
            raise ValueError('Expected renderer asset missing')
        originals = {name:(meta.pop('_originalOffset'),meta.pop('_originalSize')) for name,meta in files}
        raw_header = json.dumps(tree,separators=(',',':'),ensure_ascii=False).encode()
        padding = (-len(raw_header)) % 4
        header_size = 8 + len(raw_header) + padding
        with target.open('wb') as writer:
            writer.write(struct.pack('<4I',4,header_size,header_size-4,len(raw_header)))
            writer.write(raw_header + b'\0' * padding)
            for name, metadata in files:
                if name in replacements:
                    writer.write(replacements[name])
                    continue
                offset, remaining = originals[name]
                reader.seek(base + offset)
                while remaining:
                    data = reader.read(min(remaining,1024*1024))
                    if not data: raise ValueError('Truncated source archive')
                    writer.write(data)
                    remaining -= len(data)
        return hashlib.sha256(raw_header).hexdigest()


def main():
    info = plistlib.load((SOURCE / 'Contents/Info.plist').open('rb'))
    if info.get('CFBundleShortVersionString') != '1.4.222':
        raise SystemExit('This local patch supports Orca 1.4.222 only')
    if TARGET.exists():
        raise SystemExit(f'Refusing to overwrite existing app: {TARGET}')
    TARGET.parent.mkdir(parents=True,exist_ok=True)
    subprocess.run(['ditto',str(SOURCE),str(TARGET)],check=True)
    archive = TARGET / 'Contents/Resources/app.asar'
    temporary = archive.with_suffix('.patched')
    header_hash = repack(SOURCE / 'Contents/Resources/app.asar',temporary)
    temporary.replace(archive)
    info['ElectronAsarIntegrity']['Resources/app.asar']['hash'] = header_hash
    with (TARGET / 'Contents/Info.plist').open('wb') as writer: plistlib.dump(info,writer)
    (TARGET / 'Contents/Resources/native-plugin-panel-data-support.json').write_text('{"version":1}')
    subprocess.run(['node','--check',str(ROOT / 'host-patch/PluginPanel.patched.mjs')],check=True)
    # Ad-hoc developer copies have no Team ID. Preserve the existing
    # entitlements and allow their Electron framework to load locally.
    signed = subprocess.run(['codesign','-d','--entitlements',':-',str(SOURCE)],capture_output=True,check=True)
    entitlements = plistlib.loads(signed.stdout)
    entitlements['com.apple.security.cs.disable-library-validation'] = True
    entitlements_path = ROOT / 'host-patch/local-entitlements.plist'
    entitlements_path.write_bytes(plistlib.dumps(entitlements))
    subprocess.run(['codesign','--force','--sign','-','--preserve-metadata=entitlements,flags',str(TARGET / 'Contents/Frameworks/Electron Framework.framework')],check=True)
    subprocess.run(['codesign','--force','--deep','--sign','-','--options','runtime','--entitlements',str(entitlements_path),str(TARGET)],check=True)
    subprocess.run(['codesign','--verify','--deep','--strict',str(TARGET)],check=True)
    print(TARGET)


if __name__ == '__main__': main()
