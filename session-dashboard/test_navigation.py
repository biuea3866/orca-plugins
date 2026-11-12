import json
from pathlib import Path
import subprocess
import unittest

from build_local_orca import patch_renderer


ROOT = Path(__file__).parent


class NavigationTests(unittest.TestCase):
    def run_js(self, script, source):
        subprocess.run(['node', '-e', script], input=json.dumps(source), text=True, check=True, capture_output=True)

    def test_inflight_focus_survives_panel_refresh_and_reads_current_handles(self):
        source = '''function z({tabKey:e}){let o=state,v="biuea3866.orca-session-dashboard",y="sessions",f="token",m="frame",S="frame",g={current:{contentWindow:target}};return(0,C.useEffect)(()=>{if(!f||!x)return;});}
const refresh=()=>a.html!==n&&(n=a.html,r+=1,i(e,`healthy`),l({status:`ready`,shellHtml:a.html,documentRevision:r}));'''
        script = '''
const vm=require('node:vm'),assert=require('node:assert/strict');
const source=JSON.parse(require('node:fs').readFileSync(0,'utf8'));
const refs=[],effects=[],handlers=new Set(),messages=[],calls=[];
let slot=0,resolve;
const C={useRef(value){const i=slot++;return refs[i]||(refs[i]={current:value});},
 useEffect(fn,deps){const i=slot++,old=effects[i];if(old&&deps&&deps.every((v,j)=>Object.is(v,old.deps[j])))return;
 old?.cleanup?.();effects[i]={deps,cleanup:fn()};}};
const target={postMessage(message){messages.push(message);}};
const context={C,target,state:{status:'ready',panelData:{snapshot:{sessions:[{terminalHandle:'term_old'}]}}},x:null,
 setTimeout,clearTimeout,window:{addEventListener(type,h){handlers.add(h)},removeEventListener(type,h){handlers.delete(h)},
 api:{runtime:{call(args){calls.push(args);return new Promise(r=>resolve=r)}}}}};
vm.createContext(context);vm.runInContext(source,context);
const render=()=>{slot=0;context.z({tabKey:'tab'});};
(async()=>{render();const handler=[...handlers][0];
 handler({source:target,data:{type:'orca-dashboard-focus-terminal',requestId:'first',terminal:'term_old'}});
 await Promise.resolve();assert.equal(calls.length,1);
 context.state={status:'ready',panelData:{snapshot:{sessions:[{terminalHandle:'term_new'}]}}};render();
 assert.equal([...handlers][0],handler,'data refresh must not replace the active navigation handler');
 resolve({ok:true});await new Promise(r=>setImmediate(r));
 assert(messages.some(m=>m.requestId==='first'&&m.ok===true),'focus acknowledgment was lost');
 handler({source:target,data:{type:'orca-dashboard-focus-terminal',requestId:'second',terminal:'term_new'}});
 await Promise.resolve();assert.equal(calls[1].params.terminal,'term_new');resolve({ok:true});
 await new Promise(r=>setImmediate(r));
})().catch(e=>{console.error(e);process.exitCode=1});
'''
        self.run_js(script, patch_renderer(source))

    def test_focus_timeout_and_synchronous_failure_release_pending_request(self):
        script = '''
const vm=require('node:vm'),assert=require('node:assert/strict');
const source=JSON.parse(require('node:fs').readFileSync(0,'utf8'));
const messages=[],timers=new Map();let sequence=0,resolve,mode='hang';
const context={setTimeout(fn){const id=++sequence;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);}};
vm.createContext(context);vm.runInContext(source+';globalThis.create=createDashboardTerminalNavigation',context);
const target={postMessage(message){messages.push(message)}};
const options={pluginKey:'biuea3866.orca-session-dashboard',panelId:'sessions',getWindow:()=>target,
 getData:()=>({snapshot:{sessions:[{terminalHandle:'term_test'}]}}),isActive:()=>true,
 focus:()=>{if(mode==='throw')throw Error('sync failure');return new Promise(r=>resolve=r)}};
const handler=context.create(options),event=id=>({source:target,data:{type:'orca-dashboard-focus-terminal',requestId:id,terminal:'term_test'}});
(async()=>{handler(event('r1'));await Promise.resolve();[...timers.values()][0]();
 assert.equal(messages[0].ok,false);assert.match(messages[0].error,/시간/);
 resolve({ok:true});await new Promise(r=>setImmediate(r));assert.equal(messages.length,1,'late reply must be ignored');
 mode='throw';handler(event('r2'));await new Promise(r=>setImmediate(r));assert.equal(messages[1].requestId,'r2');
 assert.equal(messages[1].ok,false);assert.equal(timers.size,0);
})().catch(e=>{console.error(e);process.exitCode=1});
'''
        self.run_js(script, (ROOT / 'host-patch/dashboard-terminal-navigation.js').read_text())
