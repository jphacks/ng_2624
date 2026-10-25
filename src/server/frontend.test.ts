import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// Execute the shipped script with a small DOM boundary. No application-only test hooks.
const source=await readFile(new URL('../../frontend/app.js',import.meta.url),'utf8');
async function frontend(request:(path:string,method?:string,body?:any)=>Promise<any>,confirm=(_message:string)=>true){
 const nodes:any=Object.fromEntries(['#content','#notice','#navigation','#demo-tools','#role-label'].map(id=>[id,{innerHTML:'',textContent:'',setAttribute(){},insertAdjacentHTML(){}}]));
 const classes=new Set<string>();
 nodes['#content'].classList={add:(...names:string[])=>names.forEach(name=>classes.add(name)),remove:(...names:string[])=>names.forEach(name=>classes.delete(name)),contains:(name:string)=>classes.has(name)};
 const location={hash:'#home',search:'',pathname:'/'};
 const events:any={};const window:any={scrollX:0,scrollY:0,scrollTo(position:any){window.scrollX=position.left;window.scrollY=position.top;},addEventListener:(name:string,fn:any)=>{events[name]=fn;}};
 const context=vm.createContext({window,document:{querySelector:(id:string)=>nodes[id],addEventListener:(name:string,fn:any)=>{events[name]=fn;}},location,
 history:{pushState:(_:unknown,__:string,hash:string)=>{location.hash=hash;},replaceState:(_:unknown,__:string,hash:string)=>{location.hash=hash;}},
 sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},API:{request,clear(){}},URL,URLSearchParams,console,confirm});
 vm.runInContext(source.replace(/\}\)\(\);\s*$/, 'window.testing={state,run,go,action,submit,chat};})();'),context);
 await new Promise(resolve=>setImmediate(resolve));
 return {...window.testing,nodes,events,location,window};
}
const session={authenticated:true,user:{role:'parent',displayName:'保護者',onboardingCompleted:true}};
const dashboard={childId:'child',children:[],goals:[],chores:[],choreRequests:[],proposals:[]};
const basic=async(path:string)=>path==='/auth/session'?session:path.startsWith('/dashboard')?dashboard:{children:[]};

test('a slow conversation response cannot overwrite a newer destination',async()=>{
 let finish:any;const pending=new Promise(resolve=>{finish=resolve;});
 const ui=await frontend(async path=>path==='/conversations/slow'?pending:basic(path));
 const old=ui.run(()=>ui.chat('slow'));
 await ui.go('#children');
 finish({conversationId:'slow',messages:[{sender:'assistant',content:'古い応答'}],products:[]});
 await old;
 assert.match(ui.nodes['#content'].innerHTML,/子ども一覧/);
 assert.doesNotMatch(ui.nodes['#content'].innerHTML,/古い応答/);
 assert.equal(ui.state.busy,false);
});

test('request failure restores only the initiating controls and retains input',async()=>{
 const ui=await frontend(basic);const control={disabled:false,value:'保存したい入力'};
 const form={matches:()=>true,querySelectorAll:()=>[control]};
 await ui.run(async()=>{assert.equal(control.disabled,true);throw Error('通信エラー');},form);
 assert.equal(control.disabled,false);assert.equal(control.value,'保存したい入力');
 assert.match(ui.nodes['#notice'].textContent,/通信エラー/);
});

test('unsaved proposal edits prevent sending',async()=>{
 const sent:string[]=[];
 const ui=await frontend(async(path,method)=>{if(method==='POST')sent.push(path);return basic(path);});
 ui.state.dirty=true;ui.state.proposal={proposal:{version:1}};
 await assert.rejects(ui.action('send-proposal','proposal'),/未保存/);
 assert.equal(sent.length,0);
});

test('a hearing response during proposal generation remains in chat even with an old draft',async()=>{
 const conversation={conversationId:'chat',mode:'consultation',phase:'consultation',canMessage:true,messages:[],products:[],currentProposal:{id:'old'},latestAIOutput:{action:'HEARING',reply:'条件を確認してください'}};
 const ui=await frontend(async path=>path.startsWith('/conversations/chat')?conversation:basic(path));
 ui.state.chat=conversation;ui.location.hash='#conversation/chat';
 await ui.action('generate-proposal');
 assert.equal(ui.location.hash,'#conversation/chat');
 assert.match(ui.nodes['#notice'].textContent,/条件を確認/);
});

