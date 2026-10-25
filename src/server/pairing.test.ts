import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemo, readDemoConfig } from '../../demo/app.ts';

test('pairing polling does not exhaust completion quota or overwrite authenticated CSRF',async()=>{
 const config=readDemoConfig({DEMO_PORT:'3992'});
 const demo=await createDemo(config,{ai:async()=>{throw Error('AI must not be called');},enrich:async p=>p,image:async()=>null,qr:async()=>''});
 function browser(){
  const cookies=new Map<string,string>();let csrf='',control='';
  return {async call(path:string,method='GET',body?:unknown){
   const res=await demo.app(new Request(config.origin+'/api'+path,{method,headers:{cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),origin:config.origin,'content-type':'application/json','x-csrf-token':path.startsWith('/demo/')?control:csrf},...(body===undefined?{}:{body:JSON.stringify(body)})}));
   for(const c of res.headers.getSetCookie()){const [key,value]=c.split(';')[0].split('=');if(value)cookies.set(key,value);else cookies.delete(key);}
   const payload=await res.json();if(path==='/demo/state')control=payload.data?.csrfToken;else if(payload.data?.csrfToken)csrf=payload.data.csrfToken;
   return {status:res.status,...payload};
  }};
 }
 const parent=browser(),child=browser();
 try{
  await parent.call('/demo/state');await parent.call('/demo/login','POST',{role:'parent'});await parent.call('/auth/session');
  const childId=(await parent.call('/children')).data.children[0].childId;
  const invitation=await parent.call('/children/'+childId+'/invitations','POST',{});assert.equal(invitation.status,201);
  const token=invitation.data.invitationToken;
  assert.equal((await child.call('/pairing/session','POST',{invitationToken:token})).status,201);
  const request=await child.call('/pairing/requests','POST',{invitationToken:token});assert.equal(request.status,200);
  const path='/pairing/requests/'+request.data.pairingRequestId;
  // More than the old shared quota of 30; use no timers or external services.
  for(let n=0;n<40;n++){
   const status=await child.call(path);assert.equal(status.status,200,JSON.stringify(status));assert.equal(Object.hasOwn(status.data,'csrfToken'),false);
  }
  const approved=await parent.call(path+'/responses','POST',{decision:'approved',confirmationCode:request.data.confirmationCode});assert.equal(approved.status,200);
  assert.equal((await child.call(path)).data.status,'approved');
  const completed=await child.call(path+'/complete','POST',{});assert.equal(completed.status,200,JSON.stringify(completed));assert.equal(completed.data.user.role,'child');
  assert.equal((await child.call('/auth/session')).data.authenticated,true);
  // An authenticated mutation verifies the CSRF token after the final status response.
  const saved=await child.call('/profile','PATCH',{profile:{preferences:{interests:['工作']}}});assert.equal(saved.status,200,JSON.stringify(saved));
 }finally{await demo.close();}
});
