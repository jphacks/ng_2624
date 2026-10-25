/* Same-origin BE only. Authentication cookies are HTTP-only; CSRF stays in memory. */
(() => {
 let csrf=null;
 async function request(path, method='GET', body) {
  const headers={Accept:'application/json'};
  if(method!=='GET'&&csrf) headers['X-CSRF-Token']=csrf;
  if(body!==undefined) headers['Content-Type']='application/json';
  let res,payload;
  for(let attempt=0;;attempt++){
   const retry=method==='GET'&&attempt<2;
   try { res=await fetch('/api'+path,{method,headers,credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(150000),...(body===undefined?{}:{body:JSON.stringify(body)})}); }
   catch {
    if(retry){await new Promise(resolve=>setTimeout(resolve,(attempt+1)*1000));continue;}
    throw new Error('通信結果を確認できません。最新の状態を読み込み、保存結果を確認してください。保存操作は自動では再送しません。');
   }
   try { payload=await res.json(); }
   catch {
    if(retry&&(res.ok||[502,503,504].includes(res.status))){await new Promise(resolve=>setTimeout(resolve,(attempt+1)*1000));continue;}
    throw new Error('サーバーの応答を確認できません。少し待ってから、もう一度読み込んでください。');
   }
   break;
  }
  if(!res.ok) { const e=new Error(payload?.error?.message||'処理に失敗しました。');e.code=payload?.error?.code;e.status=res.status;throw e; }
  if(!payload||typeof payload!=='object') throw new Error('サーバーの応答形式が正しくありません。');
  if(!Object.hasOwn(payload,'data')) throw new Error('サーバーの応答形式が正しくありません。');
  if(Object.hasOwn(payload.data||{},'csrfToken')) csrf=payload.data.csrfToken;
  return payload.data;
 }
 window.API={request,clear:()=>{csrf=null;}};
})();
