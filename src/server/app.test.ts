import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.ts';
import { createProductPreview } from './preview.ts';
import { ConversationError } from '../ai/errors.ts';
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
 insert into public.child_settings(child_id,parent_id,constraints) values('${child}','${parent}','{"mustHave":[],"mustAvoid":[]}');
 insert into public.app_sessions(token_hash,user_id,csrf_token,expires_at,reauthenticated_at) values('${hash(tokenParent)}','${parent}','csrf',now()+interval '7 days',now()),('${hash(tokenChild)}','${child}','csrf',now()+interval '30 days',null),('${hash(tokenStranger)}','${stranger}','csrf',now()+interval '7 days',now());
 set role service_role;`);
 await db.update('child_settings',{child_id:'eq.'+child},{chore_preferences:['皿洗い']});
 await db.update('users',{id:'eq.'+child},{grade_level:4,grade_base_school_year:new Date().getFullYear()-(new Date().getMonth()<3?1:0)});
 let mode='product', aiCalls=0;
 const app=createApp(config,{db,ai:async input=>{parseAIInput(input);aiCalls++;assert.equal(input.mode,'consultation');assert.deepEqual(input.negotiationHistory,[]);assert.deepEqual(input.sharedConditions,[]);assert(input.profile);assert.deepEqual(input.profile.preferences.expectations,[]);assert.equal(input.profile.gradeLevel,input.role==='child'?4:null);assert(!JSON.stringify(input.history).includes('親の秘密'));
  return mode==='product'?{requestId:input.requestId,action:'PRODUCT',reply:'候補です',search:null,products:[{id:id(30),name:'商品',priceJpy:95,productUrl:'https://www.amazon.co.jp/dp/B000000000',priceCheckedAt:new Date().toISOString(),size:'small',description:'説明',recommendationReason:'候補',sourceUrls:['https://www.amazon.co.jp/dp/B000000000']}]}:{requestId:input.requestId,action:'PROPOSAL',reply:'下書きです',search:null,proposalDraft:{productId:id(30),target:'parent',persuasionText:'大切に使います',purchaseConditions:['お手伝いをする'],basedOn:input.currentProposal?{proposalId:input.currentProposal.id,version:input.currentProposal.version}:null}};
 },enrich:async p=>({...p,imageUrl:'/api/products/'+p.id+'/image'}),image:async()=>null,qr:async()=> 'data:image/png;base64,test'});
 async function call(path:string,method='GET',body?:unknown,role='child',csrf='csrf',origin=config.origin){const tok=role==='parent'?tokenParent:role==='stranger'?tokenStranger:tokenChild;const r=await app(new Request(config.origin+'/api'+path,{method,headers:{cookie:'wb_local_session='+tok,origin,'x-csrf-token':csrf,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));return {status:r.status,...await r.json()};}
 await t.test('CSRF, role and family gates run before protected mutations',async()=>{
  assert.equal((await call('/children/'+child+'/invitations','POST',{})).status,403);
  assert.equal((await call('/auth/logout','POST',{})).status,403);
  assert.equal((await call('/devices/'+hash(tokenParent),'DELETE')).status,403);
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
  const pc={data:(await db.insert('conversations',{user_id:parent,child_id:child}))[0]};
  await pg.query('insert into public.messages(conversation_id,sender,content) values($1,\'user\',\'親の秘密\')',[pc.data.id]);
  const c=await call('/conversations','POST',{});assert.equal(c.status,201);conversation=c.data.conversationId;
  assert.equal((await call('/conversations/'+conversation,'GET',undefined,'parent')).status,404);
  assert.equal((await call('/conversations/'+conversation+'/start','POST',{})).status,200);
  const r=await call('/conversations/'+conversation+'/messages','POST',{message:'商品がほしい',role:'parent',history:[{content:'other'}]});assert.equal(r.status,200);assert.deepEqual(r.data.messages.map((x:any)=>x.sender),['user','assistant']);assert.equal(aiCalls,1);
  assert.equal((await call('/conversations/'+conversation+'/selected-product','PATCH',{selectedProductId:id(30)})).status,200);
  mode='draft';const d=await call('/conversations/'+conversation+'/proposal-drafts','POST',{});assert.equal(d.status,200);assert.equal(d.data.currentProposal,null);const confirmed=await call('/conversations/'+conversation+'/confirm-reason','POST',{reasonSummary:d.data.reasonSummary});assert.equal(confirmed.status,200,JSON.stringify(confirmed));proposal=confirmed.data.currentProposal.id;
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
  const c=await call('/conversations','POST',{proposalId:proposal},'parent');assert.equal(c.status,403);assert.equal(c.error.code,'FORBIDDEN');
 });
 await t.test('予算の保存列と設定レスポンスを廃止し購入条件だけを保存する',async()=>{
  const columns=await pg.query(`select table_name,column_name from information_schema.columns where table_schema='public' and ((table_name='child_settings' and column_name='reward_guidelines') or (table_name='user_preferences' and column_name in ('budget_small','budget_medium','budget_large')))`);
  assert.equal(columns.rows.length,0);
  const settings=await call('/children/'+child+'/settings','GET',undefined,'parent');
  assert.equal('rewardGuidelines' in settings.data,false);
  const saved=await call('/children/'+child+'/settings','PATCH',{constraints:{mustHave:['丈夫'],mustAvoid:[]}},'parent');
  assert.equal(saved.status,200);assert.deepEqual(saved.data.constraints,{mustHave:['丈夫'],mustAvoid:[]});
 });
 await t.test('invalid child settings fail before creating an auth account',async()=>{
  const result=await call('/children','POST',{displayName:'新しい子',birthDate:'2018-04-01',chorePreferences:'invalid'},'parent');
  assert.equal(result.status,400);assert.equal(result.error.code,'INVALID_INPUT');
 });
 await t.test('child registration reports partial settings failure without inviting duplicate registration',async()=>{
  const newChild=id(99);
  await pg.exec(`reset role; insert into auth.users(id) values('${newChild}'); set role service_role;`);
  const partialDB={...db,auth:async()=>({id:newChild}),insert:async(...args:Parameters<typeof db.insert>)=>{if(args[0]==='child_settings')throw Error('temporary settings failure');return db.insert(...args);}};
  const partialApp=createApp(config,{db:partialDB,ai:async()=>{throw Error('unused');},enrich:async p=>p,image:async()=>null,qr:async()=>''});
  const response=await partialApp(new Request(config.origin+'/api/children',{method:'POST',headers:{cookie:'wb_local_session='+tokenParent,origin:config.origin,'x-csrf-token':'csrf','content-type':'application/json'},body:JSON.stringify({displayName:'新しい子',birthDate:'2018-04-01',chorePreferences:['皿洗い']})}));
  const payload=await response.json();const data=payload.data;assert.equal(response.status,201,JSON.stringify(payload));assert.equal(data.childId,newChild);assert.equal(data.settingsSaved,false);
  assert.equal((await db.list('users',{id:'eq.'+newChild})).length,1);
  const recovered=await call('/children/'+newChild+'/settings','PATCH',{chorePreferences:['皿洗い']},'parent');assert.equal(recovered.status,200);
 });
 await t.test('explicit search endpoint carries a query and target child context without private child preferences',async()=>{
  let captured:any;
  const searchApp=createApp(config,{db,ai:async input=>{captured=parseAIInput(input);return {requestId:input.requestId,action:'HEARING',reply:'候補がありません',search:null};},enrich:async p=>p,image:async()=>null,qr:async()=>''});
  const c=await call('/conversations','POST',{});
  await call('/conversations/'+c.data.conversationId+'/start','POST',{});
  const response=await searchApp(new Request(config.origin+'/api/conversations/'+c.data.conversationId+'/search',{method:'POST',headers:{cookie:'wb_local_session='+tokenChild,origin:config.origin,'x-csrf-token':'csrf','Content-Type':'application/json'},body:JSON.stringify({query:'Switch スプラトゥーン'})}));
  assert.equal(response.status,200);assert.equal(captured.role,'child');assert.equal(captured.searchQuery,'Switch スプラトゥーン');assert.equal(captured.childContext.gradeLevel,4);assert.ok(captured.childContext.age===captured.profile.age);
  const fromChat=await searchApp(new Request(config.origin+'/api/conversations/'+c.data.conversationId+'/search',{method:'POST',headers:{cookie:'wb_local_session='+tokenChild,origin:config.origin,'x-csrf-token':'csrf','Content-Type':'application/json'},body:JSON.stringify({fromConversation:true})}));
  assert.equal(fromChat.status,200);assert.equal(captured.searchQuery,undefined);
  assert.match(captured.message,/これまでの相談内容/);
  assert.ok(captured.history.some((m:any)=>m.sender==='user'&&m.content.includes('Switch スプラトゥーン')));
 });
 await t.test('画像と価格が取れない検索候補は保存・表示・選択しない',async()=>{
  const preview=createProductPreview({resolve:async()=>[{address:'93.184.216.34',family:4}],read:async url=>{if(url.hostname==='vertexaisearch.cloud.google.com')return {status:302,headers:{location:'https://www.amazon.co.jp/dp/B00000000'+url.pathname.slice(-1)},body:Buffer.alloc(0)};throw Error('image unavailable');}});
  const searchApp=createApp(config,{db,ai:async input=>({requestId:input.requestId,action:'PRODUCT',reply:'ゲームの候補です',search:null,
   products:([ 'small','medium','large' ] as const).map((size,i)=>({id:id(200+i),size,name:`ゲーム${i+1}`,priceJpy:null,priceCheckedAt:null,
    productUrl:`https://vertexaisearch.cloud.google.com/grounding-api-redirect/game-${i}`,sourceUrls:[`https://vertexaisearch.cloud.google.com/grounding-api-redirect/game-${i}`],description:'検索で確認した候補',recommendationReason:'候補です'}))}),
   enrich:preview.prepareProduct,image:async()=>null,qr:async()=>''});
  const c=await call('/conversations','POST',{});
  await call('/conversations/'+c.data.conversationId+'/start','POST',{});
  const response=await searchApp(new Request(config.origin+'/api/conversations/'+c.data.conversationId+'/search',{method:'POST',headers:{cookie:'wb_local_session='+tokenChild,origin:config.origin,'x-csrf-token':'csrf','Content-Type':'application/json'},body:JSON.stringify({query:'ゲーム'})}));
  const payload=await response.json();assert.equal(response.status,200,JSON.stringify(payload));
  assert.equal(payload.data.products.length,0);assert.equal(payload.data.latestAIOutput.action,'HEARING');
  const saved=await call('/conversations/'+c.data.conversationId);assert.equal(saved.data.products.length,0);
  assert.ok(saved.data.products.every((p:any)=>p.imageUrl===null&&p.productUrl.startsWith('https://www.amazon.co.jp/dp/')));
 });
 await t.test('saved candidates recover verified prices and images before proposal generation; failed candidates remain',async()=>{
  const candidates=Array.from({length:3},(_,i)=>({id:id(230+i),name:`復元商品${i}`,priceJpy:null,priceCheckedAt:null,imageUrl:null,size:'small' as const,productUrl:`https://www.amazon.co.jp/dp/B00000023${i}`,description:'',recommendationReason:'',sourceUrls:[]}));
  const c=await call('/conversations','POST',{}),cid=c.data.conversationId;
  await call('/conversations/'+cid+'/start','POST',{});
  let enrichCalls=0;
  const recoveryApp=createApp(config,{db,ai:async input=>{
   if(input.selectedProductId){assert.equal(input.products.find(p=>p.id===id(230))?.priceJpy,4980);return {requestId:input.requestId,action:'PROPOSAL',reply:'下書きです',search:null,proposalDraft:{productId:id(230),target:'parent',persuasionText:'大切に使います',purchaseConditions:[],basedOn:null}};}
   return {requestId:input.requestId,action:'PRODUCT',reply:'候補です',search:null,products:candidates};
  },enrich:async p=>{enrichCalls++;if(p.id!==id(230))throw Error('unavailable');return {...p,priceJpy:4980,priceCheckedAt:new Date().toISOString(),imageUrl:'https://m.media-amazon.com/images/I/recovered.jpg'};},image:async()=>null,qr:async()=>''});
  async function request(path:string,method='GET',body?:unknown){const response=await recoveryApp(new Request(config.origin+'/api'+path,{method,headers:{cookie:'wb_local_session='+tokenChild,origin:config.origin,'x-csrf-token':'csrf','content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));return {status:response.status,...await response.json()};}
  // Seed legacy metadata with no price or image, as saved by older deployments.
  await db.update('conversations',{id:'eq.'+cid},{products:candidates});
  for(const p of candidates)await db.insert('products',{id:p.id,name:p.name,price_jpy:null,price_checked_at:null,image_url:null,product_url:p.productUrl,size:p.size,source_urls:[]});
  const initial=await request('/conversations/'+cid);assert.equal(initial.status,200);assert.equal(initial.data.products.length,3);
  await new Promise(resolve=>setImmediate(resolve));const restored=await request('/conversations/'+cid);
  assert.equal(restored.data.products[0].priceJpy,4980);assert.match(restored.data.products[0].imageUrl,/recovered/);assert.equal(restored.data.products[1].priceJpy,null);
  const count=enrichCalls;await request('/conversations/'+cid);assert.equal(enrichCalls,count);
  assert.equal((await db.list('products',{id:'eq.'+id(230)}))[0].price_jpy,4980);
  assert.equal((await request('/conversations/'+cid+'/selected-product','PATCH',{selectedProductId:id(230)})).status,200);
  const draft=await request('/conversations/'+cid+'/proposal-drafts','POST',{});assert.equal(draft.status,200,JSON.stringify(draft));assert.equal(draft.data.currentProposal,null);const confirmed=await request('/conversations/'+cid+'/confirm-reason','POST',{reasonSummary:draft.data.reasonSummary});assert.equal(confirmed.data.currentProposal.productId,id(230));
 });
 await t.test('旧候補のURL不整合を補正し、理由確認と保護者への送信まで進める',async()=>{
  const productId=id(270),canonical='https://www.amazon.co.jp/dp/B000000270';
  const c=await call('/conversations','POST',{}),cid=c.data.conversationId;
  await call('/conversations/'+cid+'/start','POST',{});
  const product={id:productId,name:'ゲーム本体',size:'small',priceJpy:2000,priceCheckedAt:new Date().toISOString(),productUrl:canonical,imageUrl:'/api/products/'+productId+'/image',description:'ゲーム本体',recommendationReason:'希望の商品',sourceUrls:['https://vertexaisearch.cloud.google.com/grounding-api-redirect/legacy']};
  await db.insert('products',{id:productId,name:product.name,size:product.size,price_jpy:2000,price_checked_at:product.priceCheckedAt,product_url:canonical,image_url:product.imageUrl,description:product.description,recommendation_reason:product.recommendationReason,source_urls:product.sourceUrls});
  await db.update('conversations',{id:'eq.'+cid},{products:[product],selected_product_id:productId});
  let generated=0;
  const fixed=createApp(config,{db,ai:async raw=>{const input=parseAIInput(raw);generated++;assert(input.products[0].sourceUrls.includes(canonical));return {requestId:input.requestId,action:'PROPOSAL',reply:'この理由で合ってる？',search:null,proposalDraft:{productId,target:'parent',persuasionText:'楽しそうだから',purchaseConditions:[],basedOn:null}};},enrich:async p=>p,image:async()=>null,qr:async()=>''});
  const request=async(path:string,body:unknown)=>{const r=await fixed(new Request(config.origin+'/api'+path,{method:'POST',headers:{cookie:'wb_local_session='+tokenChild,origin:config.origin,'x-csrf-token':'csrf','content-type':'application/json'},body:JSON.stringify(body)}));const result=await r.json();assert.equal(r.status,200,JSON.stringify(result));return result.data;};
  const reason=await request('/conversations/'+cid+'/messages',{message:'楽しそうだから'});assert.equal(reason.reasonSummary,'楽しそうだから');assert.equal(generated,1);
  const written=await request('/conversations/'+cid+'/reason',{reason:'ただ 楽しそう！'});assert.equal(written.reasonSummary,'ただ 楽しそう！');assert.equal(generated,1,'自由記述ではAIを呼ばない');
  const confirmed=await request('/conversations/'+cid+'/confirm-reason',{reasonSummary:written.reasonSummary});const draft=confirmed.currentProposal;
  await request('/proposals/'+draft.id+'/send',{version:draft.version});
  const received=await call('/proposals/'+draft.id,'GET',undefined,'parent');assert.equal(received.data.canRespond,true);assert.equal(received.data.proposal.persuasionText,'ただ 楽しそう！');
 });
 await t.test('自動検索の進捗を結果の確定前にストリームで返す',async()=>{
  const c=await call('/conversations','POST',{}),cid=c.data.conversationId;await call('/conversations/'+cid+'/start','POST',{});
  let finish!:()=>void;const waiting=new Promise<void>(resolve=>{finish=resolve;});
  const streaming=createApp(config,{db,ai:async(input,progress)=>{progress?.();await waiting;return {requestId:input.requestId,action:'HEARING',reply:'検索しました',search:null};},enrich:async p=>p,image:async()=>null,qr:async()=>''});
  const response=await streaming(new Request(config.origin+'/api/conversations/'+cid+'/messages',{method:'POST',headers:{cookie:'wb_local_session='+tokenChild,origin:config.origin,'x-csrf-token':'csrf','content-type':'application/json',accept:'application/x-ndjson'},body:JSON.stringify({message:'ゲームを探して'})}));
  const reader=response.body!.getReader();try{
   const first=await reader.read();assert.match(new TextDecoder().decode(first.value),/"progress":"searching"/);finish();
   let result='';while(true){const chunk=await reader.read();if(chunk.done)break;result+=new TextDecoder().decode(chunk.value);}
   assert.equal(JSON.parse(result).data.messages.at(-1).content,'検索しました');
  }finally{finish();reader.releaseLock();}
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
  await db.update('app_sessions',{token_hash:'eq.'+hash(tokenParent)},{reauthenticated_at:null});
  const responsePath='/pairing/requests/'+next.data.pairingRequestId+'/responses';
  const approval={decision:'approved',confirmationCode:next.data.confirmationCode};
  assert.equal((await call(responsePath,'POST',approval)).status,403);
  assert.equal((await call(responsePath,'POST',approval,'parent','wrong')).status,403);
  assert.equal((await call('/auth/google/reauthenticate','POST',{},'parent')).status,404);
  const approved=await call(responsePath,'POST',approval,'parent');assert.equal(approved.status,200);
  const ownJar=jar;jar+='; wb_local_session='+tokenParent;
  const blocked=await pairCall('/pairing/requests/'+next.data.pairingRequestId+'/complete',{});assert.equal(blocked.status,409);assert.equal(blocked.error.code,'ALREADY_AUTHENTICATED');
  jar=ownJar;const complete=await pairCall('/pairing/requests/'+next.data.pairingRequestId+'/complete',{});assert.equal(complete.status,200);assert.equal(complete.data.user.role,'child');
 });
 await t.test('AI quota and timeout errors survive HTTP translation without exposing upstream details',async()=>{
  // Pairing completion above revokes the child's earlier sessions, so restore the fixture session.
  await db.update('app_sessions',{token_hash:'eq.'+hash(tokenChild)},{revoked_at:null});
  const c=await call('/conversations','POST',{});assert.equal(c.status,201);const cid=c.data.conversationId;
  assert.equal((await call('/conversations/'+cid+'/start','POST',{})).status,200);
  for(const [failure,status,code,expected] of [
   [new ConversationError('RATE_LIMIT','sensitive-upstream-details'),429,'RATE_LIMITED',/利用上限/],
   [new ConversationError('TIMEOUT','sensitive-upstream-details'),502,'AI_UNAVAILABLE',/時間内/],
   [new Error('sensitive-upstream-details'),502,'AI_UNAVAILABLE',/返答を取得できません/],
  ] as const){
   const failing=createApp(config,{db,ai:async()=>{throw failure;},enrich:async p=>p,image:async()=>null,qr:async()=>''});
   const response=await failing(new Request(config.origin+'/api/conversations/'+cid+'/search',{method:'POST',headers:{cookie:'wb_local_session='+tokenChild,origin:config.origin,'x-csrf-token':'csrf','Content-Type':'application/json'},body:JSON.stringify({query:'工作キット'})}));
   const payload=await response.json();
   assert.equal(response.status,status);assert.equal(payload.error.code,code);assert.match(payload.error.message,expected);
   assert.ok(!JSON.stringify(payload).includes('sensitive-upstream-details'));
   if(status===429)assert.equal(response.headers.get('Retry-After'),'60');
   const stored=(await db.list('conversations',{id:'eq.'+cid}))[0];assert.equal(stored.ai_lock_id,null);
  }
 });
 await t.test('invitation creation needs parent, family and CSRF checks but no recent reauthentication',async()=>{
  const path='/children/'+child+'/invitations';
  for(const reauthenticatedAt of [new Date(Date.now()-11*60000).toISOString(),null]){
   await db.update('app_sessions',{token_hash:'eq.'+hash(tokenParent)},{reauthenticated_at:reauthenticatedAt});
   assert.equal((await call(path,'POST',{},'stranger')).status,403);
   assert.equal((await call(path,'POST',{},'parent','wrong')).status,403);
   const invitation=await call(path,'POST',{},'parent');
   assert.equal(invitation.status,201);assert.equal(invitation.data.childId,child);
   assert.match(invitation.data.invitationToken,/^[A-Z2-9]{12}$/);
   assert.equal(invitation.data.pairingUrl,config.origin+'/pairing#invitationToken='+invitation.data.invitationToken);
   assert.match(invitation.data.qrDataUrl,/^data:image\/png;base64,/);
  }
 });
 await t.test('device revocation needs parent, family and CSRF checks but no recent reauthentication',async()=>{
  await db.update('app_sessions',{token_hash:'eq.'+hash(tokenParent)},{reauthenticated_at:new Date(Date.now()-11*60000).toISOString()});
  const target=(await db.list('app_sessions',{user_id:'eq.'+child,revoked_at:'is.null'}))[0];
  assert.ok(target);
  const path='/devices/'+target.token_hash;
  assert.equal((await call(path,'DELETE',undefined,'stranger')).status,403);
  assert.equal((await call(path,'DELETE',undefined,'parent','wrong')).status,403);
  assert.equal((await db.list('app_sessions',{token_hash:'eq.'+target.token_hash}))[0].revoked_at,null);
  const revoked=await call(path,'DELETE',undefined,'parent');
  assert.equal(revoked.status,200);assert.equal(revoked.data.revoked,true);assert.equal(revoked.data.currentDeviceRevoked,false);
  assert.ok((await db.list('app_sessions',{token_hash:'eq.'+target.token_hash}))[0].revoked_at);
 });
 await t.test('history reset requires a parent, CSRF and explicit confirmation',async()=>{
  await db.update('app_sessions',{token_hash:'eq.'+hash(tokenChild)},{revoked_at:null});
  assert.equal((await call('/history','DELETE',{confirmation:'DELETE_ALL_HISTORY'})).status,403);
  assert.equal((await call('/history','DELETE',{},'parent')).status,400);
  assert.equal((await call('/history','DELETE',{confirmation:'DELETE_ALL_HISTORY'},'parent','wrong')).status,403);
  const cleared=await call('/history','DELETE',{confirmation:'DELETE_ALL_HISTORY'},'parent');assert.equal(cleared.status,200,JSON.stringify(cleared));assert.equal(cleared.data.cleared,true);
  assert.equal((await call('/auth/session','GET',undefined,'parent')).data.authenticated,true);
  const dash=await call('/dashboard');assert.equal(dash.data.balanceYen,0);assert.deepEqual(dash.data.proposals,[]);assert.deepEqual(dash.data.chores,[]);
 });
 await t.test('parent can log out without reauthentication',async()=>{
  await db.update('app_sessions',{token_hash:'eq.'+hash(tokenParent)},{reauthenticated_at:null});
  const loggedOut=await call('/auth/logout','POST',{},'parent');
  assert.equal(loggedOut.status,200);assert.equal(loggedOut.data.loggedOut,true);
  assert.equal((await call('/auth/session','GET',undefined,'parent')).data.authenticated,false);
 });
 } finally {await pg.close();}
});
