import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require = createRequire(resolve(process.cwd(), 'package.json'));
const { PGlite } = require('@electric-sql/pglite');

test('database migrations, private proposals, chores, purchases and pairing', async (t) => {
 const db = new PGlite();
 try {
 await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
 create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
 create table auth.identities(user_id uuid,provider text);
 create function auth.uid() returns uuid language sql as 'select null::uuid';`);
 for (const file of (await readdir('supabase/migrations')).filter(x=>x.endsWith('.sql')).sort()) {
  const sql=(await readFile(`supabase/migrations/${file}`,'utf8')).replace('create extension if not exists pgcrypto;','');
  try {await db.exec(sql);} catch(error) {throw new Error(`Migration ${file}: ${error}`,{cause:error});}
 }
 const rpc=async(name:string,args:unknown[])=> (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args)).rows[0].result;
 const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 const parent=id(1),child=id(2),stranger=id(3),family=id(10),otherFamily=id(11),conv=id(20),product=id(30);
 await db.exec(`insert into auth.users(id) values('${parent}'),('${child}'),('${stranger}');
 insert into public.users(id,display_name,role) values('${parent}','親','parent'),('${child}','子','child'),('${stranger}','別家族','parent');
 insert into public.families(id,name,created_by) values('${family}','家族','${parent}'),('${otherFamily}','別家族','${stranger}');
 insert into public.family_members values('${family}','${parent}','parent',now()),('${family}','${child}','child',now()),('${otherFamily}','${stranger}','parent',now());
 insert into public.products(id,name,price_jpy,product_url) values('${product}','本',95,'https://example.com/book');
 insert into public.conversations(id,user_id,child_id,selected_product_id,started_at) values('${conv}','${child}','${child}','${product}',now());`);
 await t.test('child registration is atomic, idempotent and family scoped',async()=>{
  const newChild=id(4); await db.exec(`insert into auth.users(id) values('${newChild}')`);
  const first=await rpc('wb_create_child',[parent,newChild,'次の子','2017-01-01','unspecified',4,2026]);
  const again=await rpc('wb_create_child',[parent,newChild,'次の子','2017-01-01','unspecified',4,2026]);
  assert.equal(first.user.id,again.user.id); assert.equal(first.family_id,family);
  await assert.rejects(rpc('wb_create_child',[stranger,newChild,'次の子','2017-01-01','unspecified',4,2026]),/elsewhere/);
 });
 await t.test('RPC privileges reject browser callers',async()=>{
  const rows=(await db.query(`select proname,has_function_privilege('authenticated',p.oid,'EXECUTE') as can_call from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname like 'wb_%'`)).rows;
  assert.ok(rows.length>10); assert.ok(rows.every((x:any)=>!x.can_call));
 });
 await t.test('chores reject cross-family and wrong role, credit only once, ten yen terms',async()=>{
  await assert.rejects(rpc('wb_create_chore',[stranger,child,'掃除','',100,null]),/Family access/);
  await assert.rejects(rpc('wb_create_chore',[parent,child,'掃除','',105,null]),/multiple of 10/);
  const req=await rpc('wb_create_chore',[child,child,'掃除','',100,null]);
  await assert.rejects(rpc('wb_review_chore_request',[child,req.id,'approved',100,null]),/Parent required/);
  const approved=await rpc('wb_review_chore_request',[parent,req.id,'approved',100,null]);
  const repeat=await rpc('wb_review_chore_request',[parent,req.id,'approved',100,null]); assert.equal(approved.assignment_id,repeat.assignment_id);
  await rpc('wb_submit_chore',[child,approved.assignment_id,'できた']);
  await assert.rejects(rpc('wb_review_chore',[stranger,approved.assignment_id,'approved','']),/Family access/);
  await rpc('wb_review_chore',[parent,approved.assignment_id,'approved','']);
  await rpc('wb_review_chore',[parent,approved.assignment_id,'approved','']);
  assert.equal((await db.query('select sum(delta_amount_yen)::integer as total from amount_transactions')).rows[0].total,100);
 });
 let proposal:any;
 await t.test('private draft then explicit send, stale version and both-role same-version agreement',async()=>{
  proposal=await rpc('wb_save_proposal',[child,conv,product,'本がほしい',[], 'small']);
  assert.equal(proposal.negotiation_id,null);
  await assert.rejects(rpc('wb_send_proposal',[child,proposal.id,99,parent]),/Stale/);
  await rpc('wb_send_proposal',[child,proposal.id,proposal.version,parent]);
  assert.equal((await db.query('select count(*)::integer as count from goals')).rows[0].count,0);
  await assert.rejects(rpc('wb_review_proposal',[stranger,proposal.id,proposal.version,'approved',null]),/access denied/);
  const agreed=await rpc('wb_review_proposal',[parent,proposal.id,proposal.version,'approved',null]); assert.equal(agreed.status,'agreed');
  await rpc('wb_review_proposal',[parent,proposal.id,proposal.version,'approved',null]);
  assert.equal((await db.query('select count(*)::integer as count from goals')).rows[0].count,1);
 });
 await t.test('purchase exact target including non-ten-yen price, no duplicate debit',async()=>{
  const goal=(await db.query('select * from goals')).rows[0];
  await assert.rejects(rpc('wb_purchase_goal',[child,goal.id]),/Parent required/);
  await rpc('wb_purchase_goal',[parent,goal.id]); await rpc('wb_purchase_goal',[parent,goal.id]);
  const row=(await db.query('select sum(delta_amount_yen)::integer as balance,sum(greatest(delta_amount_yen,0))::integer as acquired from amount_transactions')).rows[0];
  assert.deepEqual(row,{balance:5,acquired:100});
 });
 await t.test('child proposal and parent revision keep source conversations private; price snapshot, slot and balance checks',async()=>{
  const parentConv=id(21),revisionConv=id(24);
  await db.exec(`insert into conversations(id,user_id,child_id,selected_product_id,started_at) values('${parentConv}','${child}','${child}','${product}',now());`);
  const parentDraft=await rpc('wb_save_proposal',[child,parentConv,product,'子から提案',[], 'small']);
  await rpc('wb_send_proposal',[child,parentDraft.id,parentDraft.version,parent]);
  await rpc('wb_review_proposal',[parent,parentDraft.id,parentDraft.version,'revision_requested','条件を変えたい']);
  await db.exec(`insert into conversations(id,user_id,child_id,selected_product_id,context_proposal_id) values('${revisionConv}','${parent}','${child}','${product}','${parentDraft.id}')`);
  const revision=await rpc('wb_save_proposal',[parent,revisionConv,product,'親から修正',[], 'small',null,null,parentDraft.id]);
  assert.equal(revision.negotiation_id,null);
  await rpc('wb_send_proposal',[parent,revision.id,revision.version,null]);
  await assert.rejects(rpc('wb_review_proposal',[child,parentDraft.id,parentDraft.version,'rejected',null]),/Already answered|awaiting approval/);
  await db.exec(`update products set price_jpy=999 where id='${product}'`);
  await rpc('wb_review_proposal',[child,revision.id,revision.version,'approved',null]);
  const goal=(await db.query('select * from goals where proposal_id=$1',[revision.id])).rows[0];
  assert.equal(goal.target_amount_yen,95);
  await assert.rejects(rpc('wb_purchase_goal',[parent,goal.id]),/Insufficient balance/);
  const otherConv=id(23);await db.exec(`insert into conversations(id,user_id,child_id,selected_product_id,started_at) values('${otherConv}','${child}','${child}','${product}',now())`);
  const other=await rpc('wb_save_proposal',[child,otherConv,product,'もう一つ',[], 'small']);
  await rpc('wb_send_proposal',[child,other.id,other.version,parent]);
  await assert.rejects(rpc('wb_review_proposal',[parent,other.id,other.version,'approved',null]),/active goal/);
  assert.equal((await db.query('select count(*)::integer as count from proposal_approvals where proposal_id=$1',[other.id])).rows[0].count,1);
 });
 await t.test('AI persistence has ownership, lease, atomic failure and exactly-once finish checks',async()=>{
  const aiConv=id(22),lock=id(40),wrong=id(41),candidate=id(31);
  await db.exec(`insert into conversations(id,user_id,child_id,started_at) values('${aiConv}','${child}','${child}',now())`);
  await assert.rejects(rpc('wb_begin_ai',[parent,aiConv,lock]),/access denied/);
  await rpc('wb_begin_ai',[child,aiConv,lock]);
  await assert.rejects(rpc('wb_begin_ai',[child,aiConv,wrong]),/busy/);
  assert.equal(await rpc('wb_cancel_ai',[child,aiConv,wrong]),false);
  const output={action:'PRODUCT',reply:'商品です',search:null,products:[{id:candidate,name:'商品',priceJpy:100,productUrl:'https://example.com/new',imageUrl:null,priceCheckedAt:'2026-10-24T00:00:00Z',size:'medium',description:'説明',recommendationReason:'希望に合う',sourceUrls:[]}]};
  await assert.rejects(rpc('wb_finish_ai',[child,aiConv,wrong,'探して',output]),/mismatched/);
  await rpc('wb_finish_ai',[child,aiConv,lock,'探して',output]);
  await assert.rejects(rpc('wb_finish_ai',[child,aiConv,lock,'探して',output]),/mismatched/);
  assert.equal((await db.query('select count(*)::integer as count from messages where conversation_id=$1',[aiConv])).rows[0].count,2);
  await rpc('wb_select_product',[child,aiConv,candidate]);
  await rpc('wb_begin_ai',[child,aiConv,wrong]);
  await assert.rejects(rpc('wb_select_product',[child,aiConv,candidate]),/busy/);
  await assert.rejects(rpc('wb_finish_ai',[child,aiConv,wrong,'提案して',{action:'PROPOSAL',reply:'提案です',proposalDraft:{productId:product,persuasionText:'欲しい',purchaseConditions:[],basedOn:null}}]),/not in conversation/);
  assert.equal((await db.query('select count(*)::integer as count from messages where conversation_id=$1',[aiConv])).rows[0].count,2);
  const valid={action:'PROPOSAL',reply:'提案です',proposalDraft:{productId:candidate,persuasionText:'欲しい',purchaseConditions:['お手伝い'],basedOn:null}};
  await rpc('wb_finish_ai',[child,aiConv,wrong,'提案して',valid]);
  const draft=(await db.query('select * from proposals where conversation_id=$1',[aiConv])).rows[0];
  await rpc('wb_begin_ai',[child,aiConv,lock]);
  await assert.rejects(rpc('wb_save_proposal',[child,aiConv,candidate,'変更',[],'medium',draft.id,draft.version,null]),/busy/);
  await rpc('wb_finish_ai',[child,aiConv,lock,'直して',{...valid,action:'NEGOTIATION',proposalDraft:{...valid.proposalDraft,basedOn:{proposalId:draft.id,version:draft.version}}}]);
  assert.equal((await db.query('select version from proposals where id=$1',[draft.id])).rows[0].version,draft.version+1);
 });
 await t.test('pairing requires parent code verification and single completion',async()=>{
  await rpc('wb_create_invitation',[parent,child,'invitation-hash']);
  const request=await rpc('wb_request_pairing',['invitation-hash','bootstrap-hash']);
  await assert.rejects(rpc('wb_approve_pairing',[parent,request.id,'wrong']),/mismatch/);
  await assert.rejects(rpc('wb_complete_pairing',[request.id,'bootstrap-hash','session-hash','csrf']),/unavailable/);
  await rpc('wb_approve_pairing',[parent,request.id,request.confirmation_code]);
  await assert.rejects(rpc('wb_complete_pairing',[request.id,'wrong','session-hash','csrf']),/unavailable/);
  const session=await rpc('wb_complete_pairing',[request.id,'bootstrap-hash','session-hash','csrf']); assert.equal(session.user_id,child);
  await assert.rejects(rpc('wb_complete_pairing',[request.id,'bootstrap-hash','session-hash-2','csrf']),/unavailable/);
  await rpc('wb_create_invitation',[parent,child,'invitation-hash-2']);
  const next=await rpc('wb_request_pairing',['invitation-hash-2','bootstrap-hash-2']);
  await rpc('wb_approve_pairing',[parent,next.id,next.confirmation_code]);
  await rpc('wb_complete_pairing',[next.id,'bootstrap-hash-2','session-hash-2','csrf-2']);
  assert.equal((await db.query('select count(*)::integer as count from app_sessions where user_id=$1 and revoked_at is null',[child])).rows[0].count,1);
 });
 } finally {await db.close();}
});
