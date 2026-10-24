import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.ts';
import { hash, seal, unseal, equal, createDB } from './core.ts';
import type { Config } from './core.ts';
import { testDatabase } from './test-support.ts';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const config:Config={origin:'http://localhost:3000',supabaseUrl:'https://test.supabase.co',serviceKey:'secret',publishableKey:'public',sessionSecret:'a'.repeat(64),geminiKey:'test-only',port:3000};
test('encrypted cookies are expiry-bound and tamper evident; Unicode CSRF cannot crash comparison',()=>{
 const c=seal({exp:Date.now()+5000,verifier:'private'},config.sessionSecret);assert.equal(unseal(c,config.sessionSecret)?.verifier,'private');assert.equal(unseal(c.slice(0,-3)+'xxx',config.sessionSecret),null);assert.equal(unseal(seal({exp:1},config.sessionSecret),config.sessionSecret),null);assert.equal(equal('あ','a'),false);
});
test('DB transport uses server credentials only and does not expose upstream errors',async()=>{
 let seen:RequestInit|undefined;
 const db=createDB(config,async(_url,init)=>{seen=init;return new Response(JSON.stringify({code:'XX000',message:'secret database detail'}),{status:500});});
 await assert.rejects(db.list('users'),e=>e instanceof Error&&!e.message.includes('secret database detail'));
 assert.equal(new Headers(seen?.headers).get('apikey'),'secret');
});
test('API integration: real PostgreSQL functions behind private sessions, chores, AI, proposals and purchases',async t=>{
 const {pg,db}=await testDatabase();
 try {
 const parent=id(1),child=id(2),stranger=id(3),family=id(10),tokenParent='p'.repeat(43),tokenChild='c'.repeat(43),tokenStranger='s'.repeat(43);
 await pg.exec(`insert into auth.users(id) values('${parent}'),('${child}'),('${stranger}');
 insert into public.users(id,display_name,role,onboarding_completed,birth_date) values('${parent}','親','parent',true,'1980-01-01'),('${child}','子','child',true,'2017-01-01'),('${stranger}','別の親','parent',true,'1980-01-01');
 insert into public.families(id,name,created_by) values('${family}','家族','${parent}');
 insert into public.family_members(family_id,user_id,family_role) values('${family}','${parent}','parent'),('${family}','${child}','child');
 insert into public.child_settings(child_id,parent_id,reward_guidelines,constraints) values('${child}','${parent}','{"smallJpy":100,"mediumJpy":1000,"largeJpy":10000}','{"mustHave":[],"mustAvoid":[]}');
 insert into public.app_sessions(token_hash,user_id,csrf_token,expires_at,reauthenticated_at) values('${hash(tokenParent)}','${parent}','csrf',now()+interval '7 days',now()),('${hash(tokenChild)}','${child}','csrf',now()+interval '30 days',null),('${hash(tokenStranger)}','${stranger}','csrf',now()+interval '7 days',now());
 set role service_role;`);
 await db.update('child_settings',{child_id:'eq.'+child},{chore_preferences:['皿洗い']});
 await db.update('users',{id:'eq.'+child},{grade_level:4,grade_base_school_year:new Date().getFullYear()-(new Date().getMonth()<3?1:0)});
 let mode='product', aiCalls=0;
 const app=createApp(config,{db,ai:async input=>{aiCalls++;assert.equal(input.mode,'consultation');assert.deepEqual(input.negotiationHistory,[]);assert.deepEqual(input.sharedConditions,[]);assert(input.profile);assert(input.profile.preferences.expectations.includes('皿洗い'));assert.equal(input.profile.gradeLevel,input.role==='child'?4:null);assert(!JSON.stringify(input.history).includes('親の秘密'));
  return mode==='product'?{requestId:input.requestId,action:'PRODUCT',reply:'候補です',search:null,products:[{id:id(30),name:'商品',priceJpy:95,productUrl:'https://www.amazon.co.jp/dp/B000000000',priceCheckedAt:new Date().toISOString(),size:'small',description:'説明',recommendationReason:'候補',sourceUrls:[]}]}:{requestId:input.requestId,action:'PROPOSAL',reply:'下書きです',search:null,proposalDraft:{productId:id(30),target:'parent',persuasionText:'大切に使います',purchaseConditions:['お手伝いをする'],basedOn:input.currentProposal?{proposalId:input.currentProposal.id,version:input.currentProposal.version}:null}};
 },enrich:async p=>({...p,imageUrl:null}),image:async()=>null,qr:async()=> 'data:image/png;base64,test'});
 async function call(path:string,method='GET',body?:unknown,role='child',csrf='csrf',origin=config.origin){const tok=role==='parent'?tokenParent:role==='stranger'?tokenStranger:tokenChild;const r=await app(new Request(config.origin+'/api'+path,{method,headers:{cookie:'wb_local_session='+tok,origin,'x-csrf-token':csrf,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));return {status:r.status,...await r.json()};}
 await t.test('CSRF, role and family gates run before protected mutations',async()=>{
  assert.equal((await call('/profile','PATCH',{displayName:'bad'},'parent','wrong')).status,403);
  assert.equal((await call('/profile','PATCH',{displayName:'bad'},'parent','csrf','https://evil.example')).status,403);
  assert.equal((await call('/children','GET')).status,403);
  assert.equal((await call('/dashboard?childId='+child,'GET',undefined,'stranger')).status,403);
 });
 await t.test('chore proposal and pre-agreed reward survives completion; no duplicate credit',async()=>{
  const proposed=await call('/chore-requests','POST',{title:'皿洗い',note:'やります'});assert.equal(proposed.status,201);
  const accepted=await call('/chore-requests/'+proposed.data.id+'/respond','POST',{decision:'approved',rewardAmountYen:100},'parent');assert.equal(accepted.status,200);
  const assignment=accepted.data.assignment_id;assert.equal((await call('/chores/'+assignment+'/submit','POST',{note:'できた'})).status,200);
  for(let i=0;i<2;i++)assert.equal((await call('/chores/'+assignment+'/review','POST',{decision:'approved'},'parent')).status,200);
  const d=await call('/dashboard');assert.equal(d.data.balanceYen,100);assert.equal(d.data.lifetimeEarnedYen,100);assert.equal(d.data.chores[0].status,'approved');
 });
 let conversation:string,proposal:string;
 await t.test('individual chat output is persisted atomically and hidden from the other parent',async()=>{
  const pc=await call('/conversations','POST',{childId:child},'parent');assert.equal(pc.status,201);
  await pg.query('insert into public.messages(conversation_id,sender,content) values($1,\'user\',\'親の秘密\')',[pc.data.conversationId]);
  const c=await call('/conversations','POST',{});assert.equal(c.status,201);conversation=c.data.conversationId;
  assert.equal((await call('/conversations/'+conversation,'GET',undefined,'parent')).status,404);
  const r=await call('/conversations/'+conversation+'/messages','POST',{message:'商品がほしい',role:'parent',history:[{content:'other'}]});assert.equal(r.status,200);assert.deepEqual(r.data.messages.map((x:any)=>x.sender),['user','assistant']);assert.equal(aiCalls,1);
  assert.equal((await call('/conversations/'+conversation+'/selected-product','PATCH',{selectedProductId:id(30)})).status,200);
  mode='draft';const d=await call('/conversations/'+conversation+'/proposal-drafts','POST',{});assert.equal(d.status,200);proposal=d.data.currentProposal.id;
  assert.equal((await call('/proposals/'+proposal,'GET',undefined,'parent')).status,404);
 });
 await t.test('only explicit proposal is sent, both parties agree, purchase debits once, earned total stays',async()=>{
  const sent=await call('/proposals/'+proposal+'/send','POST',{version:1});assert.equal(sent.status,200);
  const seen=await call('/proposals/'+proposal,'GET',undefined,'parent');assert.equal(seen.status,200);assert.equal(seen.data.canRespond,true);assert.equal(seen.data.messages,undefined);
  assert.equal((await call('/proposals/'+proposal+'/responses','POST',{version:1,decision:'approved',reason:null},'parent')).status,200);
  const dash=await call('/dashboard');const goal=dash.data.goals[0];assert.equal(goal.targetAmountYen,95);
  assert.equal((await call('/goals/'+goal.id+'/purchase','POST',{})).status,403);
  for(let i=0;i<2;i++)assert.equal((await call('/goals/'+goal.id+'/purchase','POST',{},'parent')).status,200);
  const after=await call('/dashboard');assert.equal(after.data.balanceYen,5);assert.equal(after.data.lifetimeEarnedYen,100);assert.equal(after.data.goals.length,0);
 });
 await t.test('consulting a received proposal opens only the current user private conversation',async()=>{
  const c=await call('/conversations','POST',{proposalId:proposal},'parent');assert.equal(c.status,201);assert.equal(c.data.messages.length,0);assert.equal(c.data.currentProposal.id,proposal);assert.equal((await call('/conversations/'+c.data.conversationId)).status,404);
 });
 } finally {await pg.close();}
});
