import { q } from "../db/pool.js";
import { containerPort } from "../config.js";

// Resolve a public session id -> { port, steelId } for cast proxying.
export const resolveCastTarget = async (
  sessionId: string,
): Promise<{ port: number; steelId: string } | null> => {
  const r = await q<{ container_idx: number; steel_id: string }>(
    `SELECT container_idx, steel_id FROM sessions WHERE id = $1 AND status = 'live'`,
    [sessionId],
  );
  if (!r.rows[0]) return null;
  return {
    port: containerPort(r.rows[0].container_idx),
    steelId: r.rows[0].steel_id,
  };
};

// Self-contained live-view page: renders the Steel screencast (base64 JPEG
// frames over WS) and forwards mouse/keyboard so the user can drive the browser.
// Robust status: distinguishes connecting / waiting-for-frames / live / ended,
// caps reconnects, and nudges an idle page so a first frame is produced.
export const liveViewHtml = (sessionId: string) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FlareCrawl — Live Browser</title>
<style>
 html,body{margin:0;height:100%;background:#0b0b0f;color:#eee;font:13px system-ui}
 #wrap{position:fixed;inset:0;display:flex;flex-direction:column}
 #bar{padding:6px 10px;background:#15151c;display:flex;gap:10px;align-items:center;font-size:12px}
 #dot{width:8px;height:8px;border-radius:50%;background:#e0b341;flex:none;transition:background .2s}
 #dot.on{background:#3ecf8e}
 #dot.err{background:#e0554a}
 #stage{flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative}
 #screen{max-width:100%;max-height:100%;background:#000;cursor:crosshair;outline:none;display:none}
 #screen.show{display:block}
 #msg{position:absolute;opacity:.6;font-size:13px;text-align:center;padding:0 20px}
 #url{opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
</style></head>
<body><div id="wrap">
 <div id="bar"><span id="dot"></span><b>FlareCrawl live</b><span id="url">connecting…</span></div>
 <div id="stage"><div id="msg">Connecting to the browser…</div><img id="screen" tabindex="0" draggable="false"></div>
</div>
<script>
const VW=1920, VH=1080;
const img=document.getElementById('screen'), dot=document.getElementById('dot'), urlEl=document.getElementById('url'), msg=document.getElementById('msg');
const wsUrl=(location.protocol==='https:'?'wss://':'ws://')+location.host+'/live/${sessionId}/cast?pageIndex=0';
let ws, pageId='', frames=0, tries=0, waitTimer=0;
function setMsg(t){ if(t){msg.textContent=t; msg.style.display='';} else {msg.style.display='none';} }
function connect(){
 setMsg(tries?'Reconnecting…':'Connecting to the browser…');
 ws=new WebSocket(wsUrl);
 ws.onopen=()=>{dot.classList.remove('err');dot.classList.add('on');urlEl.textContent='waiting for browser…';
   clearTimeout(waitTimer);
   waitTimer=setTimeout(()=>{ if(frames===0){ setMsg('Browser is idle (no page activity yet). It will appear as soon as the agent navigates.'); } },2500);
 };
 ws.onclose=()=>{dot.classList.remove('on');
   if(frames>0){ setMsg('Stream paused — reconnecting…'); setTimeout(connect,1500); return; }
   tries++;
   if(tries>=5){ dot.classList.add('err'); urlEl.textContent='session ended'; setMsg('No live browser for this session (it may have ended).'); return; }
   setTimeout(connect,1500);
 };
 ws.onmessage=e=>{try{const m=JSON.parse(e.data);
   if(m.data){ frames++; img.src='data:image/jpeg;base64,'+m.data; img.classList.add('show'); setMsg(''); if(m.pageId)pageId=m.pageId; }
   if(m.url!==undefined) urlEl.textContent = m.url || 'about:blank';
 }catch(_){}};
}
connect();
function pt(ev){const r=img.getBoundingClientRect();return{x:Math.round((ev.clientX-r.left)/r.width*VW),y:Math.round((ev.clientY-r.top)/r.height*VH)};}
function send(o){if(ws&&ws.readyState===1)ws.send(JSON.stringify(o));}
function mouse(t,ev,extra){const p=pt(ev);send({type:'mouseEvent',pageId,event:Object.assign({type:t,x:p.x,y:p.y,button:ev.button===2?'right':ev.button===1?'middle':'left',modifiers:0,clickCount:1},extra||{})});}
img.addEventListener('mousemove',e=>mouse('mouseMoved',e));
img.addEventListener('mousedown',e=>{img.focus();mouse('mousePressed',e);});
img.addEventListener('mouseup',e=>mouse('mouseReleased',e));
img.addEventListener('contextmenu',e=>e.preventDefault());
img.addEventListener('wheel',e=>{e.preventDefault();mouse('mouseWheel',e,{deltaX:e.deltaX,deltaY:e.deltaY,button:'none'});},{passive:false});
function keycode(e){return e.keyCode||0;}
img.addEventListener('keydown',e=>{e.preventDefault();send({type:'keyEvent',pageId,event:{type:'keyDown',key:e.key,code:e.code,keyCode:keycode(e),text:e.key.length===1?e.key:undefined,modifiers:0}});if(e.key.length===1)send({type:'keyEvent',pageId,event:{type:'char',key:e.key,code:e.code,keyCode:keycode(e),text:e.key,modifiers:0}});});
img.addEventListener('keyup',e=>{e.preventDefault();send({type:'keyEvent',pageId,event:{type:'keyUp',key:e.key,code:e.code,keyCode:keycode(e),modifiers:0}});});
</script></body></html>`;