test('invalid goal amounts prevent child registration before sending a request',async()=>{
 const sent:string[]=[];const ui=await frontend(async(path,method)=>{if(method==='POST')sent.push(path);return basic(path);});
 await assert.rejects(ui.submit('create-child','',{displayName:'子',smallJpy:'1000',mediumJpy:'100',largeJpy:'10000'}),/小・中・大/);
 assert.equal(sent.length,0);
});

test('parent and child receive different chat introduction and settings links',async()=>{
 const childSession={...session,user:{...session.user,role:'child'}};
 const ui=await frontend(async path=>path==='/auth/session'?childSession:path==='/conversations/chat'?{messages:[],products:[]}:basic(path));
 await ui.chat('chat');assert.match(ui.nodes['#content'].innerHTML,/ぽぽだよ/);
 assert.match(ui.nodes['#navigation'].innerHTML,/じぶんの設定/);assert.doesNotMatch(ui.nodes['#navigation'].innerHTML,/子ども一覧/);
 ui.state.session=session;await ui.chat('chat');assert.match(ui.nodes['#content'].innerHTML,/お子さんの目標/);assert.doesNotMatch(ui.nodes['#content'].innerHTML,/ぽぽだよ/);
});


test('a successful mutation after navigation reports completion without replacing the new screen',async()=>{
 let finish:any;const pending=new Promise(resolve=>{finish=resolve;});
 const ui=await frontend(async(path,method)=>method==='POST'?pending:basic(path));
 ui.state.childId='child';
 const saving=ui.run(()=>ui.submit('create-chore','',{title:'掃除',description:'',rewardAmountYen:'100',dueAt:''}));
 await ui.go('#children');finish({});await saving;
 assert.match(ui.nodes['#content'].innerHTML,/子ども一覧/);
 assert.match(ui.nodes['#notice'].textContent,/前の画面の操作が完了/);
});


test('composer follows server phase and introduction stays before all conversation messages',async()=>{
 const thread:any={conversationId:'chat',mode:'consultation',phase:'not_started',canMessage:false,messages:[{sender:'assistant',content:'以前の返答'}],products:[]};
 const starts:string[]=[];
 const ui=await frontend(async path=>{
  if(path==='/conversations/chat/start'){starts.push(path);thread.phase='consultation';thread.canMessage=true;return thread;}
  return path==='/conversations/chat'?thread:basic(path);
 });
 await ui.chat('chat');let html=ui.nodes['#content'].innerHTML;
 assert.match(html,/data-form="message"/);assert.equal(starts.length,1);
 assert.ok(html.indexOf('ぽぽです。')<html.indexOf('以前の返答'));assert.match(html,/message-avatar/);
 await ui.chat('chat');assert.match(ui.nodes['#content'].innerHTML,/data-form="message"/);assert.equal(starts.length,1);
 for(const phase of ['awaiting_response','closed']){thread.phase=phase;thread.canMessage=false;await ui.chat('chat');assert.doesNotMatch(ui.nodes['#content'].innerHTML,/data-form="message"|data-form="search-products"/);}
});

test('shared chat uses negotiation endpoints and exposes only the active shared composer',async()=>{
 const thread:any={mode:'negotiation',negotiationId:'shared',phase:'negotiation',canMessage:true,messages:[{sender:'parent',own:false,content:'共有された条件'}],products:[],currentProposal:{id:'proposal'}};
 const calls:string[]=[];
 const ui=await frontend(async path=>{if(path.startsWith('/negotiations/shared')){calls.push(path);return thread;}return basic(path);});
 ui.state.chat=thread;
 await ui.submit('message','',{message:'条件に賛成します'});
 assert.equal(calls[0],'/negotiations/shared/messages');
 assert.match(ui.nodes['#content'].innerHTML,/親子に公開するメッセージ/);assert.match(ui.nodes['#content'].innerHTML,/共有交渉中/);
 assert.doesNotMatch(ui.nodes['#content'].innerHTML,/data-form="search-products"/);
 thread.phase='closed';thread.canMessage=false;
 await ui.submit('message','',{message:'テスト応答の再表示'});
 assert.doesNotMatch(ui.nodes['#content'].innerHTML,/data-form="message"/);
});


