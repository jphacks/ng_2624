import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.ts';
import { hash, seal, unseal, equal, createDB } from './core.ts';
import type { Config } from './core.ts';
import { parseAIInput } from '../ai/validation.ts';
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
 const app=createApp(config,{db,ai:async input=>{parseAIInput(input);aiCalls++;assert.equal(input.mode,'consultation');assert.deepEqual(input.negotiationHistory,[]);assert.deepEqual(input.sharedConditions,[]);assert(input.profile);assert.deepEqual(input.profile.preferences.expectations,[]);assert.equal(input.profile.gradeLevel,input.role==='child'?4:null);assert(!JSON.stringify(input.history).includes('親の秘密'));
  return mode==='product'?{requestId:input.requestId,action:'PRODUCT',reply:'候補です',search:null,products:[{id:id(30),name:'商品',priceJpy:95,productUrl:'https://www.amazon.co.jp/dp/B000000000',priceCheckedAt:new Date().toISOString(),size:'small',description:'説明',recommendationReason:'候補',sourceUrls:['https://www.amazon.co.jp/dp/B000000000']}]}:{requestId:input.requestId,action:'PROPOSAL',reply:'下書きです',search:null,proposalDraft:{productId:id(30),target:'parent',persuasionText:'大切に使います',purchaseConditions:['お手伝いをする'],basedOn:input.currentProposal?{proposalId:input.currentProposal.id,version:input.currentProposal.version}:null}};
 },enrich:async p=>({...p,imageUrl:null}),image:async()=>null,qr:async()=> 'data:image/png;base64,test'});
 async function call(path:string,method='GET',body?:unknown,role='child',csrf='csrf',origin=config.origin){const tok=role==='parent'?tokenParent:role==='stranger'?tokenStranger:tokenChild;const r=await app(new Request(config.origin+'/api'+path,{method,headers:{cookie:'wb_local_session='+tok,origin,'x-csrf-token':csrf,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));return {status:r.status,...await r.json()};}
 await t.test('CSRF, role and family gates run before protected mutations',async()=>{
  assert.equal((await call('/auth/logout','POST',{})).status,403);
  assert.equal((await call('/auth/session')).data.authenticated,true);
  assert.equal((await call('/profile','PATCH',{displayName:'bad'},'parent','wrong')).status,403);
  assert.equal((await call('/profile','PATCH',{displayName:'bad'},'parent','csrf','https://evil.example')).status,403);
  assert.equal((await call('/children','GET')).status,403);
  assert.equal((await call('/demo/state','GET',undefined,'parent')).status,404);
  assert.equal((await call('/demo/login','POST',{role:'child'},'parent')).status,404);
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
  assert.equal((await call('/conversations/'+conversation+'/start','POST',{})).status,200);
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
 await t.test('an agreed proposal cannot create a new private revision conversation',async()=>{
  const c=await call('/conversations','POST',{proposalId:proposal},'parent');assert.equal(c.status,409);assert.equal(c.error.code,'INVALID_STATE');
 });
 await t.test('invalid child settings fail before creating an auth account',async()=>{
  const result=await call('/children','POST',{displayName:'新しい子',birthDate:'2018-04-01',rewardGuidelines:{smallJpy:1000,mediumJpy:100,largeJpy:10000}},'parent');
  assert.equal(result.status,400);assert.match(result.error.message,/小・中・大/);
 });
 await t.test('child registration reports partial settings failure without inviting duplicate registration',async()=>{
  const newChild=id(99);
  await pg.exec(`reset role; insert into auth.users(id) values('${newChild}'); set role service_role;`);
  const partialDB={...db,auth:async()=>({id:newChild}),insert:async(...args:Parameters<typeof db.insert>)=>{if(args[0]==='child_settings')throw Error('temporary settings failure');return db.insert(...args);}};
  const partialApp=createApp(config,{db:partialDB,ai:async()=>{throw Error('unused');},enrich:async p=>p,image:async()=>null,qr:async()=>''});
  const response=await partialApp(new Request(config.origin+'/api/children',{method:'POST',headers:{cookie:'wb_local_session='+tokenParent,origin:config.origin,'x-csrf-token':'csrf','content-type':'application/json'},body:JSON.stringify({displayName:'新しい子',birthDate:'2018-04-01',rewardGuidelines:{smallJpy:100,mediumJpy:1000,largeJpy:10000}})}));
  const payload=await response.json();const data=payload.data;assert.equal(response.status,201,JSON.stringify(payload));assert.equal(data.childId,newChild);assert.equal(data.settingsSaved,false);
  assert.equal((await db.list('users',{id:'eq.'+newChild})).length,1);
  const recovered=await call('/children/'+newChild+'/settings','PATCH',{rewardGuidelines:{smallJpy:100,mediumJpy:1000,largeJpy:10000}},'parent');assert.equal(recovered.status,200);
 });
 await t.test('explicit search endpoint carries a query and target child context without private child preferences',async()=>{
  let captured:any;
  const searchApp=createApp(config,{db,ai:async input=>{captured=parseAIInput(input);return {requestId:input.requestId,action:'HEARING',reply:'候補がありません',search:null};},enrich:async p=>p,image:async()=>null,qr:async()=>''});
  const c=await call('/conversations','POST',{childId:child},'parent');
  await call('/conversations/'+c.data.conversationId+'/start','POST',{},'parent');
  const response=await searchApp(new Request(config.origin+'/api/conversations/'+c.data.conversationId+'/search',{method:'POST',headers:{cookie:'wb_local_session='+tokenParent,origin:config.origin,'x-csrf-token':'csrf','Content-Type':'application/json'},body:JSON.stringify({query:'Switch スプラトゥーン'})}));
  assert.equal(response.status,200);assert.equal(captured.role,'parent');assert.equal(captured.searchQuery,'Switch スプラトゥーン');assert.equal(captured.childContext.gradeLevel,4);assert.ok(captured.childContext.age<captured.profile.age);
 });
 await t.test('pairing can restart with a new invitation in the same browser and cannot replace an authenticated parent',async()=>{
  const first=await call('/children/'+child+'/invitations','POST',{},'parent');assert.equal(first.status,201);
  let jar='',csrf='';
  async function pairCall(path:string,body:unknown){const r=await app(new Request(config.origin+'/api'+path,{method:'POST',headers:{cookie:jar,origin:config.origin,'x-csrf-token':csrf,'content-type':'application/json'},body:JSON.stringify(body)}));const cookie=r.headers.getSetCookie().find(c=>c.startsWith('wb_local_pair='));if(cookie)jar=cookie.split(';')[0];const payload=await r.json();if(payload.data?.csrfToken)csrf=payload.data.csrfToken;return {status:r.status,...payload};}
  await pairCall('/pairing/session',{invitationToken:first.data.invitationToken});
  const request=await pairCall('/pairing/requests',{invitationToken:first.data.invitationToken});assert.equal(request.status,200);
  const firstCookie=jar;
  const second=await call('/children/'+child+'/invitations','POST',{},'parent');
  await pairCall('/pairing/session',{invitationToken:second.data.invitationToken});assert.notEqual(jar,firstCookie);
  const next=await pairCall('/pairing/requests',{invitationToken:second.data.invitationToken});assert.equal(next.status,200);
  assert.equal((await pairCall('/pairing/requests',{invitationToken:second.data.invitationToken})).data.pairingRequestId,next.data.pairingRequestId);
  const approved=await call('/pairing/requests/'+next.data.pairingRequestId+'/responses','POST',{decision:'approved',confirmationCode:next.data.confirmationCode},'parent');assert.equal(approved.status,200);
  const ownJar=jar;jar+='; wb_local_session='+tokenParent;
  const blocked=await pairCall('/pairing/requests/'+next.data.pairingRequestId+'/complete',{});assert.equal(blocked.status,409);assert.equal(blocked.error.code,'ALREADY_AUTHENTICATED');
  jar=ownJar;const complete=await pairCall('/pairing/requests/'+next.data.pairingRequestId+'/complete',{});assert.equal(complete.status,200);assert.equal(complete.data.user.role,'child');
 });
 await t.test('parent can log out even when sensitive actions require reauthentication',async()=>{
  await db.update('app_sessions',{token_hash:'eq.'+hash(tokenParent)},{reauthenticated_at:new Date(Date.now()-11*60000).toISOString()});
  const blocked=await call('/devices/'+hash(tokenChild),'DELETE',undefined,'parent');
  assert.equal(blocked.status,403);assert.equal(blocked.error.code,'REAUTH_REQUIRED');
  const loggedOut=await call('/auth/logout','POST',{},'parent');
  assert.equal(loggedOut.status,200);assert.equal(loggedOut.data.loggedOut,true);
  assert.equal((await call('/auth/session','GET',undefined,'parent')).data.authenticated,false);
 });
 } finally {await pg.close();}
});
