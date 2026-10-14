import json
import subprocess
import unittest
from build_local_orca import patch_renderer


class HostPatchTests(unittest.TestCase):
    def test_current_renderer_sends_data_without_revising_the_frame(self):
        source = ('function z({tabKey:e}){return(0,C.useEffect)(()=>{if(!f||!x)return;});}'
                  'const refresh=()=>a.html!==n&&(n=a.html,r+=1,i(e,`healthy`),'
                  'l({status:`ready`,shellHtml:a.html,documentRevision:r}));')
        patched = patch_renderer(source)
        self.assertIn('document.identity!==n', patched)
        self.assertIn('panelData:document.data', patched)
        self.assertIn('postMessage({type:PANEL_DATA_TYPE,data:o.panelData}', patched)
        self.assertIn('createDashboardTerminalNavigation({pluginKey:v,panelId:y', patched)
        script = '''
const vm=require('node:vm'),assert=require('node:assert/strict');
const context={};vm.createContext(context);
vm.runInContext(JSON.parse(require('node:fs').readFileSync(0,'utf8'))+';globalThis.read=readPanelDataDocument;',context);
const page=value=>'<h1>Dashboard</h1><script type="application/json" id="orca-panel-data">'+JSON.stringify(value)+'</script>';
const first=context.read(page({count:1})),next=context.read(page({count:2}));
assert.equal(first.identity,next.identity);
assert.equal(next.data.count,2);
assert.notEqual(next.identity,context.read('<h2>Changed UI</h2>'+page({count:2})).identity);
'''
        subprocess.run(['node', '-e', script], input=json.dumps(patched), text=True, check=True, capture_output=True)

    def test_unknown_renderer_is_rejected(self):
        with self.assertRaises(ValueError):
            patch_renderer('function changedRenderer() {}')


if __name__ == '__main__':
    unittest.main()