test('logout is available only in parent settings and child actions cannot call it',async()=>{
 const sent:string[]=[];
 const ui=await frontend(async(path,method)=>{
  if(method==='POST')sent.push(path);
  if(path==='/profile')return {displayName:'子',profile:{preferences:{}}};
  if(path==='/devices')return {devices:[{deviceSessionId:'current',deviceLabel:'保護者の端末',isCurrent:true}]};
  if(path==='/pairing/requests')return {requests:[]};
  return path==='/auth/session'?{...session,user:{...session.user,role:'child'}}:basic(path);
 });
 await ui.go('#settings');
 assert.doesNotMatch(ui.nodes['#navigation'].innerHTML,/ログアウト/);
 assert.doesNotMatch(ui.nodes['#content'].innerHTML,/ログアウト/);
 assert.match(ui.nodes['#content'].innerHTML,/data-form="child-profile"/);
 await assert.rejects(ui.action('logout'),/保護者の設定/);
 assert.deepEqual(sent,[]);
 ui.state.session=session;await ui.go('#settings');
 assert.doesNotMatch(ui.nodes['#navigation'].innerHTML,/ログアウト/);
 assert.match(ui.nodes['#content'].innerHTML,/data-action="logout"/);
});

test('parent entry stays in the child list and child details have their own route',async()=>{
 const calls:string[]=[];
 const ui=await frontend(async path=>{
  calls.push(path);
  if(path==='/children')return {children:[{childId:'child',displayName:'りょ子'}]};
  if(path.startsWith('/dashboard'))return {...dashboard,children:[{childId:'child',displayName:'りょ子'}]};
  return basic(path);
 });
 assert.match(ui.nodes['#content'].innerHTML,/子ども一覧/);
 assert.match(ui.nodes['#content'].innerHTML,/目標・お手伝いを確認/);
 assert.match(ui.nodes['#navigation'].innerHTML,/>ホーム</);
 assert.ok(!calls.some(path=>path.startsWith('/dashboard')));
 await ui.action('child-home','child');
 assert.equal(ui.location.hash,'#child-home/child');
 assert.match(ui.nodes['#content'].innerHTML,/りょ子の目標・お手伝い/);
 assert.equal(calls.at(-1),'/dashboard?childId=child');
 await ui.go('#home');
 assert.match(ui.nodes['#content'].innerHTML,/子ども一覧/);
 await ui.go('#child-home/child');
 assert.match(ui.nodes['#content'].innerHTML,/りょ子の目標・お手伝い/);
});

test('child home still opens the child dashboard',async()=>{
 const ui=await frontend(async path=>path==='/auth/session'?{...session,user:{...session.user,role:'child',displayName:'りょ子'}}:basic(path));
 assert.match(ui.nodes['#content'].innerHTML,/りょ子、おかえり！/);
 assert.match(ui.nodes['#navigation'].innerHTML,/>ホーム</);
 assert.doesNotMatch(ui.nodes['#content'].innerHTML,/子ども一覧/);
});


test('demo tools do not change navigation or welcome layout',async()=>{
 for(const authenticated of [true,false]){
  const regularSession=authenticated?session:{authenticated:false};
  const regular=await frontend(async path=>path==='/auth/session'?regularSession:basic(path));
  const demo=await frontend(async path=>path==='/auth/session'?{...regularSession,demo:true}:basic(path));
  assert.equal(demo.nodes['#navigation'].innerHTML,regular.nodes['#navigation'].innerHTML);
  assert.equal(demo.nodes['#content'].innerHTML,regular.nodes['#content'].innerHTML);
  assert.equal(demo.nodes['#demo-tools'].hidden,false);
  assert.equal(regular.nodes['#demo-tools'].hidden,true);
  assert.doesNotMatch(demo.nodes['#navigation'].innerHTML,/デモ操作/);
  assert.equal([...demo.nodes['#navigation'].innerHTML.matchAll(/<a href=/g)].length,3);
  assert.doesNotMatch(demo.nodes['#navigation'].innerHTML,/href="#chores"/);
 }
});


