import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDemo, readDemoConfig } from '../../demo/app.ts';
import { parseAIInput } from '../ai/validation.ts';
import type { AIInput, AIOutput } from '../../Sample_db/types.ts';

test('explicit consultation, No-triggered shared negotiation, private drafts, and same-version agreement',async t=>{
 const config=readDemoConfig({DEMO_PORT:'3991',GEMINI_API_KEY:'test'});
 const inputs:AIInput[]=[];
 const demo=await createDemo(config,{ai:async raw=>{
  const input=parseAIInput(raw);inputs.push(input);
  if(input.mode==='negotiation'){assert.equal(input.profile,null);assert.deepEqual(input.history,[]);assert(!JSON.stringify(input).includes('個別の秘密'));}
  if(input.message===null){
   return {requestId:input.requestId,action:input.mode==='negotiation'?'NEGOTIATION':'PROPOSAL',reply:'下書きを作成しました。内容を確認して送信してください。',search:null,
    proposalDraft:{productId:input.selectedProductId!,target:input.role==='parent'?'child':'parent',persuasionText:input.mode==='negotiation'?'送信前の自分だけの修正下書き':'商品を目標にしたいです',purchaseConditions:['大切に使う'],basedOn:input.currentProposal?{proposalId:input.currentProposal.id,version:input.currentProposal.version}:null}} as AIOutput;
  }
  if(input.message.includes('商品を探す'))return {requestId:input.requestId,action:'PRODUCT',reply:'候補です',search:null,products:[{id:randomUUID(),name:'候補商品',priceJpy:1000,size:'small',productUrl:'https://www.amazon.co.jp/dp/B000000000',sourceUrls:['https://www.amazon.co.jp/dp/B000000000'],priceCheckedAt:new Date().toISOString(),description:'商品の説明',recommendationReason:'用途に合います'}]};
  return {requestId:input.requestId,action:'HEARING',reply:'条件を整理します。',search:null};
 },enrich:async p=>p,image:async()=>null,qr:async()=>''});
 function browser(){
  const jar=new Map<string,string>();let csrf='',control='';
  return {async call(path:string,method='GET',body?:unknown){
   const response=await demo.app(new Request(config.origin+'/api'+path,{method,headers:{origin:config.origin,cookie:[...jar].map(([k,v])=>k+'='+v).join('; '),'x-csrf-token':path.startsWith('/demo/')?control:csrf,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));
   for(const c of response.headers.getSetCookie()){const [key,value]=c.split(';')[0].split('=');if(value)jar.set(key,value);else jar.delete(key);}
   const payload=await response.json();if(path==='/demo/state')control=payload.data?.csrfToken;if(path==='/auth/session')csrf=payload.data?.csrfToken;
   return {status:response.status,...payload};
  }};
 }
 const child=browser(),parent=browser();
 async function login(b:ReturnType<typeof browser>,role:string){await b.call('/demo/state');assert.equal((await b.call('/demo/login','POST',{role})).status,200);return (await b.call('/auth/session')).data.user;}
 async function okay(b:ReturnType<typeof browser>,path:string,method='GET',body?:unknown){const r=await b.call(path,method,body);assert(r.status<300,JSON.stringify(r));return r.data;}
 try {
  const childUser=await login(child,'child');await login(parent,'parent');
  let c:any,p:any,nId='',repair:any;
  await t.test('unstarted threads reject both API and database writes without calling AI',async()=>{
   c=await okay(child,'/conversations','POST',{});assert.equal(c.phase,'not_started');assert.equal(c.canMessage,false);
   for(const suffix of ['messages','search','proposal-drafts','selected-product'])assert.equal((await child.call('/conversations/'+c.conversationId+'/'+suffix,'POST',{message:'やあ',query:'商品'})).status,409);
   await assert.rejects(demo.db.rpc('wb_begin_ai',{p_actor_id:childUser.id,p_conversation_id:c.conversationId,p_lock_id:randomUUID()}),/phase/);
   assert.equal(inputs.length,0);assert.equal((await parent.call('/conversations/'+c.conversationId)).status,404);
   c=await okay(child,'/conversations/'+c.conversationId+'/start','POST',{});assert.equal(c.phase,'consultation');
  });
  await t.test('send ends individual consultation and awaits a response, without opening shared chat',async()=>{
   await okay(child,'/conversations/'+c.conversationId+'/messages','POST',{message:'個別の秘密です'});
   c=await okay(child,'/conversations/'+c.conversationId+'/messages','POST',{message:'商品を探す'});
   await okay(child,'/conversations/'+c.conversationId+'/selected-product','PATCH',{selectedProductId:c.products[0].id});
   c=await okay(child,'/conversations/'+c.conversationId+'/proposal-drafts','POST',{});p=c.currentProposal;
   const sent=await okay(child,'/proposals/'+p.id+'/send','POST',{version:p.version});nId=sent.negotiationId;
   assert.equal((await okay(child,'/conversations/'+c.conversationId)).phase,'awaiting_response');
   assert.equal((await child.call('/conversations/'+c.conversationId+'/messages','POST',{message:'送れない'})).status,409);
   assert.equal((await parent.call('/negotiations/'+nId+'/messages','POST',{message:'まだ交渉前'})).status,409);
   assert.equal((await okay(parent,'/negotiations')).negotiations.length,0);
  });
  await t.test('No starts shared negotiation and only shared messages enter AI history',async()=>{
   await okay(parent,'/proposals/'+p.id+'/responses','POST',{version:p.version,decision:'revision_requested',reason:'使う時間の条件を相談したい'});
   assert.equal((await okay(child,'/conversations/'+c.conversationId)).phase,'negotiation');
   const n=await okay(parent,'/negotiations/'+nId);assert.equal(n.phase,'negotiation');assert.equal(n.messages.length,0);
   const response=await okay(parent,'/negotiations/'+nId+'/messages','POST',{message:'使う時間を決めたいです'});assert.equal(response.messages[0].sender,'parent');
   const visible=await okay(child,'/negotiations/'+nId);assert.equal(visible.messages.length,2);assert(!JSON.stringify(visible).includes('個別の秘密'));
   await okay(child,'/negotiations/'+nId+'/messages','POST',{message:'わかったよ'});
   const input=inputs.at(-1)!;assert.equal(input.negotiationHistory[0].sender,'parent');assert.equal(input.negotiationHistory[1].sender,'assistant');
  });
  await t.test('revision remains a private author draft until explicit send',async()=>{
   const n=await okay(parent,'/negotiations/'+nId+'/proposal-drafts','POST',{});repair=n.draftProposal;assert(repair);assert.equal(repair.version,p.version+1);
   const other=await okay(child,'/negotiations/'+nId);assert.equal(other.draftProposal,null);assert(!JSON.stringify(other).includes('送信前の自分だけの修正下書き'));
   assert.equal((await child.call('/proposals/'+repair.id)).status,404);
   const lock=randomUUID();await demo.db.rpc('wb_begin_negotiation_ai',{p_actor_id:childUser.id,p_negotiation_id:nId,p_lock_id:lock});
   await assert.rejects(demo.db.rpc('wb_begin_negotiation_ai',{p_actor_id:childUser.id,p_negotiation_id:nId,p_lock_id:randomUUID()}),/busy/);
   assert.equal((await parent.call('/proposals/'+repair.id+'/send','POST',{version:repair.version})).status,409);
   assert.equal((await okay(parent,'/proposals/'+repair.id)).proposal.status,'draft');
   await demo.db.rpc('wb_cancel_negotiation_ai',{p_actor_id:childUser.id,p_negotiation_id:nId,p_lock_id:lock});
   await okay(parent,'/proposals/'+repair.id+'/send','POST',{version:repair.version});
   assert.equal((await okay(child,'/negotiations/'+nId)).phase,'awaiting_response');
   assert.equal((await parent.call('/negotiations/'+nId+'/messages','POST',{message:'返事待ちには送れない'})).status,409);
   assert.equal((await child.call('/proposals/'+repair.id+'/responses','POST',{version:p.version,decision:'approved'})).status,409);
  });
  await t.test('both approvals of the same revision create one goal and close both chats',async()=>{
   await okay(child,'/proposals/'+repair.id+'/responses','POST',{version:repair.version,decision:'approved'});
   await okay(child,'/proposals/'+repair.id+'/responses','POST',{version:repair.version,decision:'approved'});
   const n=await okay(parent,'/negotiations/'+nId);assert.equal(n.phase,'closed');assert.equal(n.canMessage,false);
   assert.equal((await okay(child,'/conversations/'+c.conversationId)).phase,'closed');
   for(const suffix of ['messages','proposal-drafts','selected-product'])assert.equal((await parent.call('/negotiations/'+nId+'/'+suffix,suffix==='selected-product'?'PATCH':'POST',{message:'終了後',selectedProductId:c.products[0].id})).status,409);
   await assert.rejects(demo.db.rpc('wb_begin_negotiation_ai',{p_actor_id:childUser.id,p_negotiation_id:nId,p_lock_id:randomUUID()}),/phase/);
   assert.equal((await okay(child,'/dashboard')).goals.length,1);
  });
 } finally {await demo.close();}
});
