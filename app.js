/* ═══════════════════════════════════════════════════════════
   MaSu Peer — app.js
   All React components + Firebase + WebRTC logic
═══════════════════════════════════════════════════════════ */

const { useState, useEffect, useRef, useCallback,
        useReducer, useMemo, memo } = React;

/* ── CONSTANTS ─────────────────────────────────────────── */
const SHORT_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const EMOJIS = ['👍','❤️','😂','😮','😢','🔥','🎉','✅'];
const AV_GRADS = [
  'linear-gradient(135deg,#7c3aed,#4c1d95)',
  'linear-gradient(135deg,#5b21b6,#a855f7)',
  'linear-gradient(135deg,#2563eb,#7c3aed)',
  'linear-gradient(135deg,#b45309,#f59e0b)',
  'linear-gradient(135deg,#065f46,#7c3aed)',
  'linear-gradient(135deg,#be185d,#7c3aed)',
];

/* ── UTILS ─────────────────────────────────────────────── */
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
const genShortId = () => Array.from({length:8}, () => SHORT_CHARS[Math.floor(Math.random()*SHORT_CHARS.length)]).join('');
const sortedChatId = (a, b) => [a, b].sort().join('_');
const fmtBytes = b => b < 1048576 ? (b/1024).toFixed(1)+' KB' : (b/1048576).toFixed(1)+' MB';
const fmtSecs  = s => `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
const avGrad   = name => AV_GRADS[(name||'?').charCodeAt(0) % AV_GRADS.length];

const fmtTime = ts => {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date((ts.seconds||0)*1000);
  const diff = Date.now() - d;
  if (diff < 86400000) return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  if (diff < 172800000) return 'Yesterday';
  return d.toLocaleDateString([], {month:'short', day:'numeric'});
};

const sha256 = async buf => {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2,'0')).join('');
};

const chunkSz = sz => sz < 1048576 ? 16384 : sz < 10485760 ? 65536 : 262144;

const compressImg = (file, size=160, q=0.75) => new Promise(resolve => {
  const canvas = document.createElement('canvas');
  const img = new Image(), url = URL.createObjectURL(file);
  img.onload = () => {
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    const min = Math.min(img.width, img.height);
    ctx.drawImage(img, (img.width-min)/2, (img.height-min)/2, min, min, 0, 0, size, size);
    URL.revokeObjectURL(url);
    resolve(canvas.toDataURL('image/jpeg', q));
  };
  img.src = url;
});

/* ── INDEXED DB ────────────────────────────────────────── */
class IDB {
  constructor() { this.db = null; }
  async open() {
    if (this.db) return this.db;
    return new Promise((ok, fail) => {
      const r = indexedDB.open('masupeer_v1', 1);
      r.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('messages')) {
          const s = db.createObjectStore('messages', {keyPath:'id'});
          s.createIndex('chatId', 'chatId', {unique:false});
        }
        if (!db.objectStoreNames.contains('kv'))
          db.createObjectStore('kv', {keyPath:'k'});
      };
      r.onsuccess = e => { this.db = e.target.result; ok(this.db); };
      r.onerror = fail;
    });
  }
  async put(store, data) {
    const db = await this.open();
    return new Promise((ok, fail) => {
      const t = db.transaction(store, 'readwrite');
      t.objectStore(store).put(data);
      t.oncomplete = ok; t.onerror = fail;
    });
  }
  async get(store, key) {
    const db = await this.open();
    return new Promise((ok, fail) => {
      const t = db.transaction(store, 'readonly');
      const req = t.objectStore(store).get(key);
      req.onsuccess = () => ok(req.result); req.onerror = fail;
    });
  }
  async byIdx(store, idx, val) {
    const db = await this.open();
    return new Promise((ok, fail) => {
      const t = db.transaction(store, 'readonly');
      const req = t.objectStore(store).index(idx).getAll(val);
      req.onsuccess = () => ok(req.result || []); req.onerror = fail;
    });
  }
}
const idb = new IDB();

/* ── PEER MANAGER ──────────────────────────────────────── */
class PeerManager {
  constructor(uid, onMsg, onOpen, onClose) {
    this.uid=uid; this.peers={}; this.iceBuf={};
    this.onMsg=onMsg; this.onOpen=onOpen; this.onClose=onClose;
  }
  async _newPC(ru, initiator) {
    const ice = await window.getICE();
    const pc = new RTCPeerConnection({
      iceServers: ice, iceTransportPolicy:'all',
      iceCandidatePoolSize:10, bundlePolicy:'max-bundle'
    });
    const info = {pc, dc:null, state:'connecting', connType:null, initiator};
    this.peers[ru] = info; this.iceBuf[ru] = [];
    pc.onicecandidate = e => {
      if (!e.candidate) return;
      if (e.candidate.candidate.includes('relay')) info.connType='turn';
      else if (!info.connType) info.connType='stun';
      window.fRTDB.ref(`signaling/${ru}/candidates`).push({
        from:this.uid, candidate:e.candidate.toJSON(), ts:window.fRTS
      });
    };
    pc.onconnectionstatechange = () => {
      info.state = pc.connectionState;
      if (pc.connectionState==='connected') {
        pc.getStats().then(stats => {
          stats.forEach(r => {
            if (r.type==='candidate-pair' && r.state==='succeeded') {
              const relay = r.localCandidateType==='relay' || r.remoteCandidateType==='relay';
              info.connType = relay ? 'turn' : 'stun';
            }
          });
        });
      }
      if (pc.connectionState==='failed' || pc.connectionState==='disconnected')
        this.onClose?.(ru, true);
    };
    pc.ondatachannel = e => { info.dc=e.channel; this._setupDC(ru, e.channel); };
    if (initiator) {
      const dc = pc.createDataChannel('mp', {ordered:true, maxRetransmits:3});
      info.dc = dc; this._setupDC(ru, dc);
    }
    return info;
  }
  _setupDC(uid, dc) {
    dc.binaryType = 'arraybuffer';
    dc.onopen  = () => this.onOpen?.(uid);
    dc.onclose = () => this.onClose?.(uid, false);
    dc.onmessage = e => {
      if (typeof e.data === 'string') {
        try { this.onMsg?.(uid, JSON.parse(e.data)); } catch(_) {}
      } else {
        this.onMsg?.(uid, {type:'_bin', data:e.data});
      }
    };
  }
  async connect(ru) {
    if (this.connected(ru)) return;
    const info = await this._newPC(ru, true);
    const offer = await info.pc.createOffer();
    await info.pc.setLocalDescription(offer);
    window.fRTDB.ref(`signaling/${ru}/offers`).push({from:this.uid, sdp:offer.sdp, ts:window.fRTS});
  }
  async handleOffer(from, sdp) {
    if (!this.peers[from]) await this._newPC(from, false);
    const info = this.peers[from];
    await info.pc.setRemoteDescription({type:'offer', sdp});
    const ans = await info.pc.createAnswer();
    await info.pc.setLocalDescription(ans);
    window.fRTDB.ref(`signaling/${from}/answers`).push({from:this.uid, sdp:ans.sdp, ts:window.fRTS});
    this._drain(from);
  }
  async handleAnswer(from, sdp) {
    const info = this.peers[from]; if (!info) return;
    await info.pc.setRemoteDescription({type:'answer', sdp});
    this._drain(from);
  }
  async handleCandidate(from, cand) {
    const info = this.peers[from];
    if (!info || !info.pc.remoteDescription) {
      (this.iceBuf[from]||(this.iceBuf[from]=[])).push(cand); return;
    }
    try { await info.pc.addIceCandidate(cand); } catch(_) {}
  }
  _drain(uid) {
    (this.iceBuf[uid]||[]).forEach(c => this.peers[uid]?.pc.addIceCandidate(c).catch(()=>{}));
    this.iceBuf[uid] = [];
  }
  send(uid, data) {
    const dc = this.peers[uid]?.dc;
    if (dc?.readyState !== 'open') return false;
    try { dc.send(JSON.stringify(data)); return true; } catch(_) { return false; }
  }
  sendBin(uid, buf) {
    const dc = this.peers[uid]?.dc;
    if (dc?.readyState !== 'open') return false;
    try { dc.send(buf); return true; } catch(_) { return false; }
  }
  connected(uid) { return this.peers[uid]?.dc?.readyState === 'open'; }
  connType(uid)  { return this.peers[uid]?.connType || null; }
  close(uid)     { const p=this.peers[uid]; if(!p)return; p.dc?.close(); p.pc.close(); delete this.peers[uid]; }
  closeAll()     { Object.keys(this.peers).forEach(u => this.close(u)); }
}

/* ── TRANSFER ENGINE ───────────────────────────────────── */
class TransferEngine {
  constructor(pm, onP, onD, onE) {
    this.pm=pm; this.onP=onP; this.onD=onD; this.onE=onE;
    this.active={}; this.recvBuf={};
  }
  async send(file, toUid, tid) {
    const cs=chunkSz(file.size), total=Math.ceil(file.size/cs);
    const buf=await file.arrayBuffer(), hash=await sha256(buf);
    const st={id:tid,name:file.name,size:file.size,hash,total,sent:0,cs,status:'sending',t0:Date.now(),toUid};
    this.active[tid] = st;
    if (!this.pm.send(toUid, {type:'fs',tid,name:file.name,size:file.size,ftype:file.type,hash,total,cs})) {
      st.status='fail'; this.onE?.(tid,'no_p2p'); return false;
    }
    let off=0;
    for (let i=0; i<total; i++) {
      if (st.status==='cancelled') break;
      while (st.status==='paused') await new Promise(r=>setTimeout(r,150));
      const chunk=buf.slice(off,off+cs), chash=await sha256(chunk);
      this.pm.send(toUid, {type:'fch',tid,idx:i,sz:chunk.byteLength,chash});
      this.pm.sendBin(toUid, chunk);
      st.sent=i+1; off+=cs;
      const elapsed=(Date.now()-st.t0)/1000||.001, speed=off/elapsed, eta=(file.size-off)/speed;
      this.onP?.(tid, {pct:Math.round(st.sent/total*100),speed,eta:isFinite(eta)?eta:null,name:file.name,size:file.size,dir:'send'});
      if (i%8===0) await new Promise(r=>setTimeout(r,8));
    }
    if (st.status!=='cancelled') {
      this.pm.send(toUid, {type:'fe',tid,hash}); st.status='done'; this.onD?.(tid,'send');
    }
    return true;
  }
  onMsg(_from, msg) {
    if (msg.type==='fs') {
      this.recvBuf[msg.tid]={meta:msg,chunks:new Array(msg.total),got:0,pendHdr:null};
      this.onP?.(msg.tid, {pct:0,name:msg.name,size:msg.size,dir:'recv'});
    } else if (msg.type==='fch') {
      const rb=this.recvBuf[msg.tid]; if(rb) rb.pendHdr=msg;
    } else if (msg.type==='fe') {
      this._fin(msg.tid, msg.hash);
    }
  }
  onBin(_from, data) {
    const e=Object.entries(this.recvBuf).find(([,rb])=>rb.pendHdr!=null);
    if (!e) return;
    const [tid,rb]=e; const h=rb.pendHdr; rb.pendHdr=null;
    rb.chunks[h.idx]={data,chash:h.chash}; rb.got++;
    this.onP?.(tid, {pct:Math.round(rb.got/rb.meta.total*100),name:rb.meta.name,size:rb.meta.size,dir:'recv'});
  }
  async _fin(tid, expHash) {
    const rb=this.recvBuf[tid]; if(!rb) return;
    if (rb.chunks.some(c=>!c)) { this.onE?.(tid,'incomplete'); return; }
    let tot=0; rb.chunks.forEach(c=>tot+=c.data.byteLength);
    const a=new Uint8Array(tot); let off=0;
    rb.chunks.forEach(c=>{a.set(new Uint8Array(c.data),off);off+=c.data.byteLength;});
    const ah=await sha256(a.buffer);
    if (ah!==expHash) { this.onE?.(tid,'hash_fail'); return; }
    const blob=new Blob([a],{type:rb.meta.ftype}), url=URL.createObjectURL(blob);
    this.onD?.(tid,'recv',{url,name:rb.meta.name,size:rb.meta.size,type:rb.meta.ftype});
    delete this.recvBuf[tid];
  }
  pause(tid)  { if(this.active[tid]) this.active[tid].status='paused'; }
  resume(tid) { if(this.active[tid]) this.active[tid].status='sending'; }
  cancel(tid) { if(this.active[tid]) this.active[tid].status='cancelled'; delete this.recvBuf[tid]; }
}

/* ── CALL MANAGER ──────────────────────────────────────── */
class CallManager {
  constructor(uid, cb) {
    this.uid=uid; this.cb=cb;
    this.pc=null; this.ls=null; this.rs=null;
    this.callId=null; this.timer=null; this.dur=0; this._offs=[];
  }
  async startCall(ru, callType) {
    this.callId = genId();
    try {
      this.ls = await navigator.mediaDevices.getUserMedia({
        audio:true, video:callType==='video'?{width:1280,height:720,facingMode:'user'}:false
      });
      await this._buildPC(ru, this.callId);
      this.ls.getTracks().forEach(t=>this.pc.addTrack(t,this.ls));
      const offer=await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      window.fRTDB.ref(`calls/${ru}/offer`).set({from:this.uid,callId:this.callId,callType,sdp:offer.sdp,ts:window.fRTS});
      this.cb({type:'state',state:'calling',callType,ru,ls:this.ls});
      const ansRef=window.fRTDB.ref(`calls/${this.uid}/answer`);
      ansRef.on('value', async snap=>{
        const d=snap.val();
        if(d?.callId===this.callId){
          await this.pc.setRemoteDescription({type:'answer',sdp:d.sdp});
          this._startTimer(); this.cb({type:'state',state:'active'});
          ansRef.off(); snap.ref.remove();
        }
      });
      this._offs.push(()=>ansRef.off());
      const cRef=window.fRTDB.ref(`calls/${this.uid}/candidates`);
      cRef.on('child_added', snap=>{
        const d=snap.val();
        if(d?.callId===this.callId&&this.pc?.remoteDescription)
          this.pc.addIceCandidate(d.candidate).catch(()=>{});
        snap.ref.remove();
      });
      this._offs.push(()=>cRef.off());
    } catch(err) { this.cb({type:'error',err:err.message}); this._cleanup(); }
  }
  async accept(ru, callId, sdp, callType) {
    this.callId = callId;
    try {
      this.ls = await navigator.mediaDevices.getUserMedia({audio:true,video:callType==='video'});
      await this._buildPC(ru, callId);
      this.ls.getTracks().forEach(t=>this.pc.addTrack(t,this.ls));
      await this.pc.setRemoteDescription({type:'offer',sdp});
      const ans=await this.pc.createAnswer();
      await this.pc.setLocalDescription(ans);
      window.fRTDB.ref(`calls/${ru}/answer`).set({from:this.uid,callId,sdp:ans.sdp,ts:window.fRTS});
      this._startTimer(); this.cb({type:'state',state:'active',callType,ru,ls:this.ls});
    } catch(err) { this.cb({type:'error',err:err.message}); this._cleanup(); }
  }
  async _buildPC(ru, callId) {
    const ice=await window.getICE();
    this.pc=new RTCPeerConnection({iceServers:ice});
    this.pc.ontrack=e=>{this.rs=e.streams[0];this.cb({type:'rs',stream:e.streams[0]});};
    this.pc.onicecandidate=e=>{
      if(e.candidate)
        window.fRTDB.ref(`calls/${ru}/candidates`).push({from:this.uid,callId,candidate:e.candidate.toJSON()});
    };
  }
  end(ru) {
    if(this.callId) window.fRTDB.ref(`calls/${ru}/end`).set({callId:this.callId,from:this.uid});
    this._cleanup(); this.cb({type:'state',state:'ended'});
  }
  toggleMute()   { const t=this.ls?.getAudioTracks()[0]; if(t){t.enabled=!t.enabled;return t.enabled;}return false; }
  toggleCam()    { const t=this.ls?.getVideoTracks()[0]; if(t){t.enabled=!t.enabled;return t.enabled;}return false; }
  async toggleScreen() {
    if(!this.pc) return false;
    const s=this.pc.getSenders().find(s=>s.track?.kind==='video'); if(!s) return false;
    try {
      const ss=await navigator.mediaDevices.getDisplayMedia({video:true});
      const st=ss.getVideoTracks()[0]; await s.replaceTrack(st);
      st.onended=()=>this.toggleScreen(); return true;
    } catch(_) { return false; }
  }
  _startTimer() { this.dur=0; this.timer=setInterval(()=>{this.dur++;this.cb({type:'tick',dur:this.dur});},1000); }
  _cleanup() {
    clearInterval(this.timer);
    this.ls?.getTracks().forEach(t=>t.stop()); this.pc?.close();
    this._offs.forEach(fn=>fn()); this.pc=null; this.ls=null; this.rs=null;
    this.callId=null; this.dur=0; this._offs=[];
    window.fRTDB.ref(`calls/${this.uid}`).remove();
  }
}

/* ── PRESENCE ──────────────────────────────────────────── */
class Presence {
  constructor(uid) { this.uid=uid; this._hb=null; }
  start() {
    const r=window.fRTDB.ref(`presence/${this.uid}`);
    window.fRTDB.ref('.info/connected').on('value', snap=>{
      if(snap.val()){
        r.set({online:true,lastSeen:window.fRTS});
        r.onDisconnect().update({online:false,lastSeen:window.fRTS});
      }
    });
    this._hb=setInterval(()=>r.update({lastSeen:window.fRTS}),30000);
  }
  stop() {
    clearInterval(this._hb);
    window.fRTDB.ref(`presence/${this.uid}`).update({online:false,lastSeen:window.fRTS});
  }
  setTyping(chatId, v) {
    const r=window.fRTDB.ref(`typing/${chatId}/${this.uid}`);
    if(v){r.set({typing:true,at:window.fRTS});r.onDisconnect().remove();}else r.remove();
  }
}

/* ── STATE ─────────────────────────────────────────────── */
const INIT = {
  user:null, userProfile:null, authReady:false,
  view:'home', menuOpen:false, menuTab:'main',
  friends:[], incoming:[], outgoing:[],
  homeSearch:'', searchResults:[], searchLoading:false,
  activeChatId:null, activeChat:null,
  msgs:{}, cursors:{}, loadingMsgs:{},
  presence:{}, typing:{},
  unreadCounts:{},    // chatId -> {count,lastMsg,fromName,fromPhoto,ts}
  transfers:{}, activeTid:null,
  callState:null, callData:null, callLS:null, callRS:null,
  callDur:0, muted:false, camOff:false,
};

function reduce(s, a) {
  switch(a.t) {
    case 'AUTH':         return {...s, user:a.u, authReady:true};
    case 'PROFILE':      return {...s, userProfile:a.p};
    case 'FRIENDS':      return {...s, friends:a.v};
    case 'INCOMING':     return {...s, incoming:a.v};
    case 'OUTGOING':     return {...s, outgoing:a.v};
    case 'VIEW':         return {...s, view:a.v, menuOpen:false};
    case 'MENU':         return {...s, menuOpen:a.v};
    case 'MENU_TAB':     return {...s, menuTab:a.v};
    case 'SEARCH':       return {...s, homeSearch:a.v};
    case 'RESULTS':      return {...s, searchResults:a.v, searchLoading:false};
    case 'SRCH_LOAD':    return {...s, searchLoading:a.v};
    case 'ACTIVE_CHAT':  return {...s, activeChatId:a.id, activeChat:a.chat, view:'chat'};
    case 'MSGS': return {
      ...s,
      msgs:{...s.msgs,[a.id]:a.append?[...(a.msgs||[]),...(s.msgs[a.id]||[])]:a.msgs||[]},
      cursors:{...s.cursors,[a.id]:a.cursor},
      loadingMsgs:{...s.loadingMsgs,[a.id]:false}
    };
    case 'ADD_MSG': {
      const cur=s.msgs[a.id]||[];
      return {...s, msgs:{...s.msgs,[a.id]:cur.some(m=>m.id===a.msg.id)?cur:[...cur,a.msg]}};
    }
    case 'UPD_MSG': return {
      ...s, msgs:{...s.msgs,[a.id]:(s.msgs[a.id]||[]).map(m=>m.id===a.mid?{...m,...a.upd}:m)}
    };
    case 'LOAD_MSGS':    return {...s, loadingMsgs:{...s.loadingMsgs,[a.id]:a.v}};
    case 'PRES':         return {...s, presence:{...s.presence,[a.uid]:a.data}};
    case 'TYPING':       return {...s, typing:{...s.typing,[a.chatId]:{...(s.typing[a.chatId]||{}),[a.uid]:a.v}}};
    case 'UNREADS':      return {...s, unreadCounts:a.v};
    case 'CLEAR_UNREAD': { const u={...s.unreadCounts}; delete u[a.chatId]; return {...s,unreadCounts:u}; }
    case 'XFER':         return {...s, transfers:{...s.transfers,[a.id]:{...s.transfers[a.id],...a.data,id:a.id}}};
    case 'ACTIVE_TID':   return {...s, activeTid:a.v};
    case 'CALL':         return {...s, callState:a.state, callData:a.data??s.callData};
    case 'CALL_LS':      return {...s, callLS:a.v};
    case 'CALL_RS':      return {...s, callRS:a.v};
    case 'CALL_DUR':     return {...s, callDur:a.v};
    case 'MUTE':         return {...s, muted:a.v};
    case 'CAM':          return {...s, camOff:a.v};
    default:             return s;
  }
}

/* ── SVG ICON ──────────────────────────────────────────── */
const ICON_PATHS = {
  menu:'M3 12H21M3 6H21M3 18H21',
  x:'M18 6L6 18M6 6L18 18',
  search:'M21 21L16.65 16.65M19 11A8 8 0 1 1 3 11',
  msg:'M21 15A2 2 0 0 1 19 17H7L3 21V5A2 2 0 0 1 5 3H19A2 2 0 0 1 21 5V15Z',
  home:'M3 9L12 2L21 9V20A1 1 0 0 1 20 21H15V16H9V21H4A1 1 0 0 1 3 20V9Z',
  users:'M17 21V19A4 4 0 0 0 13 15H5A4 4 0 0 0 1 19V21M9 11A4 4 0 1 0 9 3A4 4 0 0 0 9 11ZM23 21V19A4 4 0 0 0 16 15.13M16 3.13A4 4 0 0 1 16 11',
  settings:'M12 15A3 3 0 1 0 12 9A3 3 0 0 0 12 15ZM2 12H3M21 12H22M12 2V3M12 21V22M4.22 4.22L5.64 5.64M18.36 18.36L19.78 19.78M4.22 19.78L5.64 18.36M18.36 5.64L19.78 4.22',
  plus:'M12 5V19M5 12H19',
  check:'M20 6L9 17L4 12',
  checks:'M9 12L12 15L22 5M20 12V19A2 2 0 0 1 18 21H6A2 2 0 0 1 4 19V5A2 2 0 0 1 6 3H15',
  chevL:'M15 18L9 12L15 6',
  chevD:'M6 9L12 15L18 9',
  phone:'M22 16.92V19.92A2 2 0 0 1 19.82 21.92A19.79 19.79 0 0 1 11.19 18.85A19.5 19.5 0 0 1 4.69 12A19.79 19.79 0 0 1 1.57 3.43A2 2 0 0 1 3.54 1H6.54A2 2 0 0 1 8.54 2.72A12.84 12.84 0 0 0 9.24 5.53A2 2 0 0 1 8.79 7.64L7.91 8.52A16 16 0 0 0 16 16.61L16.9 15.73A2 2 0 0 1 19.01 15.28A12.84 12.84 0 0 0 21.82 15.98A2 2 0 0 1 22 16.92Z',
  video:'M23 7L16 12L23 17V7ZM14 5H3A2 2 0 0 0 1 7V17A2 2 0 0 0 3 19H14A2 2 0 0 0 16 17V7A2 2 0 0 0 14 5Z',
  mic:'M12 1A3 3 0 0 0 9 4V12A3 3 0 0 0 15 12V4A3 3 0 0 0 12 1ZM19 10V12A7 7 0 0 1 5 12V10M12 19V23M8 23H16',
  micoff:'M1 1L23 23M9 9V4A3 3 0 0 1 15 4V12A3 3 0 0 1 15 12M5.07 5.07A7 7 0 0 0 5 10V12A7 7 0 0 0 18.17 15.5M12 19V23M8 23H16',
  camoff:'M1 1L23 23M16.94 16.94A16 16 0 0 1 9 19H3A2 2 0 0 1 1 17V7A2 2 0 0 1 3 5H6M9 3H14A2 2 0 0 1 16 5V6M19 7L23 4V20',
  phoneoff:'M10.68 13.31A16 16 0 0 0 14.09 15.91L15.36 14.64A2 2 0 0 1 17.47 14.19A12.84 12.84 0 0 0 20.28 14.89A2 2 0 0 1 22 16.92V19.92A2 2 0 0 1 19.82 21.92A19.79 19.79 0 0 1 11.19 18.85A19.42 19.42 0 0 1 3.46 12A2 2 0 0 1 5.46 9.82H5.54A2 2 0 0 1 7.25 11.06M23 1L1 23',
  monitor:'M2 3H22A2 2 0 0 1 22 5V15A2 2 0 0 1 20 17H4A2 2 0 0 1 2 15V5A2 2 0 0 1 2 3ZM8 21H16M12 17V21',
  clip:'M21.44 11.05L12.25 20.24A4 4 0 0 1 6.59 14.58L15.78 5.39A2.5 2.5 0 0 1 19.42 9.03L10.22 18.22A1 1 0 0 1 8.78 16.78L17.17 8.39',
  send:'M22 2L11 13M22 2L15 22L11 13M22 2L2 9L11 13',
  smile:'M12 22A10 10 0 1 0 12 2A10 10 0 0 0 12 22ZM8 14S9.5 16 12 16S16 14 16 14M9 9H9.01M15 9H15.01',
  reply:'M9 17L4 12L9 7M20 18V15.5A4 4 0 0 0 16 11.5H4',
  edit:'M11 4H4A2 2 0 0 0 2 6V20A2 2 0 0 0 4 22H18A2 2 0 0 0 20 20V13M18.5 2.5A2.121 2.121 0 0 1 21.5 5.5L12 15L8 16L9 12L18.5 2.5Z',
  trash:'M3 6H21M8 6V4A1 1 0 0 1 9 3H15A1 1 0 0 1 16 4V6M19 6L18.1 20A2 2 0 0 1 16.1 22H7.9A2 2 0 0 1 5.9 20L5 6',
  dl:'M21 15V19A2 2 0 0 1 19 21H5A2 2 0 0 1 3 19V15M7 10L12 15L17 10M12 15V3',
  file:'M13 2H6A2 2 0 0 0 4 4V20A2 2 0 0 0 6 22H18A2 2 0 0 0 20 20V9L13 2ZM13 2V9H20',
  logout:'M9 21H5A2 2 0 0 1 3 19V5A2 2 0 0 1 5 3H9M16 17L21 12L16 7M21 12H9',
  bell:'M18 8A6 6 0 0 0 6 8C6 15 3 17 3 17H21S18 15 18 8ZM13.73 21A2 2 0 0 1 10.27 21',
  shield:'M12 22S3 17.5 3 11V5L12 2L21 5V11C21 17.5 12 22 12 22Z',
  wifi:'M5 12.55A11 11 0 0 1 19.08 12.55M1.42 9A16 16 0 0 1 22.58 9M8.53 16.11A6 6 0 0 1 15.47 16.11M12 20H12.01',
  copy:'M20 9H11A2 2 0 0 0 9 11V20A2 2 0 0 0 11 22H20A2 2 0 0 0 22 20V11A2 2 0 0 0 20 9ZM5 15H4A2 2 0 0 1 2 13V4A2 2 0 0 1 4 2H13A2 2 0 0 1 15 4V5',
  fwd:'M15 17L20 12L15 7M4 18V15.5A4 4 0 0 1 8 11.5H20',
  camera:'M23 19A2 2 0 0 1 21 21H3A2 2 0 0 1 1 19V8A2 2 0 0 1 3 6H7L9 3H15L17 6H21A2 2 0 0 1 23 8V19ZM12 17A4 4 0 1 0 12 9A4 4 0 0 0 12 17Z',
  image:'M19 3H5A2 2 0 0 0 3 5V19A2 2 0 0 0 5 21H19A2 2 0 0 0 21 19V5A2 2 0 0 0 19 3ZM8.5 8.5A1.5 1.5 0 1 0 8.5 5.5A1.5 1.5 0 0 0 8.5 8.5ZM21 15L16 10L5 21',
};

function Ic({n, sz=20, cls='', style={}}) {
  const d = ICON_PATHS[n]||'';
  return (
    <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
         className={cls} style={style}>
      {d.split('M').filter(Boolean).map((p,i)=><path key={i} d={'M'+p}/>)}
    </svg>
  );
}

/* ── AVATAR ────────────────────────────────────────────── */
const Av = memo(({name, photo, online, size='md', onClick}) => {
  const initials = (name||'?').split(' ').map(w=>w[0]||'').join('').slice(0,2).toUpperCase();
  const grad = avGrad(name);
  return (
    <div className={`avatar ${size}`} style={{background:grad}} onClick={onClick}>
      {photo ? <img src={photo} alt={name||''}/> : initials}
      {online !== undefined && (
        <span className="online-dot" style={{background:online?'#10b981':'#4b5563'}}/>
      )}
    </div>
  );
});

/* ── AUTH SCREEN ───────────────────────────────────────── */
function AuthScreen() {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const signIn = async () => {
    setLoading(true); setErr('');
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      const result = await window.fAuth.signInWithPopup(provider);
      const user = result.user;
      const userRef = window.fDB.collection('users').doc(user.uid);
      const snap = await userRef.get();
      if (!snap.exists) {
        // New user — create profile with unique short ID
        let shortId, tries=0;
        do { shortId=genShortId(); tries++; } while(tries<5);
        await userRef.set({
          uid: user.uid,
          shortId,
          displayName: user.displayName || 'User',
          email: user.email,
          photoURL: user.photoURL || null,
          bio: '',
          createdAt: window.fTS(),
          lastSeen: window.fTS(),
        });
      } else {
        // Returning user — sync photo if updated in Firestore
        const data = snap.data();
        if (data.photoURL && data.photoURL !== user.photoURL) {
          await window.fAuth.currentUser?.updateProfile({photoURL: data.photoURL});
        }
      }
    } catch(e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-logo">
          <Ic n="msg" sz={34} cls="" style={{color:'#fff'}}/>
        </div>
        <div className="auth-logo-text">MaSu Peer</div>
        <div style={{textAlign:'center', color:'rgba(167,139,250,.7)', fontSize:13, marginBottom:4}}>
          Royal P2P Messenger
        </div>
        <div className="divider"/>

        <div className="card" style={{padding:'24px'}}>
          <p style={{textAlign:'center', fontSize:13, color:'rgba(253,230,138,.8)', marginBottom:20}}>
            Sign in to start messaging
          </p>
          {err && (
            <div style={{background:'rgba(239,68,68,.12)', border:'1px solid rgba(239,68,68,.3)', borderRadius:12, padding:'10px 14px', marginBottom:16, fontSize:13, color:'#fca5a5'}}>{err}</div>
          )}
          <button className="google-btn" onClick={signIn} disabled={loading}>
            {loading ? (
              <div className="spinner"/>
            ) : (
              <>
                <svg width="20" height="20" viewBox="0 0 24 24">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                </svg>
                Continue with Google
              </>
            )}
          </button>
        </div>

        <div className="trust-row">
          <span className="trust-item"><Ic n="shield" sz={11}/> P2P Encrypted</span>
          <span className="trust-item"><Ic n="wifi" sz={11}/> WebRTC Direct</span>
          <span className="trust-item"><Ic n="shield" sz={11}/> Firebase Auth</span>
        </div>
      </div>
    </div>
  );
}

/* ── NOTIFICATION DROPDOWN ─────────────────────────────── */
function NotifDropdown({s, d, onOpenChat, onClose}) {
  const {incoming, unreadCounts, friends} = s;
  const unreadList = Object.entries(unreadCounts).filter(([,v])=>v.count>0);
  const total = incoming.length + unreadList.reduce((sum,[,v])=>sum+(v.count||0),0);

  const handleAccept = async (req) => {
    const uid = s.user.uid;
    const cid = sortedChatId(uid, req.from);
    try {
      await window.fDB.runTransaction(async tx => {
        const reqRef = window.fDB.collection('friendRequests').doc(req.id);
        tx.update(reqRef, {status:'accepted', acceptedAt:window.fTS()});
        const myFriend = window.fDB.collection('users').doc(uid).collection('friends').doc(req.from);
        const theirFriend = window.fDB.collection('users').doc(req.from).collection('friends').doc(uid);
        tx.set(myFriend, {uid:req.from, name:req.fromName, photoURL:req.fromPhoto||null, shortId:req.fromShortId||'', since:window.fTS()});
        tx.set(theirFriend, {uid, name:s.user.displayName, photoURL:s.user.photoURL||null, shortId:s.userProfile?.shortId||'', since:window.fTS()});
      });
      // Create chat if needed
      const chatRef = window.fDB.collection('chats').doc(cid);
      if (!(await chatRef.get()).exists) {
        await chatRef.set({
          type:'direct', members:[uid, req.from],
          memberProfiles:{
            [uid]:{name:s.user.displayName,photoURL:s.user.photoURL||null,shortId:s.userProfile?.shortId||''},
            [req.from]:{name:req.fromName,photoURL:req.fromPhoto||null,shortId:req.fromShortId||''}
          },
          lastMessage:null, lastMessageTime:window.fTS(),
          createdAt:window.fTS(), updatedAt:window.fTS()
        });
      }
    } catch(err) { console.error('Accept failed:', err); }
  };

  const handleDecline = async (req) => {
    await window.fDB.collection('friendRequests').doc(req.id).update({status:'declined'});
  };

  return (
    <div className="notif-panel slide-d">
      {/* Header */}
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'12px 16px',borderBottom:'1px solid rgba(124,58,237,.2)'}}>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <Ic n="bell" sz={15} style={{color:'#f59e0b'}}/>
          <span style={{fontSize:14,fontWeight:700}}>Notifications</span>
          {total>0 && <span style={{background:'linear-gradient(135deg,#f59e0b,#fbbf24)',color:'#1a0b2e',fontSize:10,fontWeight:900,padding:'1px 6px',borderRadius:10}}>{total}</span>}
        </div>
        <button className="btn-icon" style={{width:28,height:28}} onClick={onClose}><Ic n="x" sz={13}/></button>
      </div>

      <div style={{maxHeight:340,overflowY:'auto'}}>
        {incoming.length===0 && unreadList.length===0 && (
          <div style={{padding:'32px 16px',textAlign:'center',color:'rgba(124,58,237,.5)',fontSize:13}}>
            <Ic n="bell" sz={28} style={{marginBottom:8,opacity:.4,display:'block',margin:'0 auto 8px'}}/>
            All caught up!
          </div>
        )}

        {/* Friend Requests */}
        {incoming.length>0 && (
          <>
            <div className="section-head">Friend Requests · {incoming.length}</div>
            {incoming.map(req => (
              <div key={req.id} style={{display:'flex',alignItems:'center',gap:12,padding:'10px 16px',borderBottom:'1px solid rgba(124,58,237,.1)'}}>
                <Av name={req.fromName} photo={req.fromPhoto} size="sm"/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:600,marginBottom:1}}>{req.fromName}</div>
                  {req.fromShortId && <div className="shortid-chip" style={{display:'inline-block'}}>{req.fromShortId}</div>}
                </div>
                <div style={{display:'flex',gap:6}}>
                  <button onClick={()=>handleAccept(req)} style={{width:32,height:32,borderRadius:10,background:'linear-gradient(135deg,#059669,#10b981)',display:'flex',alignItems:'center',justifyContent:'center',boxShadow:'0 2px 8px rgba(16,185,129,.3)'}}>
                    <Ic n="check" sz={14} style={{color:'#fff'}}/>
                  </button>
                  <button onClick={()=>handleDecline(req)} style={{width:32,height:32,borderRadius:10,background:'rgba(239,68,68,.15)',border:'1px solid rgba(239,68,68,.3)',display:'flex',alignItems:'center',justifyContent:'center'}}>
                    <Ic n="x" sz={14} style={{color:'#f87171'}}/>
                  </button>
                </div>
              </div>
            ))}
          </>
        )}

        {/* Unread Messages */}
        {unreadList.length>0 && (
          <>
            <div className="section-head">Unread Messages</div>
            {unreadList.map(([chatId, data]) => {
              const friend = friends.find(f => chatId.includes(f.uid));
              return (
                <button key={chatId} onClick={()=>{if(friend)onOpenChat(friend);onClose();}}
                  style={{width:'100%',display:'flex',alignItems:'center',gap:12,padding:'10px 16px',borderBottom:'1px solid rgba(124,58,237,.1)',textAlign:'left',transition:'background .15s'}}>
                  <Av name={data.fromName||friend?.name} photo={data.fromPhoto||friend?.photoURL} size="sm"/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                      <span style={{fontSize:13,fontWeight:600}}>{data.fromName||friend?.name||'Someone'}</span>
                      <span className="unread-dot">{data.count>99?'99+':data.count}</span>
                    </div>
                    <div style={{fontSize:11,color:'rgba(167,139,250,.6)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',marginTop:2}}>{data.lastMsg||'New message'}</div>
                  </div>
                </button>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

/* ── SLIDE MENU ────────────────────────────────────────── */
function SlideMenu({s, d, onOpenChat}) {
  const {user, userProfile, incoming, menuTab} = s;

  const RequestsTab = () => (
    incoming.length===0 ? (
      <div className="empty-state">
        <div className="empty-icon"><Ic n="users" sz={26} style={{color:'rgba(124,58,237,.6)'}}/></div>
        <div style={{fontSize:14,fontWeight:600,color:'rgba(167,139,250,.5)'}}>No pending requests</div>
        <div style={{fontSize:12,color:'rgba(124,58,237,.4)',marginTop:4}}>Requests appear here</div>
      </div>
    ) : (
      <div style={{display:'flex',flexDirection:'column',gap:8}}>
        {incoming.map(req => (
          <div key={req.id} className="card" style={{padding:12,display:'flex',alignItems:'center',gap:12,background:'rgba(46,26,101,.45)'}}>
            <Av name={req.fromName} photo={req.fromPhoto} size="sm"/>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:13,fontWeight:600,marginBottom:2}}>{req.fromName}</div>
              {req.fromShortId && <span className="shortid-chip">{req.fromShortId}</span>}
            </div>
            <div style={{display:'flex',gap:6}}>
              <button onClick={async()=>{
                const uid=user.uid, cid=sortedChatId(uid,req.from);
                try {
                  await window.fDB.runTransaction(async tx=>{
                    tx.update(window.fDB.collection('friendRequests').doc(req.id),{status:'accepted',acceptedAt:window.fTS()});
                    tx.set(window.fDB.collection('users').doc(uid).collection('friends').doc(req.from),{uid:req.from,name:req.fromName,photoURL:req.fromPhoto||null,shortId:req.fromShortId||'',since:window.fTS()});
                    tx.set(window.fDB.collection('users').doc(req.from).collection('friends').doc(uid),{uid,name:user.displayName,photoURL:user.photoURL||null,shortId:userProfile?.shortId||'',since:window.fTS()});
                  });
                  const cr=window.fDB.collection('chats').doc(cid);
                  if(!(await cr.get()).exists){await cr.set({type:'direct',members:[uid,req.from],memberProfiles:{[uid]:{name:user.displayName,photoURL:user.photoURL||null,shortId:userProfile?.shortId||''},[req.from]:{name:req.fromName,photoURL:req.fromPhoto||null,shortId:req.fromShortId||''}},lastMessage:null,lastMessageTime:window.fTS(),createdAt:window.fTS(),updatedAt:window.fTS()});}
                } catch(err){console.error(err);}
              }}
                style={{width:32,height:32,borderRadius:10,background:'linear-gradient(135deg,#059669,#10b981)',display:'flex',alignItems:'center',justifyContent:'center',border:'none',cursor:'pointer'}}>
                <Ic n="check" sz={14} style={{color:'#fff'}}/>
              </button>
              <button onClick={()=>window.fDB.collection('friendRequests').doc(req.id).update({status:'declined'})}
                style={{width:32,height:32,borderRadius:10,background:'rgba(239,68,68,.15)',border:'1px solid rgba(239,68,68,.3)',display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer'}}>
                <Ic n="x" sz={14} style={{color:'#f87171'}}/>
              </button>
            </div>
          </div>
        ))}
      </div>
    )
  );

  const SettingsTab = () => (
    <div style={{display:'flex',flexDirection:'column',gap:12}}>
      {/* Profile photo */}
      <div className="card" style={{padding:16,background:'rgba(46,26,101,.4)'}}>
        <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.08em',color:'rgba(253,230,138,.5)',marginBottom:12}}>Profile Photo</div>
        <div style={{display:'flex',alignItems:'center',gap:14}}>
          <div style={{position:'relative',cursor:'pointer'}} onClick={()=>document.getElementById('mp_photo_input').click()}>
            <Av name={user?.displayName} photo={user?.photoURL} size="md"/>
            <div style={{position:'absolute',inset:0,borderRadius:'50%',background:'rgba(0,0,0,.5)',display:'flex',alignItems:'center',justifyContent:'center',opacity:0,transition:'opacity .2s'}}
                 onMouseEnter={e=>e.currentTarget.style.opacity='1'}
                 onMouseLeave={e=>e.currentTarget.style.opacity='0'}>
              <Ic n="camera" sz={14} style={{color:'#fff'}}/>
            </div>
          </div>
          <div>
            <div style={{fontSize:14,fontWeight:700,marginBottom:6}}>{user?.displayName}</div>
            {userProfile?.shortId && (
              <div style={{display:'flex',alignItems:'center',gap:6}}>
                <span className="shortid-chip">{userProfile.shortId}</span>
                <span style={{fontSize:11,color:'rgba(167,139,250,.5)'}}>Your ID</span>
              </div>
            )}
            <button className="btn-gold" style={{marginTop:8,padding:'6px 14px',fontSize:12}}
                    onClick={()=>document.getElementById('mp_photo_input').click()}>
              Change Photo
            </button>
          </div>
        </div>
        <div style={{marginTop:10,fontSize:11,color:'rgba(124,58,237,.4)'}}>Compressed to 160×160 JPEG, stored in Firestore</div>
      </div>
      <input id="mp_photo_input" type="file" accept="image/*" style={{display:'none'}}
        onChange={async e=>{
          const file=e.target.files[0]; if(!file) return;
          try {
            const b64=await compressImg(file);
            await window.fDB.collection('users').doc(user.uid).update({photoURL:b64});
            await window.fAuth.currentUser?.updateProfile({photoURL:b64});
          } catch(err){console.error('Photo upload:',err);}
          e.target.value='';
        }}/>

      {/* P2P Info */}
      <div className="card" style={{padding:16,background:'rgba(46,26,101,.4)'}}>
        <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.08em',color:'rgba(253,230,138,.5)',marginBottom:12}}>P2P Architecture</div>
        {[
          ['STUN servers','ICE only — zero data routed','#34d399'],
          ['TURN relay','Last resort — if direct path fails','#fbbf24'],
          ['Data path','WebRTC DataChannel (browser→browser)','#c4b5fd'],
          ['File transfer','Chunked DataChannel + SHA-256','#93c5fd'],
        ].map(([k,v,c])=>(
          <div key={k} style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',paddingBottom:8,gap:8}}>
            <span style={{fontSize:11,color:'rgba(124,58,237,.6)',flexShrink:0}}>{k}</span>
            <span style={{fontSize:11,fontWeight:600,color:c,textAlign:'right'}}>{v}</span>
          </div>
        ))}
      </div>

      <button onClick={()=>window.fAuth.signOut()}
        style={{width:'100%',padding:'12px',borderRadius:14,display:'flex',alignItems:'center',justifyContent:'center',gap:8,fontSize:14,fontWeight:600,color:'#f87171',background:'rgba(239,68,68,.08)',border:'1px solid rgba(239,68,68,.25)',cursor:'pointer'}}>
        <Ic n="logout" sz={16}/>Sign Out
      </button>
    </div>
  );

  const tabs = [
    {id:'main',label:'Menu'},
    {id:'requests',label:'Requests', badge:incoming.length},
    {id:'settings',label:'Settings'},
  ];

  return (
    <>
      <div className="menu-overlay glass" onClick={()=>d({t:'MENU',v:false})}/>
      <div className="menu-panel slide-l">
        {/* Header */}
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'40px 16px 14px',borderBottom:'1px solid rgba(124,58,237,.2)'}}>
          <div style={{display:'flex',alignItems:'center',gap:12}}>
            <Av name={user?.displayName} photo={user?.photoURL} size="sm"/>
            <div>
              <div style={{fontSize:13,fontWeight:700}}>{user?.displayName}</div>
              {userProfile?.shortId && <div className="shortid-chip" style={{marginTop:3,display:'inline-block'}}>{userProfile.shortId}</div>}
            </div>
          </div>
          <button className="btn-icon" onClick={()=>d({t:'MENU',v:false})}><Ic n="x" sz={16}/></button>
        </div>

        {/* Tabs */}
        <div className="menu-tabs">
          {tabs.map(t => (
            <button key={t.id} className={`menu-tab${menuTab===t.id?' active':''}`}
                    onClick={()=>d({t:'MENU_TAB',v:t.id})}
                    style={{position:'relative'}}>
              {t.label}
              {(t.badge||0)>0 && <span className="notif-badge">{t.badge}</span>}
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{flex:1,overflowY:'auto',padding:'14px 16px'}}>
          {menuTab==='main' && (
            <div style={{display:'flex',flexDirection:'column',gap:8}}>
              <div className="section-label">Navigation</div>
              {[
                {icon:'home',   label:'Home',           fn:()=>{d({t:'VIEW',v:'home'});d({t:'MENU',v:false});}},
                {icon:'msg',    label:'Messages',        fn:()=>{d({t:'VIEW',v:'home'});d({t:'MENU',v:false});}},
                {icon:'users',  label:'Friend Requests', badge:incoming.length, fn:()=>d({t:'MENU_TAB',v:'requests'})},
                {icon:'settings',label:'Settings',       fn:()=>d({t:'MENU_TAB',v:'settings'})},
              ].map(item => (
                <button key={item.label} onClick={item.fn}
                  style={{display:'flex',alignItems:'center',gap:12,padding:'12px 14px',borderRadius:12,background:'rgba(46,26,101,.3)',border:'1px solid rgba(124,58,237,.15)',textAlign:'left',cursor:'pointer',width:'100%'}}>
                  <div style={{width:36,height:36,borderRadius:10,background:'rgba(124,58,237,.2)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                    <Ic n={item.icon} sz={16} style={{color:'rgba(167,139,250,.8)'}}/>
                  </div>
                  <span style={{flex:1,fontSize:13,fontWeight:500,color:'rgba(216,180,254,.9)'}}>{item.label}</span>
                  {(item.badge||0)>0 && <span style={{background:'linear-gradient(135deg,#f59e0b,#fbbf24)',color:'#1a0b2e',fontSize:10,fontWeight:900,padding:'1px 7px',borderRadius:10}}>{item.badge}</span>}
                </button>
              ))}
            </div>
          )}
          {menuTab==='requests' && (<><div className="section-label">Friend Requests</div><RequestsTab/></>)}
          {menuTab==='settings' && (<><div className="section-label">Settings</div><SettingsTab/></>)}
        </div>

        <div style={{padding:'12px 16px',borderTop:'1px solid rgba(124,58,237,.15)',textAlign:'center',fontSize:11,color:'rgba(124,58,237,.4)'}}>
          👑 MaSu Peer · Royal P2P Messenger
        </div>
      </div>
    </>
  );
}

/* ── HOME SCREEN ───────────────────────────────────────── */
function HomeScreen({s, d, pmRef}) {
  const {user, userProfile, friends, incoming, homeSearch, searchResults, searchLoading, presence, unreadCounts} = s;
  const [notifOpen, setNotifOpen] = useState(false);
  const [reqState, setReqState] = useState({}); // uid -> 'loading'|'sent'|'error'
  const notifRef = useRef(null);
  const searchTimer = useRef(null);

  const totalNotif = incoming.length + Object.values(unreadCounts).reduce((s,v)=>s+(v.count||0),0);

  useEffect(() => {
    if (!notifOpen) return;
    const h = e => { if(notifRef.current&&!notifRef.current.contains(e.target)) setNotifOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [notifOpen]);

  const doSearch = async query => {
    d({t:'SRCH_LOAD', v:true});
    if (!query.trim()) { d({t:'RESULTS',v:[]}); return; }
    try {
      // Search by shortId (exact) or displayName (prefix)
      const [byShortId, byName] = await Promise.all([
        window.fDB.collection('users').where('shortId','==',query.toUpperCase()).limit(5).get(),
        window.fDB.collection('users')
          .where('displayName','>=',query)
          .where('displayName','<=',query+'\uf8ff')
          .limit(12).get(),
      ]);
      const all = [...byShortId.docs, ...byName.docs].filter(dc=>dc.id!==user.uid);
      d({t:'RESULTS', v:[...new Map(all.map(dc=>[dc.id,{uid:dc.id,...dc.data()}])).values()]});
    } catch(err) { console.error('Search:', err); d({t:'RESULTS',v:[]}); }
  };

  const handleSearch = v => {
    d({t:'SEARCH',v});
    clearTimeout(searchTimer.current);
    if (!v.trim()) { d({t:'RESULTS',v:[]}); return; }
    searchTimer.current = setTimeout(()=>doSearch(v), 350);
  };

  const sendRequest = async u => {
    setReqState(prev=>({...prev,[u.uid]:'loading'}));
    try {
      // Check existing
      const ex = await window.fDB.collection('friendRequests')
        .where('from','==',user.uid).where('to','==',u.uid)
        .where('status','==','pending').limit(1).get();
      if (!ex.empty) { setReqState(prev=>({...prev,[u.uid]:'sent'})); return; }

      // Create request — this is in Firestore so it persists and works offline
      await window.fDB.collection('friendRequests').add({
        from:        user.uid,
        fromName:    user.displayName,
        fromPhoto:   user.photoURL || null,
        fromShortId: userProfile?.shortId || '',
        to:          u.uid,
        toName:      u.displayName,
        status:      'pending',
        createdAt:   window.fTS(),
        seenAt:      null,
      });
      setReqState(prev=>({...prev,[u.uid]:'sent'}));
    } catch(err) {
      console.error('Send request:', err);
      setReqState(prev=>({...prev,[u.uid]:'error'}));
    }
  };

  const openChat = async (friend) => {
    const uid=user.uid, fid=friend.uid;
    const cid=sortedChatId(uid,fid);
    const chatData={
      id:cid, type:'direct', members:[uid,fid],
      memberProfiles:{
        [uid]:{name:user.displayName,photoURL:user.photoURL||null,shortId:userProfile?.shortId||''},
        [fid]:{name:friend.name||friend.displayName,photoURL:friend.photoURL||null,shortId:friend.shortId||''}
      },
      otherUid:fid, otherName:friend.name||friend.displayName, otherPhoto:friend.photoURL||null,
      otherShortId:friend.shortId||'', lastMessage:null, lastMessageTime:null,
    };
    const ref = window.fDB.collection('chats').doc(cid);
    if(!(await ref.get()).exists)
      await ref.set({...chatData,lastMessageTime:window.fTS(),createdAt:window.fTS(),updatedAt:window.fTS()});
    // Clear unread
    window.fRTDB.ref(`unread/${uid}/${cid}`).remove();
    d({t:'CLEAR_UNREAD', chatId:cid});
    d({t:'ACTIVE_CHAT', id:cid, chat:chatData});
    if(pmRef.current && !pmRef.current.connected(fid)) pmRef.current.connect(fid).catch(()=>{});
  };

  const getRelStatus = uid => {
    if (friends.some(f=>f.uid===uid)) return 'friend';
    if (reqState[uid]==='sent' || s.outgoing?.some(r=>r.to===uid)) return 'pending';
    if (incoming.some(r=>r.from===uid)) return 'incoming';
    return 'none';
  };

  return (
    <div className="screen">
      {/* Header */}
      <div className="header">
        <button className="btn-icon" onClick={()=>d({t:'MENU',v:true})}>
          <Ic n="menu" sz={18}/>
        </button>
        <div className="header-title">
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            <div className="logo-icon"><Ic n="msg" sz={15} style={{color:'#fff'}}/></div>
            <span className="logo-text">MaSu Peer</span>
          </div>
          <span className="logo-sub">Royal Messenger</span>
        </div>
        <div style={{position:'relative'}} ref={notifRef}>
          <button className={`btn-icon${notifOpen?' active':''}`} onClick={()=>setNotifOpen(v=>!v)}>
            <Ic n="bell" sz={18} style={{color:notifOpen?'#fbbf24':undefined}}/>
            {totalNotif>0 && <span className="notif-badge">{totalNotif>99?'99+':totalNotif}</span>}
          </button>
          {notifOpen && <NotifDropdown s={s} d={d} onOpenChat={openChat} onClose={()=>setNotifOpen(false)}/>}
        </div>
      </div>

      <div style={{flex:1,overflowY:'auto',padding:'0 16px 24px'}}>
        {/* Search bar */}
        <div style={{position:'relative',marginBottom:20}}>
          <Ic n="search" sz={16} style={{position:'absolute',left:14,top:'50%',transform:'translateY(-50%)',color:'rgba(124,58,237,.6)',pointerEvents:'none'}}/>
          <input className="input-field" style={{paddingLeft:42}}
            value={homeSearch} onChange={e=>handleSearch(e.target.value)}
            placeholder="Search name or ID (e.g. AB3C4D5E)…"/>
          {searchLoading && <div className="spinner" style={{position:'absolute',right:14,top:'50%',transform:'translateY(-50%)',width:16,height:16}}/>}
        </div>

        {/* Search results */}
        {homeSearch && (
          <div style={{marginBottom:24}}>
            <div className="section-label">Search Results</div>
            {searchResults.length===0 && !searchLoading && (
              <div style={{textAlign:'center',padding:'20px 0',color:'rgba(124,58,237,.5)',fontSize:13}}>No users found for "{homeSearch}"</div>
            )}
            <div style={{display:'flex',flexDirection:'column',gap:8}}>
              {searchResults.map(u => {
                const rel = getRelStatus(u.uid);
                return (
                  <div key={u.uid} className="search-result">
                    <Av name={u.displayName} photo={u.photoURL} online={presence[u.uid]?.online} size="sm"/>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:13,fontWeight:600}}>{u.displayName}</div>
                      {u.shortId && <span className="shortid-chip" style={{marginTop:2,display:'inline-block'}}>{u.shortId}</span>}
                    </div>
                    {rel==='friend' ? (
                      <button className="btn-purple" style={{padding:'6px 14px',fontSize:12}}
                              onClick={()=>openChat({uid:u.uid,name:u.displayName,photoURL:u.photoURL,shortId:u.shortId})}>
                        Chat
                      </button>
                    ) : rel==='pending' ? (
                      <span style={{fontSize:12,fontWeight:600,color:'#fbbf24',background:'rgba(245,158,11,.15)',border:'1px solid rgba(245,158,11,.3)',padding:'5px 10px',borderRadius:10}}>Sent ✓</span>
                    ) : rel==='incoming' ? (
                      <button className="btn-gold" style={{padding:'6px 14px',fontSize:12}}
                              onClick={()=>{d({t:'MENU',v:true});d({t:'MENU_TAB',v:'requests'});}}>
                        Accept
                      </button>
                    ) : (
                      <button onClick={()=>sendRequest(u)} disabled={reqState[u.uid]==='loading'}
                        style={{width:36,height:36,borderRadius:10,background:'linear-gradient(135deg,#f59e0b,#fbbf24)',border:'none',display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer',boxShadow:'0 2px 8px rgba(245,158,11,.35)',flexShrink:0}}>
                        {reqState[u.uid]==='loading' ? <div className="spinner" style={{width:14,height:14,borderColor:'#1a0b2e',borderTopColor:'transparent'}}/> : <Ic n="plus" sz={16} style={{color:'#1a0b2e'}}/>}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Friends row */}
        {!homeSearch && friends.length>0 && (
          <div style={{marginBottom:24}}>
            <div className="section-label">Friends · {friends.length}</div>
            <div className="friends-row">
              {friends.map(f => {
                const cid=sortedChatId(user.uid,f.uid);
                const uc=unreadCounts[cid];
                return (
                  <div key={f.uid} className="friend-item" onClick={()=>openChat(f)}>
                    <div style={{position:'relative'}}>
                      <Av name={f.name} photo={f.photoURL} online={presence[f.uid]?.online} size="md"/>
                      {(uc?.count||0)>0 && <span className="notif-badge" style={{background:'linear-gradient(135deg,#7c3aed,#a855f7)',color:'#fff'}}>{uc.count}</span>}
                    </div>
                    <span>{f.name?.split(' ')[0]||'User'}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Recent conversations */}
        {!homeSearch && (
          <div>
            <div className="section-label">{friends.length>0?'Conversations':'Get Started'}</div>
            {friends.length===0 ? (
              <div className="card" style={{padding:32,textAlign:'center'}}>
                <div className="empty-icon" style={{background:'linear-gradient(135deg,#4c1d95,#7c3aed)',boxShadow:'0 4px 20px rgba(124,58,237,.3)',marginBottom:16}}>
                  <Ic n="msg" sz={28} style={{color:'#fff'}}/>
                </div>
                <div style={{fontSize:16,fontWeight:700,marginBottom:8}}>Welcome to MaSu Peer</div>
                <div style={{fontSize:13,color:'rgba(167,139,250,.6)',marginBottom:16}}>Search for friends by name or their unique ID (e.g. AB3C4D5E) and send a friend request to start chatting.</div>
                {userProfile?.shortId && (
                  <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:4}}>
                    <div style={{fontSize:11,color:'rgba(253,230,138,.5)'}}>Your ID — share with friends:</div>
                    <div className="shortid-chip" style={{fontSize:16,padding:'6px 14px',letterSpacing:'.1em'}}>{userProfile.shortId}</div>
                  </div>
                )}
              </div>
            ) : (
              <div style={{display:'flex',flexDirection:'column',gap:8}}>
                {friends.map(f => {
                  const cid=sortedChatId(user.uid,f.uid);
                  const uc=unreadCounts[cid];
                  return (
                    <button key={f.uid} className="chat-item" onClick={()=>openChat(f)}
                      style={{background:'rgba(28,18,64,.6)',border:'1px solid rgba(124,58,237,.12)',width:'100%',textAlign:'left'}}>
                      <Av name={f.name} photo={f.photoURL} online={presence[f.uid]?.online} size="sm"/>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                          <span style={{fontSize:13,fontWeight:600}}>{f.name}</span>
                          {uc?.ts && <span style={{fontSize:10,color:'rgba(124,58,237,.5)'}}>{fmtTime({seconds:Math.floor(uc.ts/1000)})}</span>}
                        </div>
                        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginTop:2}}>
                          <span style={{fontSize:11,color:'rgba(167,139,250,.5)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{uc?.lastMsg||'Tap to chat'}</span>
                          {(uc?.count||0)>0 && <span className="unread-dot">{uc.count>99?'99+':uc.count}</span>}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── CHAT SCREEN ───────────────────────────────────────── */
function ChatScreen({s, d, pmRef, teRef, presRef}) {
  const {user, userProfile, activeChatId, activeChat, msgs, cursors, loadingMsgs, typing, presence, transfers, activeTid} = s;
  const [input, setInput]     = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [editing, setEditing] = useState(null);
  const [p2pConn, setP2pConn] = useState(null); // 'stun'|'turn'|'cloud'|null
  const [loadingOld, setLoadingOld] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQ, setSearchQ]       = useState('');
  const [searchIdx, setSearchIdx]   = useState(0);
  const endRef=useRef(), topRef=useRef(), fileRef=useRef(), typingTimer=useRef();

  const chatMsgs = activeChatId ? (msgs[activeChatId]||[]) : [];
  const cursor   = activeChatId ? cursors[activeChatId] : null;
  const ou       = activeChat?.members?.find(m=>m!==user?.uid);
  const ouPres   = ou ? presence[ou] : null;
  const typers   = activeChatId
    ? Object.entries(typing[activeChatId]||{}).filter(([u,v])=>v&&u!==user?.uid).map(([u])=>activeChat?.memberProfiles?.[u]?.name||'Someone')
    : [];
  const xfer = activeTid ? transfers[activeTid] : null;

  const searchMatches = useMemo(()=>{
    if(!showSearch||!searchQ.trim()) return [];
    const q=searchQ.toLowerCase();
    return chatMsgs.reduce((acc,m,i)=>{if(!m.deleted&&(m.content||'').toLowerCase().includes(q))acc.push(i);return acc;},[]);
  },[chatMsgs,showSearch,searchQ]);
  const displayMsgs = (showSearch&&searchQ) ? chatMsgs.filter((_,i)=>searchMatches.includes(i)) : chatMsgs;

  useEffect(()=>{ endRef.current?.scrollIntoView({behavior:'smooth'}); },[chatMsgs.length,activeChatId]);

  useEffect(()=>{
    if(!activeChatId||!user) return;
    loadMsgs(false);
    // Real-time message subscription
    const unsubMsgs = window.fDB.collection('chats').doc(activeChatId).collection('messages')
      .orderBy('timestamp','asc').limitToLast(1)
      .onSnapshot(snap=>{
        snap.docChanges().forEach(ch=>{
          const m={id:ch.doc.id,...ch.doc.data()};
          if(ch.type==='added')    d({t:'ADD_MSG',id:activeChatId,msg:m});
          if(ch.type==='modified') d({t:'UPD_MSG',id:activeChatId,mid:m.id,upd:m});
          idb.put('messages',m).catch(()=>{});
        });
      });
    // Typing
    const typRef = window.fRTDB.ref(`typing/${activeChatId}`);
    typRef.on('child_added',  snap=>{if(snap.key!==user.uid)d({t:'TYPING',chatId:activeChatId,uid:snap.key,v:true});});
    typRef.on('child_removed',snap=>d({t:'TYPING',chatId:activeChatId,uid:snap.key,v:false}));
    // P2P connect
    if(ou&&pmRef.current&&!pmRef.current.connected(ou)) pmRef.current.connect(ou).catch(()=>{});
    const p2pPoll = setInterval(()=>{
      if(pmRef.current&&ou){
        const ok=pmRef.current.connected(ou), ct=pmRef.current.connType(ou);
        setP2pConn(ok?(ct==='turn'?'turn':'stun'):'cloud');
      }
    },2000);
    // Clear unread
    window.fRTDB.ref(`unread/${user.uid}/${activeChatId}`).remove();
    d({t:'CLEAR_UNREAD', chatId:activeChatId});
    window.fDB.collection('chats').doc(activeChatId).update({[`readBy.${user.uid}`]:window.fTS()}).catch(()=>{});
    return ()=>{ unsubMsgs(); typRef.off(); clearInterval(p2pPoll); };
  },[activeChatId]);

  const loadMsgs = async (older=false) => {
    if(!activeChatId) return;
    d({t:'LOAD_MSGS',id:activeChatId,v:true});
    try {
      let q = window.fDB.collection('chats').doc(activeChatId).collection('messages')
        .orderBy('timestamp','desc').limit(30);
      if(older&&cursor) q=q.startAfter(cursor);
      const snap=await q.get();
      const ms=snap.docs.map(dc=>({id:dc.id,...dc.data()})).reverse();
      d({t:'MSGS',id:activeChatId,msgs:ms,cursor:snap.docs.length>0?snap.docs[snap.docs.length-1]:null,append:older});
      ms.forEach(m=>idb.put('messages',m).catch(()=>{}));
    } catch(_) { d({t:'LOAD_MSGS',id:activeChatId,v:false}); }
  };

  const loadOlder = async () => {
    if(loadingOld||!cursor) return;
    const cont=topRef.current?.closest('[style*="overflow"]')||topRef.current?.parentElement;
    const prev=cont?.scrollHeight;
    setLoadingOld(true); await loadMsgs(true); setLoadingOld(false);
    if(cont&&prev) cont.scrollTop=cont.scrollHeight-prev;
  };

  const handleTyping = v => {
    setInput(v); presRef.current?.setTyping(activeChatId,true);
    clearTimeout(typingTimer.current);
    typingTimer.current=setTimeout(()=>presRef.current?.setTyping(activeChatId,false),2000);
  };

  const send = async () => {
    const content=input.trim();
    if(!content||!activeChatId||!user) return;
    setInput(''); setReplyTo(null); presRef.current?.setTyping(activeChatId,false); clearTimeout(typingTimer.current);
    if(editing){
      await window.fDB.collection('chats').doc(activeChatId).collection('messages').doc(editing.id)
        .update({content,edited:true,editedAt:window.fTS()});
      d({t:'UPD_MSG',id:activeChatId,mid:editing.id,upd:{content,edited:true}});
      setEditing(null); return;
    }
    const mid=genId();
    const data={chatId:activeChatId,senderId:user.uid,senderName:user.displayName,
      type:'text',content,deleted:false,edited:false,
      replyTo:replyTo?{id:replyTo.id,content:replyTo.content,senderId:replyTo.senderId}:null,
      reactions:{},deliveredTo:[],readBy:[user.uid]};
    // Try P2P delivery (fast path)
    if(pmRef.current&&ou) pmRef.current.send(ou,{type:'message',chatId:activeChatId,msg:{...data,id:mid}});
    // Persist to Firestore (reliable path)
    await window.fDB.collection('chats').doc(activeChatId).collection('messages').doc(mid)
      .set({...data,timestamp:window.fTS()});
    await window.fDB.collection('chats').doc(activeChatId).update({
      lastMessage:{content,senderId:user.uid,timestamp:window.fTS(),type:'text'},
      lastMessageTime:window.fTS(), updatedAt:window.fTS()
    });
    // Increment receiver's unread counter in RTDB
    if(ou){
      window.fRTDB.ref(`unread/${ou}/${activeChatId}`).transaction(cur=>{
        const existing=cur||{count:0};
        return {count:(existing.count||0)+1,lastMsg:content.slice(0,80),fromName:user.displayName,fromPhoto:user.photoURL||null,chatId:activeChatId,ts:Date.now()};
      });
    }
  };

  const sendFile = async (file) => {
    if(!file||!activeChatId||!user) return;
    if(file.size>104857600){alert('Maximum file size is 100 MB');return;}
    const tid=genId(), mid=genId();
    d({t:'ACTIVE_TID',v:tid});
    const isImg=file.type.startsWith('image/');
    await window.fDB.collection('chats').doc(activeChatId).collection('messages').doc(mid).set({
      chatId:activeChatId,senderId:user.uid,senderName:user.displayName,
      type:isImg?'image':'file',content:file.name,deleted:false,reactions:{},readBy:[user.uid],
      fileMetadata:{name:file.name,size:file.size,type:file.type,transferId:tid,downloadUrl:null},
      timestamp:window.fTS()
    });
    if(ou&&teRef.current) teRef.current.send(file,ou,tid);
  };

  const doReact = async (msgId, emoji) => {
    const ref=window.fDB.collection('chats').doc(activeChatId).collection('messages').doc(msgId);
    const snap=await ref.get();
    const rx={...(snap.data()?.reactions||{})};
    const uids=rx[emoji]||[];
    rx[emoji]=uids.includes(user.uid)?uids.filter(u=>u!==user.uid):[...uids,user.uid];
    await ref.update({reactions:rx});
  };
  const doDelete = mid => window.fDB.collection('chats').doc(activeChatId).collection('messages').doc(mid).update({deleted:true,content:''});
  const doCall   = type => { if(ou) d({t:'CALL',state:'calling',data:{ru:ou,callType:type,ruName:activeChat?.otherName||'Unknown'}}); };

  const nm  = activeChat?.otherName||'Unknown';
  const ph  = activeChat?.otherPhoto;
  const sid = activeChat?.memberProfiles?.[ou]?.shortId;

  const P2PBadge = () => {
    if(!p2pConn) return null;
    const cfg = {
      stun:  {cls:'stun',  label:'🔗 STUN Direct',   tip:'Direct P2P — no server in data path'},
      turn:  {cls:'turn',  label:'↗ TURN Relay',     tip:'Relayed — direct path blocked by NAT'},
      cloud: {cls:'cloud', label:'☁ Firebase',       tip:'Via Firestore — P2P connecting…'},
    }[p2pConn];
    return <span className={`p2p-badge ${cfg.cls}`} title={cfg.tip}>{cfg.label}</span>;
  };

  return (
    <div className="screen">
      {/* Header */}
      <div style={{display:'flex',alignItems:'center',gap:12,padding:'40px 16px 12px',background:'linear-gradient(180deg,rgba(30,18,69,.95) 0%,rgba(16,11,42,.95) 100%)',borderBottom:'1px solid rgba(124,58,237,.2)',flexShrink:0}}>
        <button className="btn-icon" onClick={()=>d({t:'VIEW',v:'home'})}><Ic n="chevL" sz={18}/></button>
        <Av name={nm} photo={ph} online={ouPres?.online} size="sm"/>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
            <span style={{fontSize:14,fontWeight:700}}>{nm}</span>
            {sid && <span className="shortid-chip">{sid}</span>}
            <P2PBadge/>
          </div>
          <div style={{fontSize:11,marginTop:1}}>{ouPres?.online ? <span style={{color:'#10b981'}}>Online</span> : <span style={{color:'rgba(124,58,237,.5)'}}>Offline</span>}</div>
        </div>
        <div style={{display:'flex',gap:4}}>
          <button className={`btn-icon${showSearch?' active':''}`} onClick={()=>{setShowSearch(v=>!v);setSearchQ('');}}>
            <Ic n="search" sz={16} style={{color:showSearch?'#fbbf24':undefined}}/>
          </button>
          <button className="btn-icon" onClick={()=>doCall('audio')}><Ic n="phone" sz={16} style={{color:'#10b981'}}/></button>
          <button className="btn-icon" onClick={()=>doCall('video')}><Ic n="video" sz={16} style={{color:'#3b82f6'}}/></button>
        </div>
      </div>

      {/* Search bar */}
      {showSearch && (
        <div style={{display:'flex',alignItems:'center',gap:8,padding:'8px 12px',background:'rgba(16,11,42,.9)',borderBottom:'1px solid rgba(124,58,237,.15)',flexShrink:0}}>
          <div style={{flex:1,display:'flex',alignItems:'center',gap:8,background:'rgba(46,26,101,.4)',border:'1px solid rgba(124,58,237,.3)',borderRadius:12,padding:'6px 12px'}}>
            <Ic n="search" sz={13} style={{color:'rgba(124,58,237,.6)',flexShrink:0}}/>
            <input value={searchQ} onChange={e=>{setSearchQ(e.target.value);setSearchIdx(0);}} placeholder="Search messages…" autoFocus style={{background:'none',border:'none',outline:'none',fontSize:13,color:'#fff',flex:1,fontFamily:'inherit'}}/>
            {searchQ && <span style={{fontSize:11,color:'rgba(253,230,138,.5)',flexShrink:0}}>{searchMatches.length>0?`${searchIdx+1}/${searchMatches.length}`:'0'}</span>}
          </div>
          {searchMatches.length>1 && <>
            <button className="btn-icon" style={{width:32,height:32}} onClick={()=>setSearchIdx(i=>(i-1+searchMatches.length)%searchMatches.length)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="18 15 12 9 6 15"/></svg>
            </button>
            <button className="btn-icon" style={{width:32,height:32}} onClick={()=>setSearchIdx(i=>(i+1)%searchMatches.length)}>
              <Ic n="chevD" sz={12}/>
            </button>
          </>}
          <button className="btn-icon" style={{width:32,height:32}} onClick={()=>{setShowSearch(false);setSearchQ('');}}>
            <Ic n="x" sz={13}/>
          </button>
        </div>
      )}

      {/* Messages */}
      <div style={{flex:1,overflowY:'auto',padding:'12px 16px',display:'flex',flexDirection:'column',gap:4}}>
        {cursor && !showSearch && (
          <div style={{display:'flex',justifyContent:'center',paddingBottom:8}}>
            <button onClick={loadOlder} disabled={loadingOld}
              style={{fontSize:11,padding:'5px 16px',borderRadius:20,background:'rgba(124,58,237,.2)',border:'1px solid rgba(124,58,237,.3)',color:'rgba(167,139,250,.8)',cursor:'pointer'}}>
              {loadingOld?'Loading…':'↑ Earlier messages'}
            </button>
          </div>
        )}
        <div ref={topRef}/>
        {loadingMsgs[activeChatId]&&chatMsgs.length===0 ? (
          <div style={{display:'flex',alignItems:'center',justifyContent:'center',flex:1,padding:40}}>
            <div className="spinner"/>
          </div>
        ) : displayMsgs.length===0 ? (
          <div className="empty-state" style={{flex:1}}>
            <div className="empty-icon"><Ic n={showSearch?'search':'msg'} sz={24} style={{color:'rgba(124,58,237,.5)'}}/></div>
            <div style={{fontSize:13,color:'rgba(124,58,237,.5)'}}>{showSearch?'No matches':'No messages yet'}</div>
            {!showSearch && <div style={{fontSize:11,color:'rgba(124,58,237,.3)',marginTop:4}}>Say hello 👑</div>}
          </div>
        ) : displayMsgs.map((msg,i)=>{
          const own=msg.senderId===user?.uid;
          const prev=displayMsgs[i-1];
          const showAv=!own&&(!prev||prev.senderId!==msg.senderId);
          const showDate=!prev||(msg.timestamp&&prev.timestamp&&new Date((msg.timestamp?.seconds||0)*1000).toDateString()!==new Date((prev.timestamp?.seconds||0)*1000).toDateString());
          const isHit=showSearch&&searchMatches[searchIdx]===chatMsgs.indexOf(msg);
          return (
            <React.Fragment key={msg.id}>
              {showDate&&msg.timestamp&&(
                <div style={{display:'flex',justifyContent:'center',padding:'8px 0'}}>
                  <span style={{fontSize:11,padding:'3px 12px',borderRadius:20,background:'rgba(46,26,101,.6)',border:'1px solid rgba(124,58,237,.2)',color:'rgba(253,230,138,.6)'}}>
                    {new Date((msg.timestamp?.seconds||0)*1000).toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'})}
                  </span>
                </div>
              )}
              <div ref={isHit?el=>el?.scrollIntoView({behavior:'smooth',block:'center'}):null}>
                <MsgBubble msg={msg} own={own} showAv={showAv}
                  senderName={activeChat?.memberProfiles?.[msg.senderId]?.name||msg.senderName}
                  uid={user?.uid} highlight={isHit}
                  onReact={doReact} onReply={setReplyTo}
                  onEdit={m=>{setEditing(m);setInput(m.content);}} onDelete={doDelete}/>
              </div>
            </React.Fragment>
          );
        })}
        <div ref={endRef}/>
      </div>

      {/* Typing */}
      {typers.length>0&&(
        <div style={{display:'flex',alignItems:'center',gap:8,padding:'6px 16px',flexShrink:0}}>
          <div style={{display:'flex',alignItems:'center',gap:3,padding:'6px 12px',borderRadius:16,background:'rgba(46,26,101,.6)'}}>
            <span className="typing-dot"/><span className="typing-dot"/><span className="typing-dot"/>
          </div>
          <span style={{fontSize:11,color:'rgba(167,139,250,.5)'}}>{typers.join(', ')} typing…</span>
        </div>
      )}

      {/* Transfer bar */}
      {xfer&&(xfer.pct||0)<100&&(
        <div className="xfer-bar">
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:4}}>
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              <Ic n="file" sz={13} style={{color:'rgba(167,139,250,.7)'}}/>
              <span style={{fontSize:12,fontWeight:500,maxWidth:140,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{xfer.name}</span>
              {xfer.dir==='recv'&&<span style={{fontSize:11,color:'#10b981'}}>↓ Receiving</span>}
            </div>
            <span style={{fontSize:12,fontWeight:700,color:'#fbbf24'}}>{xfer.pct||0}%</span>
          </div>
          <div className="xfer-progress"><div className="xfer-fill" style={{width:`${xfer.pct||0}%`}}/></div>
          {xfer.speed&&<div style={{display:'flex',justifyContent:'space-between',marginTop:4,fontSize:11,color:'rgba(124,58,237,.5)'}}>
            <span>{fmtBytes(xfer.speed)}/s</span>{xfer.eta&&<span>~{Math.round(xfer.eta)}s left</span>}
          </div>}
        </div>
      )}

      {/* Reply/Edit */}
      {(replyTo||editing)&&(
        <div className="reply-preview">
          <div style={{minWidth:0,flex:1}}>
            <div style={{fontSize:11,fontWeight:700,color:'#fbbf24',marginBottom:2}}>{editing?'Editing message':'Reply to '+replyTo.senderName}</div>
            <div style={{fontSize:11,color:'rgba(167,139,250,.6)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{(editing||replyTo)?.content}</div>
          </div>
          <button onClick={()=>{setReplyTo(null);setEditing(null);setInput('');}} style={{padding:4,borderRadius:8,background:'rgba(124,58,237,.2)',marginLeft:8,flexShrink:0,cursor:'pointer'}}>
            <Ic n="x" sz={13} style={{color:'rgba(167,139,250,.7)'}}/>
          </button>
        </div>
      )}

      {/* Input */}
      <div className="input-bar">
        <div className="input-inner">
          <button onClick={()=>fileRef.current?.click()} style={{padding:'4px 6px',borderRadius:8,color:'rgba(124,58,237,.5)',cursor:'pointer',flexShrink:0}}>
            <Ic n="clip" sz={18}/>
          </button>
          <textarea value={input} onChange={e=>handleTyping(e.target.value)} rows={1}
            onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}}}
            placeholder={editing?'Edit message…':'Message…'}/>
          <button onClick={send} disabled={!input.trim()} className={`send-btn${input.trim()?' active':''}`}>
            <Ic n="send" sz={15} style={{color:input.trim()?'#1a0b2e':'rgba(124,58,237,.4)'}}/>
          </button>
        </div>
      </div>
      <input ref={fileRef} type="file" style={{display:'none'}} onChange={e=>{if(e.target.files[0]){sendFile(e.target.files[0]);e.target.value='';}}}/>
    </div>
  );
}

/* ── MESSAGE BUBBLE ────────────────────────────────────── */
const MsgBubble = memo(({msg, own, showAv, senderName, uid, highlight, onReact, onReply, onEdit, onDelete}) => {
  const [menu,  setMenu]  = useState(false);
  const [rxPick,setRxPick]= useState(false);
  const ref = useRef(null);

  useEffect(()=>{
    if(!menu) return;
    const h=e=>{if(ref.current&&!ref.current.contains(e.target))setMenu(false);};
    document.addEventListener('mousedown',h);
    return()=>document.removeEventListener('mousedown',h);
  },[menu]);

  const fmtT = ts => {
    if(!ts) return '';
    const d=ts.toDate?ts.toDate():new Date((ts.seconds||0)*1000);
    return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  };

  const rx = Object.entries(msg.reactions||{}).filter(([,v])=>Array.isArray(v)&&v.length>0);

  const Body = () => {
    if(msg.deleted) return <span style={{fontStyle:'italic',fontSize:13,color:'rgba(124,58,237,.5)'}}>Message deleted</span>;
    switch(msg.type){
      case 'file': return (
        <div style={{display:'flex',alignItems:'center',gap:12}}>
          <div style={{width:40,height:40,borderRadius:12,background:own?'rgba(255,255,255,.15)':'rgba(124,58,237,.2)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
            <Ic n="file" sz={18} style={{color:own?'#fff':'rgba(167,139,250,.9)'}}/>
          </div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:13,fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{msg.fileMetadata?.name||'File'}</div>
            <div style={{fontSize:11,color:own?'rgba(255,255,255,.5)':'rgba(167,139,250,.5)'}}>{msg.fileMetadata?.size?fmtBytes(msg.fileMetadata.size):''}</div>
          </div>
          {msg.fileMetadata?.downloadUrl&&(
            <a href={msg.fileMetadata.downloadUrl} download={msg.fileMetadata.name} onClick={e=>e.stopPropagation()}
               style={{padding:'6px',borderRadius:8,background:own?'rgba(255,255,255,.15)':'rgba(124,58,237,.2)',display:'flex',flexShrink:0}}>
              <Ic n="dl" sz={15} style={{color:own?'#fff':'rgba(167,139,250,.9)'}}/>
            </a>
          )}
        </div>
      );
      case 'image': return (
        <div>
          {msg.fileMetadata?.downloadUrl&&<img src={msg.fileMetadata.downloadUrl} alt="img" style={{maxWidth:'100%',borderRadius:12,maxHeight:240,objectFit:'cover'}}/>}
          {msg.content&&<p style={{marginTop:6,fontSize:13}}>{msg.content}</p>}
        </div>
      );
      case 'system': return <p style={{fontSize:11,textAlign:'center',color:'rgba(167,139,250,.5)'}}>{msg.content}</p>;
      default: return (
        <div>
          {msg.replyTo&&<div style={{padding:'6px 10px',marginBottom:8,borderRadius:10,borderLeft:'2px solid #f59e0b',background:own?'rgba(255,255,255,.1)':'rgba(124,58,237,.15)'}}><p style={{fontSize:11,color:'rgba(253,230,138,.7)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{msg.replyTo.content}</p></div>}
          <p style={{fontSize:14,lineHeight:1.45,whiteSpace:'pre-wrap',wordBreak:'break-word'}}>{msg.content}</p>
          {msg.edited&&<span style={{fontSize:10,color:own?'rgba(255,255,255,.35)':'rgba(167,139,250,.35)'}}> (edited)</span>}
        </div>
      );
    }
  };

  const menuItems = [
    {n:'smile',  l:'React',   fn:()=>setRxPick(v=>!v)},
    {n:'reply',  l:'Reply',   fn:()=>{onReply(msg);setMenu(false);}},
    {n:'copy',   l:'Copy',    fn:()=>{navigator.clipboard.writeText(msg.content||'');setMenu(false);}},
    {n:'fwd',    l:'Forward', fn:()=>setMenu(false)},
    ...(own&&!msg.deleted&&msg.type==='text'?[{n:'edit',l:'Edit',fn:()=>{onEdit(msg);setMenu(false);}}]:[]),
    ...(own?[{n:'trash',l:'Delete',fn:()=>{onDelete(msg.id);setMenu(false);},danger:true}]:[]),
  ];

  return (
    <div className={`msg-row${own?' own':''} msg-enter`} ref={ref}>
      {!own && <div style={{width:28,flexShrink:0}}>{showAv&&<Av name={senderName} size="sm"/>}</div>}
      <div className="msg-w">
        {!own&&showAv&&senderName&&<p style={{fontSize:11,fontWeight:700,color:'#f59e0b',marginBottom:3,marginLeft:2}}>{senderName}</p>}
        <div className={`bubble${own?' own':' other'}${highlight?' highlight':''}`}>
          <Body/>
          {msg.type!=='system'&&(
            <div className={`bubble-meta${own?' own':''}`}>
              <span className="bubble-time">{fmtT(msg.timestamp)}</span>
              {own&&<span style={{color:msg.readBy?.length>1?'#fbbf24':'rgba(255,255,255,.3)'}}><Ic n={msg.readBy?.length>1?'checks':'check'} sz={11}/></span>}
            </div>
          )}
          {msg.type!=='system'&&<button className={`bubble-menu-btn${own?' own':' other'}`} onClick={()=>setMenu(v=>!v)}><Ic n="chevD" sz={10} style={{color:'#fff'}}/></button>}
        </div>
        {rx.length>0&&(
          <div className={`rx-row${own?' justify-end':''}`} style={{justifyContent:own?'flex-end':'flex-start'}}>
            {rx.map(([em,uids])=>(
              <button key={em} className="rx-btn" onClick={()=>onReact(msg.id,em)}>
                {em}<span style={{color:'rgba(253,230,138,.6)'}}>{uids.length}</span>
              </button>
            ))}
          </div>
        )}
        {menu&&(
          <div className={`context-menu${own?' own':' other'}`}>
            {menuItems.map(item=>(
              <button key={item.l} className={`ctx-item${item.danger?' danger':''}`} onClick={item.fn}>
                <Ic n={item.n} sz={14}/>{item.l}
              </button>
            ))}
            {rxPick&&(
              <div style={{display:'flex',gap:6,padding:'8px 12px',flexWrap:'wrap',borderTop:'1px solid rgba(124,58,237,.2)'}}>
                {EMOJIS.map(em=><button key={em} onClick={()=>{onReact(msg.id,em);setMenu(false);setRxPick(false);}} style={{fontSize:20,cursor:'pointer',transition:'transform .15s'}} onMouseEnter={e=>e.target.style.transform='scale(1.25)'} onMouseLeave={e=>e.target.style.transform='scale(1)'}>{em}</button>)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

/* ── CALL OVERLAY ──────────────────────────────────────── */
function CallOverlay({s, d, cmRef}) {
  const {callState,callData,callLS,callRS,callDur,muted,camOff,user}=s;
  const lvRef=useRef(), rvRef=useRef();
  useEffect(()=>{if(lvRef.current&&callLS)lvRef.current.srcObject=callLS;},[callLS]);
  useEffect(()=>{if(rvRef.current&&callRS)rvRef.current.srcObject=callRS;},[callRS]);
  if(!callState) return null;
  const isVid=callData?.callType==='video';
  const rn=callData?.ruName||'Unknown';
  const end=()=>{cmRef.current?.end(callData?.ru||'');d({t:'CALL',state:null,data:null});d({t:'CALL_LS',v:null});d({t:'CALL_RS',v:null});};
  const accept=()=>{if(!callData||!cmRef.current)return;cmRef.current.accept(callData.ru,callData.callId||'',callData.sdp||'',callData.callType);window.fRTDB.ref(`calls/${user?.uid}/offer`).remove();};
  return(
    <div className="call-screen">
      {isVid&&callRS&&<video ref={rvRef} autoPlay playsInline style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover'}}/>}
      <div style={{position:'relative',zIndex:1,display:'flex',flexDirection:'column',height:'100%'}}>
        <div style={{display:'flex',flexDirection:'column',alignItems:'center',paddingTop:80,paddingBottom:16}}>
          <Av name={rn} size="xl"/>
          <div style={{fontSize:24,fontWeight:900,marginTop:20,marginBottom:6}}>{rn}</div>
          <div style={{fontSize:13,color:callState==='active'?'#10b981':'rgba(253,230,138,.7)'}}>
            {callState==='calling'?'Ringing…':callState==='incoming'?`Incoming ${isVid?'video':'voice'} call`:callState==='active'?fmtSecs(callDur):''}
          </div>
          {callState==='active'&&<div style={{marginTop:8,fontSize:11,padding:'3px 12px',borderRadius:20,background:'rgba(124,58,237,.2)',border:'1px solid rgba(124,58,237,.3)',color:'rgba(167,139,250,.7)'}}>🔒 WebRTC Encrypted · {isVid?'Video':'Voice'}</div>}
        </div>
        {isVid&&callLS&&callState==='active'&&(
          <div className="pip-video"><video ref={lvRef} autoPlay muted playsInline style={{width:'100%',height:'100%',objectFit:'cover'}}/></div>
        )}
        <div style={{flex:1}}/>
        <div style={{paddingBottom:64,paddingLeft:40,paddingRight:40}}>
          {callState==='incoming'?(
            <div className="call-controls">
              <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:8}}>
                <button className="call-btn end" onClick={end}><Ic n="phoneoff" sz={24} style={{color:'#fff'}}/></button>
                <span style={{fontSize:12,color:'#f87171'}}>Decline</span>
              </div>
              <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:8}}>
                <button className="call-btn accept ringing" onClick={accept}><Ic n="phone" sz={24} style={{color:'#fff'}}/></button>
                <span style={{fontSize:12,color:'#10b981'}}>Accept</span>
              </div>
            </div>
          ):(
            <div className="call-controls">
              <button className={`call-btn${muted?' muted':''}`} onClick={()=>{const v=cmRef.current?.toggleMute();if(v!==undefined)d({t:'MUTE',v:!v});}}>
                <Ic n={muted?'micoff':'mic'} sz={20} style={{color:muted?'#f87171':'#fff'}}/>
              </button>
              {isVid&&<button className={`call-btn${camOff?' muted':''}`} onClick={()=>{const v=cmRef.current?.toggleCam();if(v!==undefined)d({t:'CAM',v:!v});}}>
                <Ic n={camOff?'camoff':'video'} sz={20} style={{color:camOff?'#f87171':'#fff'}}/>
              </button>}
              <button className="call-btn end" onClick={end}><Ic n="phoneoff" sz={24} style={{color:'#fff'}}/></button>
              {isVid&&<button className="call-btn" onClick={()=>cmRef.current?.toggleScreen()}><Ic n="monitor" sz={20} style={{color:'#fff'}}/></button>}
              {!isVid&&<div style={{width:56}}/>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── APP ROOT ──────────────────────────────────────────── */
function App() {
  const [s, d] = useReducer(reduce, INIT);
  const pmRef   = useRef(null);
  const teRef   = useRef(null);
  const cmRef   = useRef(null);
  const presRef = useRef(null);
  const sigRefs = useRef([]);
  const prevCS  = useRef(null);

  /* ── Auth ── */
  useEffect(()=>{
    return window.fAuth.onAuthStateChanged(async user=>{
      d({t:'AUTH',u:user});
      if(user){
        const pRef=window.fDB.collection('users').doc(user.uid);
        const snap=await pRef.get();
        let profile=snap.data();
        if(!snap.exists){
          const shortId=genShortId();
          profile={uid:user.uid,shortId,displayName:user.displayName||'User',email:user.email,photoURL:user.photoURL||null,bio:'',createdAt:window.fTS(),lastSeen:window.fTS()};
          await pRef.set(profile);
        } else if(profile.photoURL&&profile.photoURL!==user.photoURL){
          await window.fAuth.currentUser?.updateProfile({photoURL:profile.photoURL}).catch(()=>{});
        }
        d({t:'PROFILE',p:profile});
        initServices(user);
        loadFriends(user.uid);
        loadRequests(user.uid);
        loadUnreads(user.uid);
      } else {
        cleanup();
      }
    });
  },[]);

  /* ── Trigger outgoing call ── */
  useEffect(()=>{
    if(s.callState==='calling'&&prevCS.current!=='calling'&&s.callData&&cmRef.current)
      cmRef.current.startCall(s.callData.ru,s.callData.callType);
    prevCS.current=s.callState;
  },[s.callState]);

  function initServices(user){
    /* PeerManager */
    const pm=new PeerManager(user.uid,
      (fromUid,msg)=>{
        if(msg.type==='message')       d({t:'ADD_MSG',id:msg.chatId,msg:msg.msg});
        else if(['fs','fch','fe'].includes(msg.type)) teRef.current?.onMsg(fromUid,msg);
        else if(msg.type==='_bin')     teRef.current?.onBin(fromUid,msg.data);
      },
      uid=>console.log('[P2P] open',uid),
      uid=>console.log('[P2P] close',uid)
    );
    pmRef.current=pm;
    /* TransferEngine */
    teRef.current=new TransferEngine(pm,
      (tid,prog)=>d({t:'XFER',id:tid,data:prog}),
      (tid,dir,meta)=>{
        d({t:'XFER',id:tid,data:{pct:100,status:'done',...meta}});
        if(dir==='recv'&&meta?.url){const a=document.createElement('a');a.href=meta.url;a.download=meta.name||'file';a.click();}
      },
      tid=>d({t:'XFER',id:tid,data:{status:'error',pct:0}})
    );
    /* CallManager */
    cmRef.current=new CallManager(user.uid,ev=>{
      if(ev.type==='state'){
        d({t:'CALL',state:ev.state,data:ev.ru?{...s.callData,ru:ev.ru,callType:ev.callType,ruName:ev.ruName}:undefined});
        if(ev.ls)d({t:'CALL_LS',v:ev.ls});
      }else if(ev.type==='rs'){d({t:'CALL_RS',v:ev.stream});}
      else if(ev.type==='tick'){d({t:'CALL_DUR',v:ev.dur});}
      else if(ev.type==='error'){console.error('[Call]',ev.err);d({t:'CALL',state:null});}
    });
    /* Presence */
    const pres=new Presence(user.uid);
    pres.start();presRef.current=pres;
    /* WebRTC signaling */
    const oR=window.fRTDB.ref(`signaling/${user.uid}/offers`);
    const oA=window.fRTDB.ref(`signaling/${user.uid}/answers`);
    const oC=window.fRTDB.ref(`signaling/${user.uid}/candidates`);
    oR.on('child_added',async snap=>{const v=snap.val();if(v){await pm.handleOffer(v.from,v.sdp);snap.ref.remove();}});
    oA.on('child_added',async snap=>{const v=snap.val();if(v){await pm.handleAnswer(v.from,v.sdp);snap.ref.remove();}});
    oC.on('child_added',async snap=>{const v=snap.val();if(v){await pm.handleCandidate(v.from,v.candidate);snap.ref.remove();}});
    /* Call signaling */
    const cO=window.fRTDB.ref(`calls/${user.uid}/offer`);
    const cE=window.fRTDB.ref(`calls/${user.uid}/end`);
    cO.on('value',snap=>{const v=snap.val();if(v?.sdp)d({t:'CALL',state:'incoming',data:{ru:v.from,callId:v.callId,callType:v.callType,sdp:v.sdp,ruName:'Incoming call'}});});
    cE.on('value',snap=>{if(snap.val()){d({t:'CALL',state:null});d({t:'CALL_LS',v:null});d({t:'CALL_RS',v:null});snap.ref.remove();}});
    sigRefs.current=[()=>oR.off(),()=>oA.off(),()=>oC.off(),()=>cO.off(),()=>cE.off()];
  }

  function loadFriends(uid){
    window.fDB.collection('users').doc(uid).collection('friends').onSnapshot(snap=>{
      const friends=snap.docs.map(dc=>({uid:dc.id,...dc.data()}));
      d({t:'FRIENDS',v:friends});
      friends.forEach(f=>window.fRTDB.ref(`presence/${f.uid}`).on('value',snap=>{if(snap.val())d({t:'PRES',uid:f.uid,data:snap.val()});}));
    });
  }

  function loadRequests(uid){
    // Listen for pending requests directed TO this user
    // This fires immediately if online, and when app opens if offline
    window.fDB.collection('friendRequests')
      .where('to','==',uid)
      .where('status','==','pending')
      .onSnapshot(
        snap=>d({t:'INCOMING',v:snap.docs.map(dc=>({id:dc.id,...dc.data()}))}),
        err=>console.error('Friend requests listener error:', err)
      );
    // Outgoing
    window.fDB.collection('friendRequests')
      .where('from','==',uid)
      .where('status','==','pending')
      .onSnapshot(
        snap=>d({t:'OUTGOING',v:snap.docs.map(dc=>({id:dc.id,...dc.data()}))}),
        err=>console.error('Outgoing requests error:', err)
      );
  }

  function loadUnreads(uid){
    window.fRTDB.ref(`unread/${uid}`).on('value',snap=>{
      d({t:'UNREADS',v:snap.val()||{}});
    });
  }

  function cleanup(){
    sigRefs.current.forEach(fn=>fn());
    presRef.current?.stop();
    pmRef.current?.closeAll();
  }

  /* ── Render ── */
  if(!s.authReady) return (
    <div className="loading-screen">
      <div className="loading-logo"><Ic n="msg" sz={32} style={{color:'#fff'}}/></div>
      <div className="spinner"/>
      <div style={{fontSize:13,color:'rgba(124,58,237,.5)'}}>Loading MaSu Peer…</div>
    </div>
  );
  if(!s.user) return <AuthScreen/>;

  const openChat = async friend => {
    const uid=s.user.uid,fid=friend.uid;
    const cid=sortedChatId(uid,fid);
    const chatData={id:cid,type:'direct',members:[uid,fid],memberProfiles:{[uid]:{name:s.user.displayName,photoURL:s.user.photoURL||null,shortId:s.userProfile?.shortId||''},[fid]:{name:friend.name,photoURL:friend.photoURL||null,shortId:friend.shortId||''}},otherUid:fid,otherName:friend.name,otherPhoto:friend.photoURL||null,otherShortId:friend.shortId||''};
    const ref=window.fDB.collection('chats').doc(cid);
    if(!(await ref.get()).exists)await ref.set({...chatData,lastMessage:null,lastMessageTime:window.fTS(),createdAt:window.fTS(),updatedAt:window.fTS()});
    window.fRTDB.ref(`unread/${uid}/${cid}`).remove();
    d({t:'CLEAR_UNREAD',chatId:cid});
    d({t:'ACTIVE_CHAT',id:cid,chat:chatData});
    if(pmRef.current&&!pmRef.current.connected(fid))pmRef.current.connect(fid).catch(()=>{});
  };

  return (
    <div style={{height:'100vh',overflow:'hidden',background:'#080518'}}>
      {s.view==='home' && <HomeScreen s={s} d={d} pmRef={pmRef}/>}
      {s.view==='chat' && <ChatScreen s={s} d={d} pmRef={pmRef} teRef={teRef} presRef={presRef}/>}
      {s.menuOpen     && <SlideMenu s={s} d={d} onOpenChat={openChat}/>}
      <CallOverlay s={s} d={d} cmRef={cmRef}/>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