test('current device uses logout while other connections use revocation',async()=>{
 const sent:string[]=[];
 const confirmations:string[]=[];let accepted=false;
 let devices=[{deviceSessionId:'current',deviceLabel:'保護者の端末',isCurrent:true},{deviceSessionId:'other',deviceLabel:'子どもの端末',isCurrent:false}];
 const ui=await frontend(async(path,method)=>{
  if(method==='POST'||method==='DELETE')sent.push(method+' '+path);
  if(path==='/devices/other'&&method==='DELETE'){devices=devices.filter(d=>d.deviceSessionId!=='other');return {currentDeviceRevoked:false};}
  if(path==='/profile')return {displayName:'親'};
  if(path==='/devices')return {devices};
  if(path==='/pairing/requests')return {requests:[]};
  return basic(path);
 },message=>{confirmations.push(message);return accepted;});
 await ui.go('#settings');
 const html=ui.nodes['#content'].innerHTML;
 assert.match(html,/この端末からログアウト/);
 assert.doesNotMatch(html,/data-action="revoke-device" data-id="current"|Googleで本人確認する/);
 await ui.run(()=>ui.action('revoke-device','other'));
 assert.deepEqual(sent,[]);
 assert.match(ui.nodes['#content'].innerHTML,/data-id="other"/);
 assert.match(confirmations[0],/接続を解除しますか/);
 accepted=true;
 await ui.run(()=>ui.action('revoke-device','other'));
 assert.match(ui.nodes['#notice'].textContent,/接続を解除しました/);
 assert.doesNotMatch(ui.nodes['#content'].innerHTML,/data-id="other"/);
 await ui.run(()=>ui.action('logout'));
 assert.deepEqual(sent,['DELETE /devices/other','POST /auth/logout']);
 assert.equal(ui.state.session.authenticated,false);
 assert.equal(ui.nodes['#navigation'].hidden,true);
 assert.match(ui.nodes['#content'].innerHTML,/Googleで保護者ログイン/);
});

test('failed device revocation shows the reason and brings it into view',async()=>{
 const ui=await frontend(basic);
 let scrolled=false;ui.nodes['#notice'].scrollIntoView=()=>{scrolled=true;};
 await ui.run(async()=>{throw Object.assign(new Error('安全のためGoogleで本人確認をしてください。'),{code:'REAUTH_REQUIRED',status:403});});
 assert.match(ui.nodes['#notice'].textContent,/Googleで本人確認/);
 assert.equal(scrolled,true);
 assert.equal(ui.state.session.authenticated,true);
});


test('settings refresh keeps content visible while waiting and restores scroll position',async()=>{
 let refresh=false,finish:any;
 const pending=new Promise(resolve=>{finish=resolve;});
 const ui=await frontend(async path=>{
  if(path==='/profile')return {displayName:'親'};
  if(path==='/devices')return {devices:[]};
  if(path==='/pairing/requests')return refresh?pending:{requests:[]};
  return basic(path);
 });
 await ui.go('#settings');
 const before=ui.nodes['#content'].innerHTML;
 assert.match(before,/>更新<\/button>/);
 assert.doesNotMatch(before,/申請を再確認する/);
 ui.window.scrollY=900;
 refresh=true;
 const updating=ui.action('reload');
 assert.equal(ui.nodes['#content'].innerHTML,before);
 assert.equal(ui.window.scrollY,900);
 // Content replacement may move the browser viewport; refresh restores it.
 ui.window.scrollY=0;
 finish({requests:[{childDisplayName:'更新後の申請',status:'approved'}]});
 await updating;
 assert.match(ui.nodes['#content'].innerHTML,/更新後の申請/);
 assert.equal(ui.window.scrollY,900);
 assert.equal(ui.location.hash,'#settings');
});

test('a delayed refresh cannot restore scroll after leaving the screen',async()=>{
 let refresh=false,finish:any;
 const pending=new Promise(resolve=>{finish=resolve;});
 const ui=await frontend(async path=>{
  if(path==='/profile')return {displayName:'親'};
  if(path==='/devices')return {devices:[]};
  if(path==='/pairing/requests')return refresh?pending:{requests:[]};
  return basic(path);
 });
 await ui.go('#settings');ui.window.scrollY=900;refresh=true;
 const updating=ui.action('reload');
 await ui.go('#home');ui.window.scrollY=100;
 finish({requests:[]});await updating;
 assert.equal(ui.window.scrollY,100);
 assert.match(ui.nodes['#content'].innerHTML,/子ども一覧/);
});


test('small screen label follows the signed-in role, including child details and logout',async()=>{
 const ui=await frontend(basic);
 assert.equal(ui.nodes['#role-label'].textContent,'保護者の画面');
 assert.equal(ui.nodes['#role-label'].hidden,false);
 await ui.action('child-home','child');
 assert.equal(ui.nodes['#role-label'].textContent,'保護者の画面');
 ui.state.session={...session,user:{...session.user,role:'child'}};
 await ui.go('#home');
 assert.equal(ui.nodes['#role-label'].textContent,'子どもの画面');
 assert.equal(ui.nodes['#role-label'].hidden,false);
 ui.state.session={authenticated:false};await ui.go('#home');
 assert.equal(ui.nodes['#role-label'].hidden,true);
 assert.equal(ui.nodes['#role-label'].textContent,'');
});

