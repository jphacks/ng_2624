/* Same-origin BE only. Authentication cookies are HTTP-only; CSRF stays in memory. */
(() => {
 let csrf=null;
 async function request(path, method='GET', body) {
  const headers={Accept:'application/json'};
  if(method!=='GET'&&csrf) headers['X-CSRF-Token']=csrf;
  if(body!==undefined) headers['Content-Type']='application/json';
  let res;
  try { res=await fetch('/api'+path,{method,headers,credentials:'same-origin',cache:'no-store',redirect:'error',...(body===undefined?{}:{body:JSON.stringify(body)})}); }
  catch { throw new Error('通信結果を確認できません。最新の状態を読み込み、保存結果を確認してください。自動では再送しません。'); }
  let payload;
  try { payload=await res.json(); } catch { throw new Error('サーバーの応答を確認できません。'); }
  if(!res.ok) { const e=new Error(payload.error?.message||'処理に失敗しました。');e.code=payload.error?.code;e.status=res.status;throw e; }
  if(!Object.hasOwn(payload,'data')) throw new Error('サーバーの応答形式が正しくありません。');
  if(Object.hasOwn(payload.data||{},'csrfToken')) csrf=payload.data.csrfToken;
  return payload.data;
 }
 window.API={request,clear:()=>{csrf=null;}};
})();
