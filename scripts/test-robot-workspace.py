import json, time, tempfile, threading, subprocess, base64, os, shutil
# Browser workflow regression. Requires Chrome/Chromium and Python websockets.
# All machine responses are simulated; this never connects to a controller.
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from websockets.sync.client import connect
ROOT=Path(__file__).resolve().parents[1]
CHROME=os.environ.get('CHROME_BIN') or shutil.which('chromium') or shutil.which('google-chrome') or '/Applications/Chrome.app/Contents/MacOS/Google Chrome'
class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs): super().__init__(*args,directory=str(ROOT),**kwargs)
    def log_message(self,*args): pass
    def do_GET(self):
        if os.environ.get('ROBOT_TCP_JOG_ONLY') and self.path.split('?')[0]=='/plugins/robot-studio/tcp-gizmo.js':
            source=(ROOT/'plugins/robot-studio/tcp-gizmo.js').read_text()+'''\nconst originalTcpGizmo=createRobotTcpGizmo;
            globalThis.createRobotTcpGizmo=options=>{const api=originalTcpGizmo(options);window.tcpGizmoTest={...options,api};return api;};'''
            self.send_response(200);self.send_header('Content-Type','text/javascript');self.end_headers();self.wfile.write(source.encode());return
        if not self.path.startswith('/test-host'): return super().do_GET()
        bridge=(ROOT/'src/components/PluginFrame.tsx').read_text()
        theme=bridge.split('const themeScript = `',1)[1].split('`',1)[0].replace('${JSON.stringify(themeVars)}', '{}')
        plugin=(ROOT/'plugins/robot-studio/index.html').read_text().replace('<head>','<head><base href="/plugins/robot-studio/">'+theme,1)
        body=r'''<!doctype html><style>body{margin:0}iframe{border:0;width:100vw;height:100vh;display:block}</style><iframe sandbox="allow-scripts allow-forms allow-popups allow-downloads"></iframe><script>
        window.commands=[];window.machine={state:'Idle',mpos:{x:0,y:0,z:0,a:0,b:0,c:0}};window.goals=[];window.cursor=-1;window.telemetry=true;window.sessionState={generation:0,data:null};window.saved={};window.failUpload=false;let sdProgram=null, doneMarker, nextGoalAt=0;
        const frame=document.querySelector('iframe');frame.srcdoc=PLUGIN;
        const line=data=>frame.contentWindow.postMessage({type:'fluid-event',event:'line',data},'*');
        const report=()=>telemetry&&frame.contentWindow.postMessage({type:'fluid-event',event:'status',data:machine},'*');
        window.addEventListener('message',e=>{
          const m=e.data;if(m?.type!=='fluid-request')return;commands.push(m);let result=null,error=null;
          if(['sendJog','endJog'].includes(m.method)) error='Unknown method: '+m.method;
          if(m.method==='getStatus')result=machine;
          if(m.method==='getSettings')result=saved;
          if(m.method==='getLocalState'){
            try {result=JSON.parse(localStorage.getItem('test.robot-workspace'));}
            catch(e){error=String(e);}
          }
          if(m.method==='setLocalState'){
            try {localStorage.setItem('test.robot-workspace',JSON.stringify(m.params.data));}
            catch(e){error=String(e);}
          }
          if(m.method==='saveSettings'){
            if(window.failSave)error='Simulated save failure';
            else if(window.deferSave){window.finishSave=()=>{saved=m.params.data;frame.contentWindow.postMessage({type:'fluid-response',id:m.id,result:null},'*');};return;}
            else saved=m.params.data;
          }
          if(m.method==='getSessionState')result=sessionState;
          if(m.method==='setSessionState'){
            if(m.params.generation!==sessionState.generation)error='Controller session changed';
            else sessionState.data=m.params.data;
          }
          if(m.method==='readFile'){
            if(sdProgram===null)error='HTTP 404';
            else result=sdProgram;
          }
          if(m.method==='writeFile'){
            if(failUpload)error='Simulated upload failure';
            else sdProgram=m.params.content;
          }
          if(m.method==='startProgramFile'){
            const markers=[...sdProgram.matchAll(/\(MSG,(ROBOT_STUDIO_[0-9A-F]+_(?:START|DONE))\)/g)];
            window.goals=sdProgram.split('\n').filter(l=>/^G9[34] G53 G1 /.test(l))
              .map(l=>Object.fromEntries([...l.matchAll(/([XYZABC])(-?[\d.]+)/g)].map(v=>[v[1].toLowerCase(),Number(v[2])])));
            machine.state='Run';machine.sdFilename=m.params.path;window.cursor=0;
            nextGoalAt=performance.now()+1500;
            doneMarker=markers[1][1];line('[MSG:INFO: '+markers[0][1]+']');
            result={started:true};
          }
          if(m.method==='sendRealtime'){
            if(m.params.byte===33)machine.state='Hold';
            if(m.params.byte===126&&cursor>=0)machine.state='Run';
            if(m.params.byte===24){machine.state='Idle';window.cursor=-1;delete machine.sdFilename;}
            if(m.params.byte===63)report();
          }
          frame.contentWindow.postMessage({type:'fluid-response',id:m.id,result,error},'*');
        });
        setInterval(()=>{
          if(cursor<0||machine.state!=='Run'||performance.now()<nextGoalAt)return;
          if(cursor<goals.length)Object.assign(machine.mpos,goals[cursor++]);
          else {cursor=-1;machine.state='Idle';delete machine.sdFilename;line('[MSG:INFO: '+doneMarker+']');report();}
        },100);setInterval(report,100);
        </script>'''.replace('PLUGIN',json.dumps(plugin).replace('</',r'<\/'))
        self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(body.encode())
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
profile=tempfile.mkdtemp(prefix='robot-workspace-')
log=open(Path(profile)/'chrome.log','w')
chrome=subprocess.Popen([CHROME,'--headless=new',f'--user-data-dir={profile}','--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-background-networking','--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE 127.0.0.1','about:blank'],stdout=log,stderr=log)
try:
    portfile=Path(profile)/'DevToolsActivePort'
    for _ in range(150):
        if portfile.exists():break
        time.sleep(.1)
    port,endpoint=portfile.read_text().splitlines()[:2]
    with connect(f'ws://127.0.0.1:{port}{endpoint}',max_size=None) as ws:
        seq=0;events=[]
        def call(method,params=None,session=None):
            global seq
            seq+=1;req={'id':seq,'method':method,'params':params or {}}
            if session:req['sessionId']=session
            ws.send(json.dumps(req))
            while True:
                r=json.loads(ws.recv(timeout=30))
                if r.get('id')==seq:
                    if 'error'in r:raise RuntimeError(r['error'])
                    return r.get('result',{})
                events.append(r)
        target=call('Target.createTarget',{'url':'about:blank'})['targetId'];session=call('Target.attachToTarget',{'targetId':target,'flatten':True})['sessionId']
        call('Runtime.enable',session=session);call('Network.enable',session=session);call('Page.bringToFront',session=session)
        context=None
        def evaluate(js):
            params={'expression':js,'returnByValue':True,'awaitPromise':True}
            if context:params['contextId']=context
            r=call('Runtime.evaluate',params,session)
            if 'exceptionDetails'in r:raise RuntimeError(r['exceptionDetails'])
            return r['result'].get('value')
        def wait(js):
            for _ in range(150):
                if evaluate(js):return
                time.sleep(.1)
            raise RuntimeError('Timed out: '+js+'\n'+str(evaluate('document.body.innerText')))
        def click(selector):evaluate(f'(() => {{const el=document.querySelector({json.dumps(selector)}); if(el.click)el.click();else el.dispatchEvent(new MouseEvent("click",{{bubbles:true}}));}})()')
        def screenshot(name):
            evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
            time.sleep(.3)
            r=call('Page.captureScreenshot',{'format':'png'},rootSession if 'rootSession' in globals() else session);Path(profile, 'robot-'+name+'.png').write_bytes(base64.b64decode(r['data']))
        url=f'http://127.0.0.1:{server.server_port}'

        call('Emulation.setDeviceMetricsOverride',{'width':1440,'height':1000,'deviceScaleFactor':1,'mobile':False},session)
        call('Page.navigate',{'url':url+'/test-host'},session)
        wait('!!document.querySelector("iframe")')
        rootSession=session
        for _ in range(100):
            targets=call('Target.getTargets')['targetInfos']
            iframeTarget=next((t for t in targets if t['type']=='iframe'),None)
            if iframeTarget:break
            time.sleep(.1)
        session=call('Target.attachToTarget',{'targetId':iframeTarget['targetId'],'flatten':True})['sessionId']
        call('Runtime.enable',session=session);context=None
        wait('!!document.querySelector("#viewer canvas") && !document.querySelector("#viewer-loading")')
        def host(js):
            result=call('Runtime.evaluate',{'expression':js,'returnByValue':True,'awaitPromise':True},rootSession)
            if 'exceptionDetails' in result: raise RuntimeError(result['exceptionDetails'])
            return result['result'].get('value')
        def change(selector, value):
            evaluate(f'(()=>{{const el=document.querySelector({json.dumps(selector)});el.value={json.dumps(value)};el.dispatchEvent(new Event("change"));}})()')
        def visible(selector):
            return evaluate(f'(()=>{{const e=document.querySelector({json.dumps(selector)}),r=e.getBoundingClientRect();return !!e.getClientRects().length&&getComputedStyle(e).visibility!=="hidden"&&r.height>0;}})()')
        def on_screen(selector):
            return evaluate(f'(()=>{{const r=document.querySelector({json.dumps(selector)}).getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth;}})()')
        def rose(axis=0, sign=1, step='1', container='joint-rose'):
            return f'#{container} [data-rose-axis="{axis}"][data-rose-sign="{sign}"][data-rose-step="{step}"]'
        def rose_xy(axis=0, sign=1, container='joint-rose'):
            # Coordinates of a held quadrant, transformed from SVG to viewport.
            return evaluate(f'(()=>{{const svg=document.querySelector("#{container} svg");const p=new DOMPoint({70*sign if axis==0 else 0},{-70*sign if axis==1 else 0}).matrixTransform(svg.getScreenCTM());return {{x:p.x,y:p.y}};}})()')
        def mouse(kind, xy):
            call('Input.dispatchMouseEvent',{'type':kind,**xy,'button':'left','buttons':0 if kind=='mouseReleased' else 1,'clickCount':1},session)
        wait('document.querySelector("#message").textContent.includes("No saved project")')
        if os.environ.get('ROBOT_TCP_JOG_ONLY'):
            wait('!document.querySelector("#toggle-tcp-jog").disabled')
            click('#toggle-tcp-jog')
            wait('window.tcpGizmoTest.scene.getObjectByName("tcp-jog-handles").visible')
            assert visible('#cartesian-panel')
            assert evaluate('document.querySelector("#toggle-tcp-jog").getAttribute("aria-pressed")')=='true'
            click('#cartesian-working-pose')
            # Use a pose with room to translate in every direction; the upright
            # working-pose helper can still lie on a Cartesian reach boundary.
            for index,angle in enumerate([25,-65,80,-35,60,25]):
                change('#joint-input-'+str(index),angle)
            evaluate('window.tcpTestPose=()=>RobotCore.forward(RobotCore.defaultConfig(),Array.from({length:6},(_,i)=>Number(document.querySelector("#joint-input-"+i).value))).tcp')
            for frame in ['world','tool']:
                change('#jog-frame',frame)
                for axis in range(3):
                    evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
                    evaluate('window.beforeTcp=tcpTestPose();window.beforeCamera=tcpGizmoTest.camera.position.toArray()')
                    coordinates=evaluate('''(()=>{
                      const {scene,camera,element}=tcpGizmoTest,{THREE}=RobotGraphics;
                      const group=scene.getObjectByName('tcp-jog-handles');group.updateMatrixWorld(true);
                      const axis=AXIS,direction=new THREE.Vector3().setComponent(axis,1).applyQuaternion(group.quaternion);
                      const start=group.position.clone().addScaledVector(direction,group.scale.x*.65);
                      window.testDirection=direction.toArray();
                      const rect=element.getBoundingClientRect();
                      const screen=p=>{p.project(camera);return {x:rect.left+(p.x+1)*rect.width/2,y:rect.top+(1-p.y)*rect.height/2}};
                      return {start:screen(start.clone()),end:screen(start.addScaledVector(direction,5))};
                    })()'''.replace('AXIS',str(axis)))
                    mouse('mousePressed',coordinates['start'])
                    assert evaluate('tcpGizmoTest.api.dragging'), (frame,axis,'not picked')
                    assert not evaluate('tcpGizmoTest.controls.enabled')
                    mouse('mouseMoved',coordinates['end'])
                    # Telemetry refreshes during a held drag must not restore orbit or replace its seed.
                    time.sleep(.2)
                    assert evaluate('JSON.stringify(tcpGizmoTest.camera.position.toArray())===JSON.stringify(beforeCamera)')
                    mouse('mouseReleased',coordinates['end'])
                    assert not evaluate('tcpGizmoTest.api.dragging')
                    assert evaluate('tcpGizmoTest.controls.enabled')
                    residual=evaluate('''(()=>{const now=tcpTestPose();return {
                      position:RobotCore.norm([0,1,2].map(i=>now[i*4+3]-beforeTcp[i*4+3]-testDirection[i]*5)),
                      orientation:RobotCore.norm(RobotCore.rotationError(beforeTcp,now))*RobotCore.DEG,
                      result:document.querySelector('#ik-result').textContent};})()''')
                    # Exact inputs display two decimal places, so FK from those rounded joints has a small extra residual.
                    assert residual['position']<.3 and residual['orientation']<.1, (frame,axis,residual)
                    assert 'drag' in residual['result'], residual
            screenshot('tcp-jog')
            # Stop and opening another control must release ownership even while the pointer is held.
            mouse('mousePressed',coordinates['end'])
            click('#quick-stop')
            assert not evaluate('tcpGizmoTest.api.dragging')
            mouse('mouseReleased',coordinates['end'])
            click('#toggle-tcp-jog')
            assert not evaluate('tcpGizmoTest.scene.getObjectByName("tcp-jog-handles").visible')
            assert host('commands.filter(c=>c.method==="sendJog"||(c.method==="sendCommand"&&c.params.command.startsWith("$J="))).length')==0
            assert not [e for e in events if e.get('method')=='Runtime.exceptionThrown'], 'Uncaught browser exception'
            print('TCP jog browser regressions passed: all world/tool axes, IK targets, fixed tool orientation, orbit isolation, stop and zero physical jog dispatch.')
            print('Screenshots:',profile)
            raise SystemExit(0)
        if os.environ.get('ROBOT_LOCAL_STORAGE_ONLY'):
            # Browser persistence works through the host even though the
            # plugin itself has an opaque origin and cannot use localStorage.
            assert evaluate('(()=>{try{localStorage.getItem("test");return false}catch{return true}})()')
            click('#mode-target')
            click('#setup-tab');click('#configure')
            wait('!!document.querySelector("#config-viewer canvas")')
            change('#config-name', 'Remembered robot')
            evaluate('document.querySelector("#dimension-a2").value=90;document.querySelector("#dimension-a2").dispatchEvent(new Event("input",{bubbles:true}))')
            change('#dh-3-home', -75)
            click('#config-form button[type=submit]')
            wait('!document.querySelector("#config-dialog").open')
            click('[data-workspace="program"]');click('#teach-point')
            wait('document.querySelector("#nav-point-count").textContent==="1"')
            wait('document.querySelector("#project-save-state").textContent==="Unsaved changes"')
            for _ in range(100):
                cached=host('JSON.parse(localStorage.getItem("test.robot-workspace"))')
                if cached and len(cached['project']['points'])==1:break
                time.sleep(.05)
            assert cached['project']['config']['name']=='Remembered robot'
            assert cached['project']['config']['joints'][1]['a']==-90, cached['project']['config']
            assert cached['project']['config']['joints'][3]['home']==-75
            assert len(cached['project']['points'])==1
            assert host('commands.filter(c=>c.method==="saveSettings").length')==0
            def reopen(expected='restored'):
                global session
                previous={t['targetId'] for t in call('Target.getTargets')['targetInfos'] if t['type']=='iframe'}
                call('Target.detachFromTarget',{'sessionId':session})
                session=rootSession
                call('Page.reload',session=session)
                for _ in range(150):
                    targets=call('Target.getTargets')['targetInfos']
                    candidate=next((t for t in targets if t['type']=='iframe' and t['targetId'] not in previous),None)
                    if candidate:
                        session=call('Target.attachToTarget',{'targetId':candidate['targetId'],'flatten':True})['sessionId']
                        wait('!!document.querySelector("#viewer canvas") && document.querySelector("#message").textContent.includes('+json.dumps(expected)+')')
                        return
                    time.sleep(.1)
                raise RuntimeError('Browser workspace did not restore')
            reopen()
            assert evaluate('document.querySelector("#robot-name").textContent')=='Remembered robot'
            assert evaluate('document.querySelector("#nav-point-count").textContent')=='1'
            assert evaluate('document.querySelector("#project-save-state").textContent')=='Unsaved changes'
            assert 'reference required' in evaluate('document.querySelector("#reference-state").textContent')
            assert host('commands.filter(c=>c.method==="getSettings").length')==0
            assert host('commands.filter(c=>c.method==="sendCommand"||c.method==="sendJog").length')==0
            click('#setup-tab');click('#configure')
            wait('!!document.querySelector("#config-viewer canvas")')
            assert float(evaluate('document.querySelector("#dimension-a2").value'))==90
            assert float(evaluate('document.querySelector("#dh-3-home").value'))==-75
            click('[data-close="config-dialog"]')
            screenshot('browser-restored-workspace')
            # Loading JSON also updates the browser copy, without Save project.
            imported=cached['project']
            imported['config']['name']='Imported robot'
            imported['config']['joints'][1]['a']=-125
            evaluate('(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['+json.dumps(json.dumps(imported))+'],"robot.json",{type:"application/json"}));const input=document.querySelector("#project-file");input.files=transfer.files;input.dispatchEvent(new Event("change"));})()')
            wait('document.querySelector("#replace-dialog").open');click('#replace-confirm')
            wait('document.querySelector("#robot-name").textContent==="Imported robot"')
            for _ in range(100):
                if host('JSON.parse(localStorage.getItem("test.robot-workspace")).project.config.name')=='Imported robot':break
                time.sleep(.05)
            reopen()
            assert evaluate('document.querySelector("#robot-name").textContent')=='Imported robot'
            assert evaluate('document.querySelector("#nav-point-count").textContent')=='1'
            assert host('commands.filter(c=>c.method==="getSettings"||c.method==="sendCommand"||c.method==="sendJog").length')==0
            # Invalid browser data cannot prevent the normal saved-project load.
            host('localStorage.setItem("test.robot-workspace","invalid JSON")')
            reopen('No saved project')
            assert evaluate('document.querySelector("#robot-name").textContent')=='Standard arm · 6-axis'
            assert host('commands.filter(c=>c.method==="getSettings").length')==1
            print('Browser persistence passed: sandbox bridge, automatic configuration/import/waypoint saves, reload restore, dirty state, corrupt-cache fallback, and fresh physical reference required without motion or SD writes.')
            print('Screenshots:',profile)
            raise SystemExit(0)
        # Live configuration uses the real renderer and never applies a draft.
        click('#setup-tab');click('#configure')
        wait('!!document.querySelector("#config-viewer canvas") && document.querySelector("#config-viewer-loading").hidden')
        # Capture calls and rendering state without adding test hooks to the app.
        evaluate("""(()=>{
          const original=window.createRobotViewer;
          window.previewCalls=[];window.previewDisposals=0;
          window.createRobotViewer=async(...args)=>{
            const result=await original(...args);
            if(args[0].id==='config-viewer'){
              const configure=result.configure,dispose=result.dispose;
              result.configure=(...values)=>{previewCalls.push(JSON.parse(JSON.stringify(values)));return configure(...values);};
              result.dispose=()=>{previewDisposals++;return dispose();};
            }
            return result;
          };
        })()""")
        click('[data-close="config-dialog"]')
        wait('!document.querySelector("#config-viewer canvas")')
        click('#configure')
        wait('!!document.querySelector("#config-viewer canvas") && document.querySelector("#config-viewer-loading").hidden')
        evaluate('document.querySelector("#dimension-a2").focus();document.querySelector("#dimension-a2").value=90;document.querySelector("#dimension-a2").dispatchEvent(new Event("input",{bubbles:true}))')
        wait('previewCalls.length>0 && previewCalls.at(-1)[0].joints[1].a===-90')
        assert '90 mm' in evaluate('document.querySelector("#config-measurement").textContent')
        assert evaluate('document.activeElement.id')=='dimension-a2'
        assert evaluate('previewCalls.at(-1)[2].fit')==False
        assert float(evaluate('document.querySelector("#dh-1-a").value'))==-90
        count=evaluate('previewCalls.length')
        evaluate('document.querySelector("#dimension-a2").value="";document.querySelector("#dimension-a2").dispatchEvent(new Event("input",{bubbles:true}))')
        wait('document.querySelector("#config-preview-status").textContent.includes("last valid")')
        assert evaluate('previewCalls.length')==count
        assert evaluate('document.activeElement.id')=='dimension-a2'
        evaluate('document.querySelector("#dimension-a2").value=90;document.querySelector("#dimension-a2").dispatchEvent(new Event("input",{bubbles:true}))')
        wait('!document.querySelector("#config-preview-status").classList.contains("error")')
        for dimension,value in zip(['d1','a2','a3','d4','d5','d6'],[117,90,80,80,50,90]):
            evaluate(f'document.querySelector("#dimension-{dimension}").focus();document.querySelector("#dimension-{dimension}").value={value};document.querySelector("#dimension-{dimension}").dispatchEvent(new Event("input",{{bubbles:true}}))')
            wait(f'document.querySelector("#config-measurement").textContent.includes("{value} mm")')
        evaluate('document.querySelector("#dh-2-a").value=-110;document.querySelector("#dh-2-a").dispatchEvent(new Event("input",{bubbles:true}))')
        wait('previewCalls.at(-1)[0].joints[2].a===-110')
        assert float(evaluate('document.querySelector("#dimension-a3").value'))==110
        evaluate('document.querySelector("#dh-2-home").value=35;document.querySelector("#dh-2-home").dispatchEvent(new Event("input",{bubbles:true}))')
        wait('previewCalls.at(-1)[1][2]===35')
        evaluate('document.querySelector("#tool-z").value=45;document.querySelector("#tool-z").dispatchEvent(new Event("input",{bubbles:true}))')
        wait('previewCalls.at(-1)[0].tool.z===45')
        evaluate('document.querySelector("#base-rz").value=30;document.querySelector("#base-rz").dispatchEvent(new Event("input",{bubbles:true}))')
        wait('previewCalls.at(-1)[0].base.rz===30')
        # Refit and view shortcuts work without submitting or resetting the draft.
        for view in ['front','top','perspective']:
            click(f'[data-config-view="{view}"]')
            assert evaluate(f'document.querySelector({json.dumps(f"[data-config-view={view}]")}).getAttribute("aria-pressed")')=='true'
            assert evaluate('document.querySelector("#config-dialog").open')
        click('#config-view-fit')
        for width in [1440,768,390,320]:
            call('Emulation.setDeviceMetricsOverride',{'width':width,'height':1000,'deviceScaleFactor':1,'mobile':False},rootSession)
            evaluate('document.querySelector("#config-dialog").scrollTop=0')
            wait('document.querySelector("#config-viewer canvas").clientWidth>0')
            assert evaluate('document.querySelector("#config-dialog").scrollWidth<=document.querySelector("#config-dialog").clientWidth+1'), f'Configuration overflow at {width}px'
            screenshot(f'config-live-{width}')
        call('Emulation.setDeviceMetricsOverride',{'width':1440,'height':1000,'deviceScaleFactor':1,'mobile':False},rootSession)
        click('[data-close="config-dialog"]')
        wait('!document.querySelector("#config-viewer canvas")')
        assert evaluate('previewDisposals')==1
        click('#configure')
        wait('!!document.querySelector("#config-viewer canvas")')
        assert float(evaluate('document.querySelector("#dimension-a2").value'))==600, 'Cancel must discard the draft'
        # Custom DH layouts keep their 3D preview even without dimension shortcuts.
        change('#robot-preset','legacy');click('#default-config')
        wait('document.querySelector("#config-viewer-loading").hidden')
        assert evaluate('document.querySelector("#dimension-fields").hidden')
        assert visible('#config-viewer canvas')
        click('[data-close="config-dialog"]')
        wait('!document.querySelector("#config-viewer canvas")')
        change('#robot-preset','standard')
        click('#joint-tab')
        assert host('commands.filter(c=>c.method==="sendCommand"||c.method==="sendJog").length')==0
        assert not [e for e in events if e.get('method')=='Runtime.exceptionThrown'], 'Uncaught configuration browser exception'
        if os.environ.get('ROBOT_CONFIG_ONLY'):
            print('Live configuration browser regressions passed: dimensions, DH synchronization, invalid drafts, home/base/tool edits, view controls, cancellation, disposal, custom geometry and 320–1440px layouts.')
            print('Screenshots:',profile)
            raise SystemExit(0)
        # Connected sessions start with Live + Hold selected, without sending a move.
        assert evaluate('document.querySelector("#mode-live").getAttribute("aria-pressed")')=='true'
        assert evaluate('document.querySelector("#rose-hold-mode").getAttribute("aria-pressed")')=='true'
        assert visible('#joint-rose') and visible('#wrist-rose')
        assert not evaluate('!!document.querySelector("[data-joint-group]")')
        click('#mode-target')
        # Project save feedback reflects the acknowledged snapshot, not newer edits.
        assert 'reference needed' in evaluate('document.querySelector("#machine-move").title')
        assert evaluate('document.querySelector("#project-save-state").textContent')=='New project'
        change('#joint-input-0',5)
        assert evaluate('document.querySelector("#project-save-state").textContent')=='Unsaved changes'
        host('deferSave=true;commands=[]')
        click('#save-project');click('#save-project')
        wait('document.querySelector("#save-project").disabled')
        assert host('commands.filter(c=>c.method==="saveSettings").length')==1
        change('#joint-input-0',10)
        host('finishSave();deferSave=false')
        wait('!document.querySelector("#save-project").disabled')
        assert host('saved.q[0]')==5
        assert evaluate('document.querySelector("#project-save-state").textContent')=='Unsaved changes'
        host('failSave=true');click('#save-project')
        wait('document.querySelector("#project-save-state").textContent==="Save failed"')
        assert host('saved.q[0]')==5
        host('failSave=false');click('#save-project')
        wait('document.querySelector("#project-save-state").textContent==="All changes saved"')
        assert host('saved.q[0]')==10
        click('#home-pose')
        # Real keyboard navigation follows the ARIA tab pattern.
        evaluate('document.querySelector("#joint-tab").focus()')
        call('Input.dispatchKeyEvent',{'type':'keyDown','key':'ArrowRight','code':'ArrowRight'},session)
        assert evaluate('document.activeElement.id')=='cartesian-tab'
        assert evaluate('document.querySelector("#cartesian-tab").getAttribute("aria-selected")')=='true'
        assert evaluate('document.querySelector("#joint-tab").tabIndex')==-1
        click('#joint-tab')
        evaluate('document.querySelector(".control-panel").scrollTop=100000')
        assert on_screen('#teach-point-move'), 'Capture action clipped while scrolling joints'
        evaluate('document.querySelector(".control-panel").scrollTop=0;document.activeElement.blur()')
        host('commands=[]')
        # Rose steps change only one virtual joint, with signed degree increments.
        assert not evaluate('document.querySelector("#exact-joints").open')
        click(rose()); assert float(evaluate('document.querySelector("#joint-input-0").value'))==1
        click(rose(0,-1,'0.1')); assert float(evaluate('document.querySelector("#joint-input-0").value'))==.9
        click(rose(2,1,'5')); assert float(evaluate('document.querySelector("#joint-input-2").value'))==5
        click(rose(2,-1,'1','wrist-rose'))
        assert float(evaluate('document.querySelector("#joint-input-5").value'))==-1
        change('#joint-input-0',360);click(rose(0,1,'5'))
        assert float(evaluate('document.querySelector("#joint-input-0").value'))==360
        assert evaluate('document.querySelector("#message").classList.contains("error")')
        click('#home-pose')
        assert host('commands.filter(c=>c.method==="sendCommand"||c.method==="sendJog").length')==0
        screenshot('primitive-upright')
        for joint,angle in enumerate([30,-65,80,-35,60,25]):
            change(f'#joint-input-{joint}',angle)
        click('#view-fit');screenshot('primitive-bent')
        # Cartesian rings retain world/tool frame semantics and never send motion.
        click('#cartesian-tab')
        change('#jog-frame','world');click('#target-current')
        # TCP fields retain mm precision; rounded joint inputs lose it on a long arm.
        get_tcp='RobotCore.poseMatrix(Object.fromEntries(["x","y","z","rx","ry","rz"].map(key=>[key,Number(document.querySelector("#target-"+key).value)])))'
        before=evaluate(get_tcp);click(rose(0,1,'0.1','cartesian-rose'));after=evaluate(get_tcp)
        assert abs(after[3]-before[3]-.1)<.02 and abs(after[7]-before[7])<.02 and abs(after[11]-before[11])<.02
        change('#jog-frame','tool');before=evaluate(get_tcp)
        click(rose(2,1,'1','cartesian-rose'));after=evaluate(get_tcp)
        assert all(abs(after[row*4+3]-before[row*4+3]-before[row*4+2])<.08 for row in range(3))
        click('[data-cart-group="3"]');before=evaluate(get_tcp)
        click(rose(2,1,'1','cartesian-rose'));after=evaluate(get_tcp)
        assert all(abs(after[index]-before[index])<.08 for index in [3,7,11])
        assert host('commands.filter(c=>c.method==="sendCommand"||c.method==="sendJog").length')==0
        screenshot('cartesian-rose')
        click('[data-cart-group="0"]');change('#jog-frame','world');click('#joint-tab')
        click('#home-pose')
        # Reproduce the user's small arm via the actual configuration editor.
        click('#setup-tab');click('#configure')
        for dimension,value in zip(['d1','a2','a3','d4','d5','d6'],[50,90,80,50,50,50]):
            evaluate(f'document.querySelector("#dimension-{dimension}").value={value};document.querySelector("#dimension-{dimension}").dispatchEvent(new Event("input"))')
        click('#config-form button[type=submit]');click('#joint-tab')
        screenshot('custom-50-90-80-upright')
        for joint,angle in enumerate([30,-65,80,-35,60,25]):
            change(f'#joint-input-{joint}',angle)
        click('#view-fit');screenshot('custom-50-90-80-bent')
        click('#setup-home');wait('!!document.querySelector("#home-viewer canvas")')
        screenshot('custom-50-90-80-reference')
        click('[data-close="home-dialog"]')
        wait('!document.querySelector("#home-viewer canvas")')
        click('#configure');click('#default-config');click('#config-form button[type=submit]')
        click('#joint-tab')
        # Initial state and first calibration. Activation itself sends no move.
        assert evaluate('document.querySelector("#save-gcode").disabled')
        click('#mode-live');wait('document.querySelector("#home-dialog").open')
        wait('!document.querySelector("#record-home").disabled')
        click('#record-home')
        wait('document.querySelector("#reference-state").textContent.startsWith("Reference set")')
        for _ in range(100):
            if host('sessionState.data?.zeros?.length===6'): break
            time.sleep(.05)
        assert host('sessionState.data?.zeros?.length===6')
        wait('document.querySelector("#mode-live").getAttribute("aria-pressed")==="true"')
        assert host('commands.filter(c=>c.method==="sendCommand"||c.method==="sendJog").length')==0
        # Live step requests use the same single-axis transport, never raw XYZ TCP moves.
        assert evaluate('document.querySelector("#rose-hold-mode").getAttribute("aria-pressed")')=='true'
        click('#rose-step-mode')
        click(rose())
        wait('document.querySelector("#joint-rose .rose-control").getAttribute("aria-disabled")==="true"')
        for _ in range(100):
            if host('commands.some(c=>c.method==="sendCommand"&&c.params.command.startsWith("$J="))'): break
            time.sleep(.05)
        assert host('commands.filter(c=>c.method==="sendCommand").at(-1).params.command').startswith('$J=G53 G90 G21 X1.00000 F')
        host('machine.mpos.x=1')
        wait('document.querySelector("#joint-rose .rose-control").getAttribute("aria-disabled")==="false"')
        # Pointer capture keeps a hold owned by its original sector until release.
        click('#rose-hold-mode');host('commands=[]')
        xy=rose_xy();mouse('mousePressed',xy)
        wait('!!document.querySelector("#joint-rose .pressed")')
        time.sleep(.2);mouse('mouseReleased',{'x':xy['x']-100,'y':xy['y']-100})
        wait('!document.querySelector("#joint-rose .pressed")')
        assert host('commands.some(c=>c.method==="sendRealtime"&&c.params.byte===133)')
        assert evaluate('document.querySelector("#mode-live").getAttribute("aria-pressed")')=='true'
        assert evaluate('document.querySelector("#joint-rose").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true}))')==False
        time.sleep(.3)
        # Key release cancels a hold; autorepeat cannot start extra gestures.
        host('commands=[]');evaluate(f'document.querySelector({json.dumps(rose(1,1,"hold"))}).focus()')
        call('Input.dispatchKeyEvent',{'type':'keyDown','key':'Enter','code':'Enter'},session)
        wait('!!document.querySelector("#joint-rose .pressed")')
        call('Input.dispatchKeyEvent',{'type':'keyDown','key':'Enter','code':'Enter','autoRepeat':True},session)
        time.sleep(.15)
        call('Input.dispatchKeyEvent',{'type':'keyUp','key':'Enter','code':'Enter'},session)
        wait('!document.querySelector("#joint-rose .pressed")')
        assert host('commands.some(c=>c.method==="sendRealtime"&&c.params.byte===133)')
        time.sleep(.3)
        # Touch cancellation must also cancel, and a second finger cannot own a jog.
        host('commands=[]');xy=rose_xy();other=rose_xy(1,1)
        call('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{**xy,'id':0}]},session)
        wait('!!document.querySelector("#joint-rose .pressed")')
        call('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{**xy,'id':0},{**other,'id':1}]},session)
        assert evaluate('document.querySelectorAll("#joint-rose .pressed").length')==1
        time.sleep(.15)
        call('Input.dispatchTouchEvent',{'type':'touchCancel','touchPoints':[]},session)
        wait('!document.querySelector("#joint-rose .pressed")')
        assert host('commands.some(c=>c.method==="sendRealtime"&&c.params.byte===133)')
        time.sleep(.3)
        # The second rose addresses J4-J6 directly, without changing groups.
        evaluate('document.querySelector("#wrist-rose").scrollIntoView({block:"center"})')
        host('commands=[]');xy=rose_xy(container='wrist-rose');mouse('mousePressed',xy)
        wait('!!document.querySelector("#wrist-rose .pressed")');time.sleep(.15)
        mouse('mouseReleased',xy)
        wait('!document.querySelector("#wrist-rose .pressed")')
        assert host('commands.some(c=>c.method==="sendCommand"&&/^\\$J=G53 G90 G21 A/.test(c.params.command))')
        assert host('commands.some(c=>c.method==="sendRealtime"&&c.params.byte===133)')
        screenshot('live-wrist-rose')
        click('#mode-target');host('machine.mpos.x=0');time.sleep(.3)
        click('#mode-live');host('commands=[]')
        for _ in range(3):
            click('#mode-target');click('#mode-live')
            assert not evaluate('document.querySelector("#home-dialog").open')
            assert evaluate('document.querySelector("#rose-hold-mode").getAttribute("aria-pressed")')=='true'
        # Panel changes and Stop preserve the selected live/hold behavior.
        for leave,back in [('#cartesian-tab','#joint-tab'),('[data-workspace="program"]','[data-workspace="move"]')]:
            click(leave);click(back)
            wait('document.querySelector("#joint-panel").classList.contains("live-mode")')
            assert evaluate('document.querySelector("#rose-hold-mode").getAttribute("aria-pressed")')=='true'
        click('#quick-stop')
        wait('document.querySelector("#joint-panel").classList.contains("live-mode")')
        assert host('commands.filter(c=>c.method==="sendCommand"||c.method==="sendJog").length')==0
        evaluate('document.querySelector("#joint-rose").scrollIntoView({block:"center"})')
        # Missing telemetry stops live mode, but does not throw calibration away.
        click('#rose-hold-mode');xy=rose_xy();mouse('mousePressed',xy)
        wait('!!document.querySelector("#joint-rose .pressed")')
        host('telemetry=false');time.sleep(2.6)
        wait('!document.querySelector("#joint-panel").classList.contains("live-mode")')
        mouse('mouseReleased',xy)
        assert not evaluate('!!document.querySelector("#joint-rose .pressed")')
        host('commands=[]')
        host('telemetry=true');time.sleep(.3)
        wait('document.querySelector("#joint-panel").classList.contains("live-mode")')
        assert evaluate('document.querySelector("#rose-hold-mode").getAttribute("aria-pressed")')=='true'
        assert host('commands.filter(c=>c.method==="sendCommand"||c.method==="sendJog").length')==0
        assert not evaluate('document.querySelector("#home-dialog").open')
        click('#mode-target')
        click('#cartesian-tab');click('#joint-tab');time.sleep(.6)
        assert not evaluate('document.querySelector("#joint-panel").classList.contains("live-mode")')
        assert not evaluate('document.querySelector("#follow-machine").checked')
        assert evaluate('document.querySelector("#arm-legend").textContent')=='Virtual arm'
        # When machine feedback is displayed, capture it instead of a hidden target.
        change('#joint-input-0',30)
        evaluate('document.querySelector("#follow-machine").checked=true;document.querySelector("#follow-machine").dispatchEvent(new Event("change"))')
        click('#teach-point-move')
        assert 'reported machine position' in evaluate('document.querySelector("#message").textContent')
        click('[data-workspace="program"]');click('[data-point-action="recall"]')
        assert float(evaluate('document.querySelector("#joint-input-0").value'))==0
        click('[data-workspace="program"]');click('.waypoint .delete')
        assert evaluate('document.querySelector("#nav-point-count").textContent')=='0'
        click('[data-workspace="move"]')
        # Capture from Move, recall, modify and update. Program controls are always visible.
        for angle in [10,20,0]:
            change('#joint-input-0',angle);click('#teach-point-move')
        click('[data-workspace="program"]')
        # Delete, reorder, rename, and update can be recovered without moving motors.
        click('.waypoint .delete')
        assert evaluate('document.querySelector("#nav-point-count").textContent')=='2'
        click('#undo-points')
        assert evaluate('document.querySelector("#nav-point-count").textContent')=='3'
        click('#redo-points')
        assert evaluate('document.querySelector("#nav-point-count").textContent')=='2'
        click('#undo-points')
        change('.waypoint .name','Approach')
        click('#undo-points')
        assert evaluate('document.querySelector(".waypoint .name").value')=='Waypoint 01'
        click('[data-point-action="down"]')
        assert evaluate('document.querySelector(".waypoint .name").value')=='Waypoint 02'
        click('#undo-points')
        assert evaluate('document.querySelector(".waypoint .name").value')=='Waypoint 01'
        assert host('commands.filter(c=>c.method==="sendCommand"||c.method==="sendJog").length')==0
        assert visible('#teach-point') and on_screen('#teach-point')
        click('[data-point-action="recall"]')
        assert not evaluate('document.querySelector(".control-panel").hidden')
        change('#joint-input-0',12)
        click('[data-workspace="program"]');click('[data-point-action="update"]')
        click('#undo-points');click('[data-point-action="recall"]')
        assert float(evaluate('document.querySelector("#joint-input-0").value'))==10
        click('[data-workspace="program"]');click('#redo-points');click('[data-point-action="recall"]')
        assert float(evaluate('document.querySelector("#joint-input-0").value'))==12
        click('[data-workspace="program"]')
        # A failed upload must unlock controls without requiring another home.
        change('#program-source','sd')
        host('failUpload=true');click('#save-gcode')
        wait('document.querySelector("#program-state").textContent.includes("Simulated upload failure")')
        assert not evaluate('document.querySelector("#teach-point").disabled')
        click('[data-workspace="move"]');click('#mode-live')
        wait('document.querySelector("#mode-live").getAttribute("aria-pressed")==="true"')
        assert not evaluate('document.querySelector("#home-dialog").open')
        click('#mode-target');host('failUpload=false;commands=[]')
        click('[data-workspace="program"]')
        change('#program-speed',60);change('#program-acceleration',120)
        click('#save-gcode');click('#save-gcode')
        wait('document.querySelector("#program-state").textContent.startsWith("Running")')
        assert visible('#teach-point') and evaluate('document.querySelector("#teach-point").disabled')
        assert evaluate('document.querySelector("#undo-points").disabled')
        click('#program-pause');wait('document.querySelector("#program-state").textContent==="Paused"')
        assert evaluate('document.querySelectorAll(".waypoint.executing").length')==1
        assert evaluate('document.querySelector("#arm-legend").textContent')=='Reported machine'
        assert on_screen('#program-stop')
        screenshot('program-running')
        click('#program-pause');wait('document.querySelector("#program-state").textContent.startsWith("Running")')
        wait('document.querySelector("#program-state").textContent.startsWith("Completed")')
        assert evaluate('document.querySelector("[data-point-action=up]").disabled')
        assert evaluate('[...document.querySelectorAll("[data-point-action=down]")].at(-1).disabled')
        assert not evaluate('document.querySelector("#teach-point").disabled')
        assert host('commands.filter(c=>c.method==="startProgramFile" && c.params.path==="/robot-studio.nc").length')==1
        assert host('commands.filter(c=>c.method==="writeFile").length')==1
        assert host('commands.every(c=>c.method!=="openFile")')
        # Preview must use the first waypoint, not the previous physical entry pose (0).
        click('#preview-program');time.sleep(.05)
        assert abs(float(evaluate('document.querySelector("#joint-input-0").value'))-12)<.1
        click('#stop')
        # A growing sequence does not push Add, Preview or Run out of view.
        for _ in range(12): click('#teach-point')
        assert evaluate('document.querySelector("#program-execution-feedback").hidden')
        for width,height in [(1440,900),(1024,600),(768,700),(390,844),(320,640)]:
            call('Emulation.setDeviceMetricsOverride',{'width':width,'height':height,'deviceScaleFactor':1,'mobile':False},rootSession)
            wait(f'innerWidth==={width}')
            assert evaluate('document.documentElement.scrollWidth<=innerWidth'), f'Horizontal overflow at {width}'
            assert visible('#teach-point')
            if width>620:
                assert on_screen('#teach-point') and on_screen('#preview-program') and on_screen('#save-gcode'), f'Clipped actions at {width}'
                evaluate('document.querySelector(".program-body").scrollTop=100000')
                assert on_screen('#teach-point') and on_screen('#save-gcode')
            if width<=620:
                evaluate('document.querySelector(".workspace-tabs").scrollIntoView()')
                assert on_screen('#save-gcode'), f'Run not accessible while scrolling at {width}'
            screenshot(f'workspace-{width}')
        call('Emulation.setDeviceMetricsOverride',{'width':1440,'height':900,'deviceScaleFactor':1,'mobile':False},rootSession)
        wait('innerWidth===1440')
        # The plugin adopts host theme tokens, including native form color scheme.
        host('document.querySelector("iframe").contentWindow.postMessage({type:"fluid-theme",vars:{"--bg":"#f0f2f8","--surface":"#ffffff","--elevated":"#e8ebf4","--border":"#d0d5e8","--text-primary":"#0c0f1a","--text-muted":"#5a6280","--accent":"#c97a00","--plugin-color-scheme":"light"}},"*")')
        wait('getComputedStyle(document.documentElement).colorScheme==="light"')
        assert evaluate('getComputedStyle(document.querySelector(".program-toolbar")).backgroundColor')=='rgb(255, 255, 255)'
        screenshot('workspace-light')
        # The rose and exact-angle disclosure remain usable at narrow widths.
        for width,height in [(1440,900),(390,844),(320,640)]:
            call('Emulation.setDeviceMetricsOverride',{'width':width,'height':height,'deviceScaleFactor':1,'mobile':False},rootSession)
            wait(f'innerWidth==={width}')
            click('[data-workspace="move"]');click('#joint-tab')
            evaluate('document.querySelector("#joint-rose").scrollIntoView({block:"center"})')
            assert evaluate('document.documentElement.scrollWidth<=innerWidth'), f'Rose overflow at {width}'
            assert on_screen('#joint-rose .rose-stop')
            screenshot(f'rose-{width}')
        call('Emulation.setDeviceMetricsOverride',{'width':1440,'height':900,'deviceScaleFactor':1,'mobile':False},rootSession)
        wait('innerWidth===1440')
        # Reopening defaults to live/hold with the same reference and no replayed move.
        click('#save-project');wait('document.querySelector("#message").textContent.includes("saved to")')
        host('commands=[]')
        host('document.querySelector("iframe").srcdoc=document.querySelector("iframe").srcdoc')
        time.sleep(.4)
        targets=call('Target.getTargets')['targetInfos']
        iframeTarget=next(t for t in targets if t['type']=='iframe')
        session=call('Target.attachToTarget',{'targetId':iframeTarget['targetId'],'flatten':True})['sessionId']
        call('Runtime.enable',session=session)
        wait('!!document.querySelector("#viewer canvas") && !document.querySelector("#viewer-loading")')
        wait('document.querySelector("#reference-state").textContent.includes("Reference set")')
        evaluate('document.querySelector("#joint-tab").focus()')
        wait('document.querySelector("#joint-panel").classList.contains("live-mode")')
        assert evaluate('document.querySelector("#rose-hold-mode").getAttribute("aria-pressed")')=='true'
        assert host('commands.filter(c=>c.method==="sendCommand"||c.method==="sendJog").length')==0
        assert not evaluate('document.querySelector("#home-dialog").open')
        # Actual connection loss/reset clears calibration.
        host('sessionState={generation:sessionState.generation+1,data:null};document.querySelector("iframe").contentWindow.postMessage({type:"fluid-event",event:"session",data:sessionState},"*")')
        wait('!document.querySelector("#joint-panel").classList.contains("live-mode")')
        click('#mode-live');wait('document.querySelector("#home-dialog").open')
        assert not [e for e in events if e.get('method')=='Runtime.exceptionThrown'], 'Uncaught browser exception'
        # Standalone demo uses the selected physical tool in the shared model,
        # preserves taught points, and restores a saved custom extension.
        session=rootSession;context=None
        call('Page.navigate',{'url':url+'/plugins/robot-studio/'},session)
        wait('!!document.querySelector("#viewer canvas") && !document.querySelector("#viewer-loading")')
        wait('document.querySelector("#message").textContent.includes("No saved project")')
        click('[data-workspace="program"]')
        evaluate('document.querySelector(".demo-tools").open=true')
        assert evaluate('document.querySelector("#demo-tool-length").value')=='30'
        click('#teach-point');click('#singularity-demo')
        wait('document.querySelector("#viewer-state").textContent.includes("Playing preview")')
        assert evaluate('document.querySelector("#demo-tool-length").disabled')==False
        assert '30.0 mm' in evaluate('document.querySelector("#demo-tool-hint").textContent')
        click('#save-project')
        saved=evaluate('JSON.parse(localStorage.getItem("figui.robot-studio.v1"))')
        assert saved['config']['tool']['z']==30 and len(saved['points'])==1
        click('#stop');click('#home-pose')
        change('#demo-tool-length',45);click('#singularity-demo')
        wait('document.querySelector("#viewer-state").textContent.includes("Playing preview")')
        click('#save-project');click('#stop')
        assert evaluate('JSON.parse(localStorage.getItem("figui.robot-studio.v1")).config.tool.z')==45
        call('Page.reload',{},session)
        wait('!!document.querySelector("#viewer canvas") && !document.querySelector("#viewer-loading")')
        wait('document.querySelector("#demo-tool-length").value==="45"')
        assert evaluate('document.querySelector("#mode-live").disabled')
        assert 'Simulation workspace' in evaluate('document.querySelector("#machine-move").title')
        # Compatible configuration edits preserve teaching work.
        click('#setup-tab');click('#configure')
        change('#config-name','My workcell')
        click('#config-form button[type=submit]')
        wait('!document.querySelector("#config-dialog").open')
        assert not evaluate('document.querySelector("#replace-dialog").open')
        assert evaluate('document.querySelector("#nav-point-count").textContent')=='1'
        # Incompatible geometry changes cannot silently clear a taught program.
        click('#configure')
        evaluate('document.querySelector("#dimension-a2").value=500;document.querySelector("#dimension-a2").dispatchEvent(new Event("input"))')
        click('#config-form button[type=submit]')
        wait('document.querySelector("#replace-dialog").open')
        click('#replace-dialog button[value=cancel]')
        assert evaluate('document.querySelector("#nav-point-count").textContent')=='1'
        assert evaluate('document.querySelector("#config-dialog").open')
        click('#config-form button[type=submit]');click('#replace-confirm')
        wait('!document.querySelector("#config-dialog").open')
        assert evaluate('document.querySelector("#nav-point-count").textContent')=='0'
        assert evaluate('document.querySelector("#undo-points").disabled')
        # Import is validated first; cancel preserves work, acceptance replaces atomically.
        def import_project(value):
            evaluate('(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['+json.dumps(json.dumps(value))+'],"project.json",{type:"application/json"}));const input=document.querySelector("#project-file");input.files=transfer.files;input.dispatchEvent(new Event("change"));})()')
        import_project({'format':'bad'})
        wait('document.querySelector("#message").classList.contains("error")')
        assert not evaluate('document.querySelector("#replace-dialog").open')
        replacement=evaluate('JSON.parse(localStorage.getItem("figui.robot-studio.v1"))')
        replacement['config']['name']='Restored workcell'
        import_project(replacement)
        wait('document.querySelector("#replace-dialog").open')
        click('#replace-dialog button[value=cancel]')
        assert evaluate('document.querySelector("#robot-name").textContent')!='Restored workcell'
        import_project(replacement)
        wait('document.querySelector("#replace-dialog").open');click('#replace-confirm')
        wait('document.querySelector("#robot-name").textContent==="Restored workcell"')
        assert evaluate('document.querySelector("#nav-point-count").textContent')=='1'
        assert not [e for e in events if e.get('method')=='Runtime.exceptionThrown'], 'Uncaught browser exception'
        print('Robot workspace browser regressions passed: rose virtual/live steps, Cartesian frames, pointer/keyboard/touch cancellation, multi-touch exclusion, save races, undo/redo, reference lifecycle, execution, responsive layouts and host themes.')
        print('Screenshots:',profile)
finally:
    chrome.terminate();chrome.wait(timeout=10);server.shutdown();log.close()