test('unified chat starts the personal thread and retains child buttons and shared chat routing',async()=>{
 const calls:string[]=[];
 const thread={conversationId:'latest',mode:'consultation',phase:'not_started',canMessage:false,messages:[],products:[]};
 const ui=await frontend(async(path,method)=>{
  calls.push((method||'GET')+' '+path);
  if(path==='/children')return {children:[{childId:'child',displayName:'一人目'},{childId:'other',displayName:'二人目'}]};
  if(path.startsWith('/conversations?'))return {conversations:[{conversationId:'old',updatedAt:'2026-10-24'},{conversationId:'latest',updatedAt:'2026-10-25'}]};
  if(path==='/negotiations')return {negotiations:[{negotiationId:'shared',childId:'child'},{negotiationId:'other-shared',childId:'other'}]};
  if(path==='/negotiations/shared')return {...thread,mode:'negotiation',negotiationId:'shared',phase:'negotiation',canMessage:true};
  if(path==='/conversations/latest/start')return {...thread,phase:'consultation',canMessage:true};
  if(path.startsWith('/conversations/'))return {...thread,conversationId:path.split('/')[2]};
  return basic(path);
 });
 await ui.go('#conversations');
 const html=ui.nodes['#content'].innerHTML;
 assert.equal(ui.state.chat.conversationId,'latest');
 assert.match(html,/class="chat-child-toggle"/);assert.match(html,/data-action="select-chat-child"/);assert.match(html,/一人目/);assert.match(html,/二人目/);
 assert.match(html,/data-action="new-chat"/);assert.match(html,/data-id="child" aria-pressed="true"/);
 assert.doesNotMatch(html,/data-id="other-shared"/);assert.match(html,/data-form="message"/);
 assert.deepEqual(calls.filter(call=>call.startsWith('POST ')),['POST /conversations/latest/start']);
 assert.equal(ui.nodes['#content'].classList.contains('chat-layout-v3'),true);
 assert.match(ui.nodes['#content'].innerHTML,/data-form="message"/);
 await ui.action('open-chat','old');assert.equal(ui.location.hash,'#conversation/old');
 await ui.action('open-negotiation','shared');assert.equal(ui.location.hash,'#negotiation/shared');
 assert.match(ui.nodes['#content'].innerHTML,/親子に公開するメッセージ/);
 assert.doesNotMatch(ui.nodes['#content'].innerHTML,/data-action="search-product-now"/);
 await ui.action('select-chat-child','other');
 assert.equal(ui.location.hash,'#conversations');
 assert.equal(ui.state.childId,'other');
 assert.ok(calls.includes('GET /conversations?childId=other'));
 assert.match(ui.nodes['#content'].innerHTML,/data-id="other" aria-pressed="true"/);
 assert.doesNotMatch(ui.nodes['#content'].innerHTML,/data-id="shared"/);
 await ui.go('#home');assert.match(ui.nodes['#content'].innerHTML,/子ども一覧/);
 assert.equal(ui.nodes['#content'].classList.contains('chat-layout-v3'),false);
});

test('new unified chat uses existing create, start and product search endpoints',async()=>{
 const posts:{path:string,body:any}[]=[];
 let thread={conversationId:'new',mode:'consultation',phase:'not_started',canMessage:false,messages:[],products:[]};
 const ui=await frontend(async(path,method,body)=>{
  if(method==='POST')posts.push({path,body});
  if(path==='/auth/session')return {...session,user:{...session.user,role:'child'}};
  if(path==='/conversations'&&method!=='POST')return {conversations:[]};
  if(path==='/negotiations')return {negotiations:[]};
  if(path==='/conversations')return {conversationId:'new'};
  if(path==='/conversations/new/start')thread={...thread,phase:'consultation',canMessage:true};
  if(path.startsWith('/conversations/new'))return thread;
  return basic(path);
 });
 await ui.go('#conversations');
 assert.equal(JSON.stringify(posts),JSON.stringify([{path:'/conversations',body:{}},{path:'/conversations/new/start',body:{}}]));
 assert.match(ui.nodes['#content'].innerHTML,/data-form="message"/);
 await ui.action('search-product-now');
 assert.equal(ui.nodes['#notice'].textContent,'');
 assert.equal(posts.at(-1)?.path,'/conversations/new/search');
 assert.equal(posts.at(-1)?.body.fromConversation,true);assert.equal(posts.at(-1)?.body.query,undefined);
 assert.match(ui.nodes['#content'].innerHTML,/data-form="message"/);
 assert.doesNotMatch(ui.nodes['#content'].innerHTML,/data-form="search-products"/);
});
