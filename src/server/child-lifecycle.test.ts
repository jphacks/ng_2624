import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase } from './test-support.ts';
import { createApp } from './app.ts';
import { hash } from './core.ts';
import type { Config } from './core.ts';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

test('expired pairing remains established; explicit child deletion preserves siblings and parent',async()=>{
 const {pg,db}=await testDatabase();
 const parent=id(1),child=id(2),sibling=id(3),stranger=id(4),pending=id(5),family=id(10),otherFamily=id(11),chat=id(20),siblingChat=id(21),product=id(30),siblingProduct=id(31),task=id(40),assignment=id(41),siblingAssignment=id(42),submission=id(43),siblingSubmission=id(44),review=id(45),siblingReview=id(46),negotiation=id(50),proposal=id(51);
 const config:Config={origin:'http://localhost:3000',port:3000,supabaseUrl:'https://test.supabase.co',serviceKey:'test',publishableKey:'test',sessionSecret:'a'.repeat(64),geminiKey:''};
 try{
  await pg.exec(`insert into auth.users(id) values('${parent}'),('${child}'),('${sibling}'),('${stranger}'),('${pending}');
  insert into users(id,display_name,role,onboarding_completed) values('${parent}','親','parent',true),('${child}','期限切れの子','child',true),('${sibling}','きょうだい','child',true),('${stranger}','別家族の親','parent',true),('${pending}','未完了','child',false);
  insert into families(id,name,created_by) values('${family}','家族','${parent}'),('${otherFamily}','別家族','${stranger}');
  insert into family_members(family_id,user_id,family_role) values('${family}','${parent}','parent'),('${family}','${child}','child'),('${family}','${sibling}','child'),('${family}','${pending}','child'),('${otherFamily}','${stranger}','parent');
  insert into child_settings(child_id,parent_id) values('${child}','${parent}');
  insert into user_preferences(user_id,interests) values('${child}',array['工作']),('${sibling}',array['読書']);
  insert into products(id,name,price_jpy,product_url) values('${product}','子の商品',100,'https://example.com/a'),('${siblingProduct}','きょうだいの商品',200,'https://example.com/b');
  insert into conversations(id,user_id,child_id,selected_product_id,products,started_at) values('${chat}','${child}','${child}','${product}','[{"id":"${product}"}]',now()),('${siblingChat}','${sibling}','${sibling}','${siblingProduct}','[{"id":"${siblingProduct}"}]',now());
  insert into messages(conversation_id,sender,content) values('${chat}','user','消す会話'),('${siblingChat}','user','残す会話');
  insert into negotiations(id,family_id,child_id,parent_id,status) values('${negotiation}','${family}','${child}','${parent}','awaiting_approval');
  insert into proposals(id,conversation_id,negotiation_id,product_id,proposed_by,version,persuasion_text,status,goal_size,agreed_amount_yen) values('${proposal}','${chat}','${negotiation}','${product}','${child}',1,'理由','pending','small',100);
  update proposals set status='agreed' where id='${proposal}';
  insert into tasks(id,family_id,title,category,difficulty,reward_amount_yen,created_by) values('${task}','${family}','共有のお手伝い','chore',1,100,'${parent}');
  insert into task_assignments(id,task_id,child_id) values('${assignment}','${task}','${child}'),('${siblingAssignment}','${task}','${sibling}');
  insert into task_submissions(id,assignment_id,child_id) values('${submission}','${assignment}','${child}'),('${siblingSubmission}','${siblingAssignment}','${sibling}');
  insert into task_reviews(id,submission_id,reviewer_id,decision) values('${review}','${submission}','${parent}','approved'),('${siblingReview}','${siblingSubmission}','${parent}','approved');
  insert into amount_transactions(child_id,delta_amount_yen,reason,task_review_id) values('${child}',100,'子のポイント','${review}'),('${sibling}',200,'きょうだいのポイント','${siblingReview}');`);
  for(const [token,user,expired] of [['p',parent,false],['c',child,true],['s',sibling,false],['o',stranger,false]] as const)await db.insert('app_sessions',{token_hash:hash(token.repeat(43)),user_id:user,csrf_token:'csrf',expires_at:new Date(Date.now()+(expired?-86400000:86400000)).toISOString()});
  const app=createApp(config,{db,ai:async()=>{throw Error('AI must not be called');},enrich:async p=>p,image:async()=>null,qr:async()=>''});
  async function call(path:string,method='GET',body?:unknown,token='p',csrf='csrf'){
   const res=await app(new Request(config.origin+'/api'+path,{method,headers:{cookie:'wb_local_session='+token.repeat(43),origin:config.origin,'x-csrf-token':csrf,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));return {status:res.status,...await res.json()};
  }
  const list=(await call('/children')).data.children;
  assert.equal(list.find((c:any)=>c.childId===child).hasCompletedPairing,true);assert.equal(list.find((c:any)=>c.childId===child).hasLinkedDevice,false);
  assert.equal(list.find((c:any)=>c.childId===pending).hasCompletedPairing,false);
  assert.equal((await db.list('users',{id:'eq.'+child})).length,1);
  const path='/children/'+child,confirmation={confirmation:'DELETE_CHILD'};
  assert.equal((await call(path,'DELETE',confirmation,'s')).status,403);
  assert.equal((await call(path,'DELETE',confirmation,'o')).status,403);
  assert.equal((await call(path,'DELETE',{},'p')).status,400);
  assert.equal((await call(path,'DELETE',confirmation,'p','wrong')).status,403);
  await db.update('conversations',{id:'eq.'+chat},{ai_lock_id:id(60),ai_lock_expires_at:new Date(Date.now()+60000).toISOString()});
  assert.equal((await call(path,'DELETE',confirmation)).status,409);assert.equal((await db.list('amount_transactions',{child_id:'eq.'+child})).length,1);
  await db.update('conversations',{id:'eq.'+chat},{ai_lock_id:null,ai_lock_expires_at:null});
  const deleted=await call(path,'DELETE',confirmation);assert.equal(deleted.status,200,JSON.stringify(deleted));assert.equal(deleted.data.deleted,true);
  assert.equal((await pg.query('select id from auth.users where id=$1',[child])).rows.length,0);
  for(const table of ['users','app_sessions','user_preferences'])assert.equal((await db.list(table,{[table==='users'?'id':'user_id']:'eq.'+child})).length,0,table);
  assert.equal((await db.list('conversations',{child_id:'eq.'+child})).length,0);assert.equal((await db.list('proposals')).length,0);assert.equal((await db.list('goals')).length,0);assert.equal((await db.list('amount_transactions',{child_id:'eq.'+child})).length,0);
  assert.equal((await db.list('products',{id:'eq.'+product})).length,0);
  assert.equal((await db.list('messages',{conversation_id:'eq.'+siblingChat}))[0].content,'残す会話');
  assert.equal((await db.list('task_assignments',{id:'eq.'+siblingAssignment})).length,1);assert.equal((await db.list('tasks',{id:'eq.'+task})).length,1);
  assert.equal((await db.list('amount_transactions',{child_id:'eq.'+sibling}))[0].delta_amount_yen,200);
  assert.equal((await call('/auth/session')).data.authenticated,true);
  const removed=await call('/children/'+pending,'DELETE',confirmation);assert.equal(removed.status,200,JSON.stringify(removed));
 }finally{await pg.close();}
});
