/* Same-origin BE only. Authentication cookies are HTTP-only; CSRF stays in memory. */
(() => {
 let csrf=null;
 async function request(path, method='GET', body, onProgress) {
  const headers={Accept:onProgress?'application/x-ndjson':'application/json'};
  if(method!=='GET'&&csrf) headers['X-CSRF-Token']=csrf;
  if(body!==undefined) headers['Content-Type']='application/json';
  let res,payload;
  for(let attempt=0;;attempt++){
   const retry=method==='GET'&&attempt<2;
   try { res=await fetch('/api'+path,{method,headers,credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(method==='GET'?15000:150000),...(body===undefined?{}:{body:JSON.stringify(body)})}); }
   catch {
    if(retry){await new Promise(resolve=>setTimeout(resolve,(attempt+1)*1000));continue;}
    throw new Error('通信結果を確認できません。最新の状態を読み込み、保存結果を確認してください。保存操作は自動では再送しません。');
   }
   try {
    if(res.ok&&res.headers.get('content-type')?.includes('application/x-ndjson')){
     const reader=res.body.getReader(),decoder=new TextDecoder();let pending='';payload=null;
     const consume=line=>{if(!line.trim())return;const event=JSON.parse(line);if(event.progress)onProgress?.(event.progress);else if(Object.hasOwn(event,'data')||event.error)payload=event;};
     try{while(true){const {value,done}=await reader.read();if(done)break;pending+=decoder.decode(value,{stream:true});let end;while((end=pending.indexOf('\n'))>=0){consume(pending.slice(0,end));pending=pending.slice(end+1);}}pending+=decoder.decode();consume(pending);}finally{reader.releaseLock();}
    }else payload=await res.json();
   }
   catch {
    if(retry&&(res.ok||[502,503,504].includes(res.status))){await new Promise(resolve=>setTimeout(resolve,(attempt+1)*1000));continue;}
    throw new Error('サーバーの応答を確認できません。少し待ってから、もう一度読み込んでください。');
   }
   break;
  }
  if(!res.ok||payload?.error) { const e=new Error(payload?.error?.message||'処理に失敗しました。');e.code=payload?.error?.code;e.status=payload?.error?.status||res.status;throw e; }
  if(!payload||typeof payload!=='object') throw new Error('サーバーの応答形式が正しくありません。');
  if(!Object.hasOwn(payload,'data')) throw new Error('サーバーの応答形式が正しくありません。');
  if(Object.hasOwn(payload.data||{},'csrfToken')) csrf=payload.data.csrfToken;
  return payload.data;
 }
 window.API={request,clear:()=>{csrf=null;}};
})();
