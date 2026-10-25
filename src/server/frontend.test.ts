import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// Execute the shipped script with a small DOM boundary. No application-only test hooks.
const source=await readFile(new URL('../../frontend/app.js',import.meta.url),'utf8');
async function frontend(request:(path:string,method?:string,body?:any)=>Promise<any>,confirm=(_message:string)=>true){
 const nodes:any=Object.fromEntries(['#content','#notice','#navigation','#demo-tools','#role-label','#pairing-dialog','#pairing-error','#activity-indicator'].map(id=>[id,{innerHTML:'',textContent:'',setAttribute(){},insertAdjacentHTML(){}}]));
 nodes['#activity-indicator'].hidden=true;
 const dialog=nodes['#pairing-dialog'];dialog.open=false;dialog.showModal=()=>{dialog.open=true;};dialog.close=()=>{dialog.open=false;};dialog.addEventListener=()=>{};
 const classes=new Set<string>();
 nodes['#content'].classList={add:(...names:string[])=>names.forEach(name=>classes.add(name)),remove:(...names:string[])=>names.forEach(name=>classes.delete(name)),contains:(name:string)=>classes.has(name)};
 const location={hash:'#home',search:'',pathname:'/'};
 const events:any={};const window:any={scrollX:0,scrollY:0,scrollTo(position:any){window.scrollX=position.left;window.scrollY=position.top;},addEventListener:(name:string,fn:any)=>{events[name]=fn;}};
 const document:any={visibilityState:'visible',activeElement:null,querySelector:(id:string)=>nodes[id],addEventListener:(name:string,fn:any)=>{events[name]=fn;}};
 const context=vm.createContext({window,document,location,
 history:{pushState:(_:unknown,__:string,hash:string)=>{location.hash=hash;},replaceState:(_:unknown,__:string,hash:string)=>{location.hash=hash;}},
 sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},API:{request,clear(){}},URL,URLSearchParams,console,confirm});
 vm.runInContext(source.replace(/\}\)\(\);\s*$/, 'window.testing={state,run,go,action,submit,chat,checkPairingRequests,refreshVisible};})();'),context);
 await new Promise(resolve=>setImmediate(resolve));
 return {...window.testing,nodes,events,location,window,document};
}
const session={authenticated:true,user:{role:'parent',displayName:'保護者',onboardingCompleted:true}};
const dashboard={childId:'child',children:[],goals:[],chores:[],choreRequests:[],proposals:[]};
const basic=async(path:string)=>path==='/auth/session'?session:path.startsWith('/dashboard')?dashboard:{children:[]};

test('initial session failure stops loading and retry restores the authenticated entry',async()=>{
 let attempts=0;
 const ui=await frontend(async path=>{
  if(path==='/auth/session'&&++attempts===1)throw Error('サーバーの応答を確認できません。');
  if(path==='/profile')return {displayName:'親'};
  if(path==='/devices')return {devices:[]};
  if(path==='/pairing/requests')return {requests:[]};
  return basic(path);
 });
 assert.match(ui.nodes['#notice'].textContent,/サーバーの応答/);
 assert.match(ui.nodes['#content'].innerHTML,/もう一度読み込む/);
 assert.doesNotMatch(ui.nodes['#content'].innerHTML,/読み込んでいます/);
 assert.equal(ui.state.loading,false);
 await ui.action('reload');
 assert.equal(attempts,2);
 assert.match(ui.nodes['#content'].innerHTML,/子ども一覧/);
 assert.equal(ui.nodes['#notice'].textContent,'');
 assert.equal(ui.nodes['#navigation'].hidden,false);
 await ui.go('#settings');
 assert.match(ui.nodes['#content'].innerHTML,/保護者の設定/);
 assert.match(ui.nodes['#navigation'].innerHTML,/#home/);
 await ui.go('#home');
 assert.match(ui.nodes['#content'].innerHTML,/子ども一覧/);
});

test('initial session retry shows login when there is no authenticated session',async()=>{
 let available=false;
 const ui=await frontend(async()=>{
  if(!available)throw Error('通信エラー');
  return {authenticated:false};
 });
 available=true;
 await ui.action('reload');
 assert.match(ui.nodes['#content'].innerHTML,/Googleで保護者ログイン/);
 assert.equal(ui.nodes['#navigation'].hidden,true);
 assert.equal(ui.nodes['#notice'].textContent,'');
});

test('initial child dashboard failure can be retried without losing the session',async()=>{
 let available=false,sessions=0;
 const ui=await frontend(async path=>{
  if(path==='/auth/session'){sessions++;return {...session,user:{...session.user,role:'child'}};}
  if(path.startsWith('/dashboard')&&!available)throw Error('サーバーの応答を確認できません。');
  return basic(path);
 });
 assert.match(ui.nodes['#content'].innerHTML,/もう一度読み込む/);
 assert.doesNotMatch(ui.nodes['#content'].innerHTML,/読み込んでいます/);
 available=true;
 await ui.action('reload');
 assert.equal(sessions,1);
 assert.match(ui.nodes['#content'].innerHTML,/ありがとうポイント/);
 assert.equal(ui.nodes['#notice'].textContent,'');
 await ui.go('#chores');
 assert.match(ui.nodes['#content'].innerHTML,/おてつだい/);
 await ui.go('#home');
 assert.match(ui.nodes['#content'].innerHTML,/ありがとうポイント/);
});

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
 assert.equal(ui.nodes['#notice'].textContent,'');
});

test('child registration has no budget fields or reward guidelines in its request',async()=>{
 const sent:any[]=[];const ui=await frontend(async(path,method,body)=>{
  if(path==='/children'&&method==='POST'){sent.push(body);return {childId:'child'};}
  return basic(path);
 });
 await ui.go('#children');
 assert.doesNotMatch(ui.nodes['#content'].innerHTML,/smallJpy|mediumJpy|largeJpy|目標の目安/);
 await ui.submit('create-child','',{displayName:'子',birthDate:'2017-04-01',gradeLevel:'elementary_3',chorePreferences:''});
 assert.equal(sent.length,1);
 assert.equal('rewardGuidelines' in sent[0],false);
});

test('parent and child receive different chat introduction and settings links',async()=>{
 const childSession={...session,user:{...session.user,role:'child'}};
 const ui=await frontend(async path=>path==='/auth/session'?childSession:path==='/conversations/chat'?{messages:[],products:[]}:basic(path));
 await ui.chat('chat');assert.match(ui.nodes['#content'].innerHTML,/ぽぽだよ/);
 assert.match(ui.nodes['#navigation'].innerHTML,/じぶんの設定/);assert.doesNotMatch(ui.nodes['#navigation'].innerHTML,/子ども一覧/);
 ui.state.session=session;await ui.chat('chat');assert.match(ui.nodes['#content'].innerHTML,/子どもから届いたおねがい/);assert.doesNotMatch(ui.nodes['#content'].innerHTML,/data-form="message"|data-action="new-chat"/);
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
  if(path==='/auth/session')return {...session,user:{...session.user,role:'child'}};
  if(path==='/conversations/chat/start'){starts.push(path);thread.phase='consultation';thread.canMessage=true;return thread;}
  return path==='/conversations/chat'?thread:basic(path);
 });
 await ui.chat('chat');let html=ui.nodes['#content'].innerHTML;
 assert.match(html,/data-form="message"/);assert.equal(starts.length,1);
 assert.ok(html.indexOf('ぽぽだよ。')<html.indexOf('以前の返答'));assert.match(html,/message-avatar/);
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
 // The chat header was removed for space; the composer placeholder still says the chat is shared.
 assert.match(ui.nodes['#content'].innerHTML,/placeholder="親子に公開するメッセージ"/);assert.doesNotMatch(ui.nodes['#content'].innerHTML,/chat-intro/);
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
  assert.equal([...demo.nodes['#navigation'].innerHTML.matchAll(/<a href=/g)].length,authenticated?2:3);
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
 await ui.run(async()=>{throw Object.assign(new Error('接続を解除できませんでした。'),{code:'FORBIDDEN',status:403});});
 assert.match(ui.nodes['#notice'].textContent,/接続を解除できませんでした/);
 assert.equal(scrolled,true);
 assert.equal(ui.state.session.authenticated,true);
});


test('settings refresh keeps content visible while waiting and restores scroll position',async()=>{
 let refresh=false,finish:any;
 const pending=new Promise(resolve=>{finish=resolve;});
 const ui=await frontend(async path=>{
  if(path==='/profile')return {displayName:'親'};
  if(path==='/devices')return refresh?pending:{devices:[]};
  if(path==='/pairing/requests')return {requests:[]};
  return basic(path);
 });
 await ui.go('#settings');
 const before=ui.nodes['#content'].innerHTML;
 assert.doesNotMatch(before,/>更新<\/button>/);
 assert.doesNotMatch(before,/申請を再確認する/);
 ui.window.scrollY=900;
 refresh=true;
 const updating=ui.action('reload');
 assert.equal(ui.nodes['#content'].innerHTML,before);
 assert.equal(ui.window.scrollY,900);
 // Content replacement may move the browser viewport; refresh restores it.
 ui.window.scrollY=0;
 finish({devices:[{deviceLabel:'更新後の端末',lastActiveAt:null}]});
 await updating;
 assert.match(ui.nodes['#content'].innerHTML,/更新後の端末/);
 assert.equal(ui.window.scrollY,900);
 assert.equal(ui.location.hash,'#settings');
});

test('a delayed refresh cannot restore scroll after leaving the screen',async()=>{
 let refresh=false,finish:any;
 const pending=new Promise(resolve=>{finish=resolve;});
 const ui=await frontend(async path=>{
  if(path==='/profile')return {displayName:'親'};
  if(path==='/devices')return refresh?pending:{devices:[]};
  if(path==='/pairing/requests')return {requests:[]};
  return basic(path);
 });
 await ui.go('#settings');ui.window.scrollY=900;refresh=true;
 const updating=ui.action('reload');
 await ui.go('#home');ui.window.scrollY=100;
 finish({devices:[]});await updating;
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

test('parent has no personal chat and enters only a submitted proposal negotiation',async()=>{
 const calls:string[]=[];let received:any[]=[];
 const ui=await frontend(async(path,method)=>{
  calls.push((method||'GET')+' '+path);
  if(path==='/proposals/received')return {proposals:received};
  if(path==='/negotiations/shared')return {mode:'negotiation',negotiationId:'shared',phase:'negotiation',canMessage:true,messages:[],products:[]};
  return basic(path);
 });
 assert.doesNotMatch(ui.nodes['#navigation'].innerHTML,/#conversations/);
 await ui.go('#conversations');
 assert.doesNotMatch(ui.nodes['#content'].innerHTML,/data-form="message"|data-action="new-chat"/);
 await assert.rejects(ui.action('new-chat'),/子どもから届いた/);
 assert.equal(calls.some(c=>c.includes('/conversations')),false);
 received=[{proposal:{id:'request',negotiationId:'shared',status:'pending'},product:{name:'図鑑'},childDisplayName:'子',canRespond:true,canConsult:false}];
 await ui.go('#home');
 assert.match(ui.nodes['#content'].innerHTML,/図鑑/);
 assert.match(ui.nodes['#content'].innerHTML,/内容を確認して返事する/);
 assert.doesNotMatch(ui.nodes['#navigation'].innerHTML,/#conversations/);
 received[0]={...received[0],proposal:{...received[0].proposal,status:'rejected'},canRespond:false,canConsult:true,negotiationId:'shared',negotiationStatus:'revision_requested'};
 await ui.go('#home');
 assert.match(ui.nodes['#navigation'].innerHTML,/#conversations/);
 await ui.go('#conversations');
 assert.match(ui.nodes['#content'].innerHTML,/data-action="open-negotiation"/);
 await ui.action('open-negotiation','shared');
 assert.match(ui.nodes['#content'].innerHTML,/親子に公開するメッセージ/);
 assert.doesNotMatch(ui.nodes['#content'].innerHTML,/data-action="new-chat"/);
 assert.equal(calls.some(c=>c.startsWith('POST ')),false);
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
 const scroller=ui.nodes['.chat-scroll-area']={scrollTop:0,scrollHeight:1200};
 await ui.go('#conversations');
 assert.equal(scroller.scrollTop,1200);
 assert.equal(JSON.stringify(posts),JSON.stringify([{path:'/conversations',body:{}},{path:'/conversations/new/start',body:{}}]));
 assert.match(ui.nodes['#content'].innerHTML,/data-form="message"/);
 await ui.action('search-product-now');
 assert.equal(ui.nodes['#notice'].textContent,'');
 assert.equal(posts.at(-1)?.path,'/conversations/new/search');
 assert.equal(posts.at(-1)?.body.fromConversation,true);assert.equal(posts.at(-1)?.body.query,undefined);
 assert.match(ui.nodes['#content'].innerHTML,/data-form="message"/);
 assert.doesNotMatch(ui.nodes['#content'].innerHTML,/data-form="search-products"/);
 scroller.scrollTop=0;scroller.scrollHeight=2400;
 await ui.submit('message','',{message:'続きの相談です'});
 assert.equal(posts.at(-1)?.path,'/conversations/new/messages');
 assert.equal(scroller.scrollTop,2400);
});

test('chat has one new-chat button beside product search, replaces the old chat and keeps the menu',async()=>{
 const calls:string[]=[];let failDelete=false,phase='consultation',currentProposal:any=null;
 const ui=await frontend(async(path,method)=>{
  calls.push((method||'GET')+' '+path);
  if(path==='/auth/session')return {...session,user:{...session.user,role:'child'}};
  if(path==='/conversations'&&method==='POST')return {conversationId:'new'};
  if(path==='/conversations/old'&&method==='DELETE'){if(failDelete)throw Object.assign(Error('ぽぽが返事を作っています。'),{code:'INVALID_STATE'});return {conversationId:'old',deleted:true};}
  if(path.startsWith('/conversations/'))return {conversationId:path.split('/')[2],mode:'consultation',phase,canMessage:phase==='consultation',messages:[],products:[],currentProposal};
  return basic(path);
 });
 const changes=()=>calls.filter(call=>!call.startsWith('GET '));
 await ui.go('#conversation/old');
 const html=ui.nodes['#content'].innerHTML;
 assert.doesNotMatch(html,/ぽぽとチャット|chat-intro|delete-chat/);
 assert.match(html,/<div class="chat-actions">[^<]*<button[^>]*data-action="search-product-now"[^]*?data-action="new-chat"[^]*?<\/div><form class="proposal-form" data-form="message"/);
 assert.match(html,/placeholder="ぽぽへのメッセージ"/);
 assert.equal(ui.nodes['#navigation'].hidden,false);
 assert.match(ui.nodes['#navigation'].innerHTML,/#home[^]*#conversations[^]*#settings/);

 await ui.action('new-chat');
 assert.deepEqual(changes(),['POST /conversations','DELETE /conversations/old']);
 assert.equal(ui.location.hash,'#conversation/new');
 assert.equal(ui.state.chat.conversationId,'new');

 // A refused delete must not stop the new chat from opening.
 calls.length=0;failDelete=true;
 await ui.go('#conversation/old');await ui.action('new-chat');
 assert.deepEqual(changes(),['POST /conversations','DELETE /conversations/old']);
 assert.equal(ui.location.hash,'#conversation/new');
 assert.equal(ui.nodes['#notice'].textContent,'');

 // Chats with a proposal are kept; the button is still offered after the chat can no longer send.
 calls.length=0;failDelete=false;phase='awaiting_response';currentProposal={id:'proposal'};
 await ui.go('#conversation/old');
 assert.doesNotMatch(ui.nodes['#content'].innerHTML,/data-action="search-product-now"/);
 assert.match(ui.nodes['#content'].innerHTML,/data-action="new-chat"/);
 await ui.action('new-chat');
 assert.deepEqual(changes(),['POST /conversations']);
 assert.equal(ui.location.hash,'#conversation/new');
});

test('cancelling the new-chat confirmation changes nothing',async()=>{
 const calls:string[]=[];
 const ui=await frontend(async(path,method)=>{
  calls.push((method||'GET')+' '+path);
  if(path==='/auth/session')return {...session,user:{...session.user,role:'child'}};
  if(path.startsWith('/conversations/'))return {conversationId:'old',mode:'consultation',phase:'consultation',canMessage:true,messages:[],products:[]};
  return basic(path);
 },()=>false);
 await ui.go('#conversation/old');
 await ui.action('new-chat');
 assert.deepEqual(calls.filter(call=>!call.startsWith('GET ')),[]);
 assert.equal(ui.location.hash,'#conversation/old');
});

test('selected product leads to discussion, draft review and one save-and-send action',async()=>{
 const calls:{path:string,method:string,body:any}[]=[];
 const product={id:'product',name:'図鑑',priceJpy:1000};
 let draft={id:'draft',productId:'product',status:'draft',version:1,persuasionText:'星を調べたい',purchaseConditions:['大切に使う']};
 const thread={conversationId:'chat',mode:'consultation',phase:'consultation',canMessage:true,messages:[{sender:'assistant',content:'ほしい理由を教えてね'}],products:[product],selectedProductId:'product',currentProposal:null as any,reasonSummary:'星を調べたい',reasonConfirmed:false};
 const ui=await frontend(async(path,method='GET',body)=>{
  calls.push({path,method,body});
  if(path==='/auth/session')return {...session,user:{...session.user,role:'child'}};
  if(path==='/conversations/chat')return thread;
  if(path==='/conversations/chat/confirm-reason'){assert.equal(body.reasonSummary,'星を調べたい');return {...thread,currentProposal:draft,reasonConfirmed:true};}
  if(path==='/proposals/draft'&&method==='PATCH'){draft={...draft,...body,version:2};return {proposal:draft,product,canEdit:true};}
  if(path==='/proposals/draft/send'){assert.equal(body.version,1);draft={...draft,status:'pending'};return {proposal:draft,product};}
  if(path==='/proposals/draft')return {proposal:draft,product,canEdit:draft.status==='draft'};
  return basic(path);
 });
 await ui.go('#conversation/chat');
 assert.match(ui.nodes['#content'].innerHTML,/ほしい理由を教えてね/);
 assert.match(ui.nodes['#content'].innerHTML,/chat-selected-title/);
 assert.match(ui.nodes['#content'].innerHTML,/えらびなおす/);
 await ui.action('confirm-reason');
 assert.equal(ui.location.hash,'#proposal/draft');
 assert.match(ui.nodes['#content'].innerHTML,/おうちのひとに おくる/);
 assert.match(ui.nodes['#content'].innerHTML,/個別の会話は共有しません/);
 assert.doesNotMatch(ui.nodes['#content'].innerHTML,/やくそく|data-form="edit-proposal"/);
 await ui.action('send-proposal','draft');
 assert.deepEqual(calls.filter(c=>c.method!=='GET').map(c=>c.method+' '+c.path),['POST /conversations/chat/confirm-reason','POST /proposals/draft/send']);
 assert.match(ui.nodes['#content'].innerHTML,/へんじまち/);
 assert.doesNotMatch(ui.nodes['#content'].innerHTML,/data-form="edit-proposal"/);
});

test('parent response starts discussion only on revision and final decline stays closed',async()=>{
 let decision='revision_requested';
 const proposal={id:'request',status:'pending',version:1,persuasionText:'ほしい',purchaseConditions:['大切に使う']};
 const ui=await frontend(async(path,method)=>{
  if(path==='/proposals/request/responses')return {canConsult:decision==='revision_requested',negotiationId:'shared'};
  if(path==='/negotiations/shared')return {mode:'negotiation',negotiationId:'shared',phase:'negotiation',canMessage:true,products:[],messages:[]};
  if(path==='/proposals/request')return {proposal:{...proposal,status:'rejected'},negotiationStatus:'closed',negotiationResult:{reason:'今回は購入しません'}};
  return basic(path);
 });
 ui.state.proposal={proposal};
 await ui.submit('respond-proposal','request',{decision,reason:'使う時間を相談したい'});
 assert.equal(ui.location.hash,'#negotiation/shared');
 decision='rejected';ui.state.proposal={proposal};
 await ui.go('#proposal/request');
 await ui.submit('respond-proposal','request',{decision,reason:'今回は購入しません'});
 assert.match(ui.nodes['#content'].innerHTML,/今回は見送り/);
 assert.match(ui.nodes['#content'].innerHTML,/今回は購入しません/);
 assert.doesNotMatch(ui.nodes['#content'].innerHTML,/data-action="consult-proposal"/);
});

const pairingRequest={pairingRequestId:'pair-1',childId:'child',childDisplayName:'こども',confirmationCode:'123456',status:'pending',expiresAt:new Date(Date.now()+600000).toISOString()};
test('incoming pairing opens a number entry dialog without navigating and preserves input across polls',async()=>{
 let pending=false;const writes:any[]=[];
 const ui=await frontend(async(path,method,body)=>{
  if(path==='/pairing/requests')return {requests:pending?[pairingRequest]:[]};
  if(path.endsWith('/responses')){writes.push(body);pending=false;return {status:'approved'};}
  return basic(path);
 });
 const content=ui.nodes['#content'].innerHTML;
 pending=true;await ui.checkPairingRequests();
 const dialog=ui.nodes['#pairing-dialog'];
 assert.equal(dialog.open,true);assert.match(dialog.innerHTML,/6桁の確認番号/);
 assert.doesNotMatch(dialog.innerHTML,/123456/);
 dialog.innerHTML+='entered-input';await ui.checkPairingRequests();assert.match(dialog.innerHTML,/entered-input/);
 assert.equal(ui.nodes['#content'].innerHTML,content);assert.equal(ui.location.hash,'#home');
 await ui.submit('pair-respond-modal','pair-1',{confirmationCode:'123456'});
 assert.deepEqual(writes.map(x=>({...x})),[{decision:'approved',confirmationCode:'123456'}]);
 assert.equal(dialog.open,false);assert.match(ui.nodes['#notice'].textContent,/承認しました/);
});
test('pairing failure stays in the dialog and later defers only that request',async()=>{
 let requests=[pairingRequest];
 const ui=await frontend(async(path,method)=>{
  if(path==='/pairing/requests')return {requests};
  if(method==='POST')throw new Error('確認番号が違います。');
  return basic(path);
 });
 const source={matches:()=>false,disabled:false,closest:()=>true};
 await ui.run(()=>ui.submit('pair-respond-modal','pair-1',{confirmationCode:'654321'}),source);
 assert.equal(ui.nodes['#pairing-dialog'].open,true);
 assert.match(ui.nodes['#pairing-error'].textContent,/確認番号が違います/);
 await ui.action('pairing-later');await ui.checkPairingRequests();
 assert.equal(ui.nodes['#pairing-dialog'].open,false);
 requests=[{...pairingRequest,pairingRequestId:'pair-2'}];await ui.checkPairingRequests();
 assert.equal(ui.nodes['#pairing-dialog'].open,true);assert.match(ui.nodes['#pairing-dialog'].innerHTML,/pair-2/);
 requests=[];await ui.checkPairingRequests();assert.equal(ui.nodes['#pairing-dialog'].open,false);
});
test('pairing rejection sends no confirmation code and child sessions never poll parent requests',async()=>{
 const writes:any[]=[];
 const ui=await frontend(async(path,method,body)=>{
  if(path==='/pairing/requests')return {requests:[pairingRequest]};
  if(method==='POST'){writes.push(body);return {status:'rejected'};}
  return basic(path);
 });
 await ui.action('pairing-reject','pair-1');
 assert.deepEqual(writes.map(x=>({...x})),[{decision:'rejected'}]);assert.equal(ui.nodes['#pairing-dialog'].open,false);
 let polls=0;
 const child=await frontend(async path=>{
  if(path==='/auth/session')return {...session,user:{...session.user,role:'child'}};
  if(path==='/pairing/requests')polls++;
  return basic(path);
 });
 await child.checkPairingRequests();assert.equal(polls,0);assert.equal(child.nodes['#pairing-dialog'].open,false);
});

test('foreground request shows a spinner and clears it on both success and failure',async()=>{
 let finish!:(value:any)=>void,fail!:(reason:Error)=>void;
 const ui=await frontend(async path=>path==='/conversations/slow'?new Promise((resolve,reject)=>{finish=resolve;fail=reject;}):basic(path));
 ui.state.session={...session,user:{...session.user,role:'child'}};
 const pending=ui.run(()=>ui.chat('slow'));
 assert.equal(ui.nodes['#activity-indicator'].hidden,false);
 finish({conversationId:'slow',messages:[],products:[]});await pending;
 assert.equal(ui.nodes['#activity-indicator'].hidden,true);
 const failure=ui.run(()=>ui.chat('slow'));
 assert.equal(ui.nodes['#activity-indicator'].hidden,false);
 fail(new Error('通信に失敗しました'));await failure;
 assert.equal(ui.nodes['#activity-indicator'].hidden,true);
 assert.match(ui.nodes['#notice'].textContent,/通信に失敗/);
});
test('spinner stays visible while an older overlapping request is still pending',async()=>{
 let finish!:(value:any)=>void;
 const ui=await frontend(async path=>path==='/conversations/slow'?new Promise(resolve=>{finish=resolve;}):basic(path));
 ui.state.session={...session,user:{...session.user,role:'child'}};
 const pending=ui.run(()=>ui.chat('slow'));
 await ui.go('#children');
 assert.equal(ui.nodes['#activity-indicator'].hidden,false);
 finish({conversationId:'slow',messages:[],products:[]});await pending;
 assert.equal(ui.nodes['#activity-indicator'].hidden,true);
});

test('画像URLなしで保存された商品も画像APIから取得を試みる',async()=>{
 const ui=await frontend(async path=>{
  if(path==='/conversations/images')return {conversationId:'images',messages:[],products:[{id:'game-1',name:'ゲーム',imageUrl:null,productUrl:'https://www.amazon.co.jp/dp/B000000001',priceJpy:1000}]};
  return basic(path);
 });
 ui.state.session={...session,user:{...session.user,role:'child'}};
 await ui.chat('images');
 assert.match(ui.nodes['#content'].innerHTML,/<img class="product-image" src="\/api\/products\/game-1\/image"/);
});

test('商品カードは画像・商品名・円価格を表示し説明文を表示しない',async()=>{
 const ui=await frontend(async path=>{
  if(path==='/conversations/card')return {conversationId:'card',messages:[],products:[{id:'game-1',name:'ゲーム',imageUrl:'/api/products/game-1/image',productUrl:'https://www.amazon.co.jp/dp/B000000001',priceJpy:5980,description:'不要な商品解説',recommendationReason:'不要な推薦文'}]};
  return basic(path);
 });
 ui.state.session={...session,user:{...session.user,role:'child'}};
 await ui.chat('card');
 const html=ui.nodes['#content'].innerHTML;
 assert.match(html,/ゲーム/);assert.match(html,/5,980円/);
 assert.match(html,/src="\/api\/products\/game-1\/image"/);
 assert.doesNotMatch(html,/不要な商品解説|不要な推薦文|product-reason|5,980 ポイント/);
});


test('automatic refresh avoids overlap, keeps text typed during the request, and stops while hidden',async()=>{
 let refreshing=false,finish:any,reads=0;
 const pending=new Promise(resolve=>{finish=resolve;});
 const ui=await frontend(async path=>{if(path.startsWith('/dashboard')){reads++;return refreshing?pending:dashboard;}return {...session,user:{...session.user,role:'child'}};});
 const form={dataset:{form:'message',id:''}};
 let field:any={name:'message',value:'かきかけ',closest:()=>form,focus(){ui.document.activeElement=this;},selectionStart:2,selectionEnd:2,setSelectionRange(a:number,b:number){this.selectionStart=a;this.selectionEnd=b;}};
 const content=ui.nodes['#content'];let html=content.innerHTML;
 Object.defineProperty(content,'innerHTML',{get:()=>html,set:(next:string)=>{html=next;field={...field,value:''};}});
 content.querySelectorAll=(selector:string)=>selector==='input,textarea,select'?[field]:[];
 ui.document.activeElement=field;refreshing=true;
 const updating=ui.refreshVisible();await new Promise(resolve=>setImmediate(resolve));
 const count=reads;await ui.refreshVisible();assert.equal(reads,count);
 field.value='通信中にも かきつづけた';field.selectionStart=5;field.selectionEnd=5;
 finish({...dashboard,balanceYen:123});await updating;
 assert.equal(field.value,'通信中にも かきつづけた');assert.equal(field.selectionStart,5);assert.equal(ui.document.activeElement,field);
 assert.match(content.innerHTML,/123/);
 ui.document.visibilityState='hidden';await ui.refreshVisible();assert.equal(reads,count);
});

test('cached tab appears immediately and background refresh does not replace a newer destination',async()=>{
 let slow=false,finish:any;const pending=new Promise(resolve=>{finish=resolve;});
 const ui=await frontend(async path=>{if(path==='/auth/session')return {...session,user:{...session.user,role:'child'}};if(path.startsWith('/dashboard'))return slow?pending:dashboard;return basic(path);});
 await ui.go('#chores');slow=true;
 const returning=ui.go('#home');
 assert.match(ui.nodes['#content'].innerHTML,/ありがとうポイント/);
 await ui.go('#settings');finish({...dashboard,balanceYen:999});await returning;
 assert.match(ui.nodes['#content'].innerHTML,/じぶんの設定/);assert.doesNotMatch(ui.nodes['#content'].innerHTML,/999/);
});

test('registration proceeds to device invitation and removed preferences are not submitted',async()=>{
 const writes:any[]=[];
 const ui=await frontend(async(path,method='GET',body)=>{if(method!=='GET')writes.push({path,body});if(path==='/children'&&method==='POST')return {childId:'new'};if(path==='/children/new/invitations')return {childId:'new',invitationToken:'ABCDEFGH2345',expiresAt:new Date().toISOString()};return basic(path);});
 await ui.submit('create-child','',{displayName:'こども',birthDate:'2018-01-01',gender:'',gradeLevel:'2'});
 assert.equal(ui.location.hash,'#invitation/new');assert.match(ui.nodes['#content'].innerHTML,/ABCDEFGH2345/);
 assert.equal(Object.hasOwn(writes[0].body,'chorePreferences'),false);
});


test('automatic refresh defers DOM replacement during Japanese composition',async()=>{
 let slow=false,finish:any;const pending=new Promise(resolve=>{finish=resolve;});
 const ui=await frontend(async path=>{if(path==='/auth/session')return {...session,user:{...session.user,role:'child'}};if(path.startsWith('/dashboard'))return slow?pending:dashboard;return basic(path);});
 slow=true;const before=ui.nodes['#content'].innerHTML,updating=ui.refreshVisible();
 await new Promise(resolve=>setImmediate(resolve));ui.events.compositionstart();finish({...dashboard,balanceYen:654});await updating;
 assert.equal(ui.nodes['#content'].innerHTML,before);
 ui.events.compositionend();await ui.refreshVisible();assert.match(ui.nodes['#content'].innerHTML,/654/);
});


test('history clear is at the bottom of parent settings, confirms once and sends nothing on cancel',async()=>{
 let accepts=false,confirmations=0;const writes:any[]=[];
 const ui=await frontend(async(path,method='GET',body)=>{
  if(method!=='GET')writes.push({path,method,body});
  if(path==='/profile')return {displayName:'親'};if(path==='/devices')return {devices:[]};if(path==='/pairing/requests')return {requests:[]};if(path==='/history')return {cleared:true};return basic(path);
 },message=>{confirmations++;assert.match(message,/元に戻せません/);return accepts;});
 await ui.go('#settings');const html=ui.nodes['#content'].innerHTML;
 assert(html.indexOf('履歴の全消去')>html.indexOf('接続中の端末'));
 ui.state.chat={conversationId:'old'};await ui.action('clear-history');assert.equal(writes.length,0);assert.equal(confirmations,1);assert.equal(ui.state.chat.conversationId,'old');
 accepts=true;await ui.action('clear-history');assert.equal(confirmations,2);assert.equal(writes.length,1);assert.equal(writes[0].path,'/history');assert.equal(writes[0].method,'DELETE');assert.equal(writes[0].body.confirmation,'DELETE_ALL_HISTORY');assert.equal(ui.state.chat,null);assert.match(ui.nodes['#notice'].textContent,/消去しました/);
 ui.state.session={...session,user:{...session.user,role:'child'}};await ui.go('#settings');assert.doesNotMatch(ui.nodes['#content'].innerHTML,/clear-history/);
 await assert.rejects(ui.action('clear-history'),/保護者/);
});


test('pairing uses automatic dialog without a duplicate settings section or manual invitation link',async()=>{
 let pending=false;const ui=await frontend(async path=>{if(path==='/profile')return {displayName:'親'};if(path==='/devices')return {devices:[]};if(path==='/pairing/requests')return {requests:pending?[pairingRequest]:[]};if(path==='/children/child/invitations')return {childId:'child',invitationToken:'ABCDEFGH2345'};return basic(path);});
 await ui.go('#settings');assert.doesNotMatch(ui.nodes['#content'].innerHTML,/子どもの端末の接続申請|接続申請はありません|data-form="pair-respond"/);
 assert.match(ui.nodes['#content'].innerHTML,/接続中の端末/);assert.match(ui.nodes['#content'].innerHTML,/履歴の全消去/);
 await ui.action('invite','child');assert.doesNotMatch(ui.nodes['#content'].innerHTML,/接続申請を確認する/);assert.match(ui.nodes['#content'].innerHTML,/画面が自動で開きます/);
 pending=true;await ui.checkPairingRequests();assert.equal(ui.nodes['#pairing-dialog'].open,true);assert.match(ui.nodes['#pairing-dialog'].innerHTML,/6桁の確認番号/);
 await ui.go('#children');assert.match(ui.nodes['#content'].innerHTML,/子ども一覧/);
});

test('incomplete registrations can be removed and expired established children can reconnect or be explicitly deleted',async()=>{
 let accepts=false;const writes:any[]=[];let records=[{childId:'pending',displayName:'未完了の子',hasCompletedPairing:false,hasLinkedDevice:false},{childId:'expired',displayName:'期限切れの子',hasCompletedPairing:true,hasLinkedDevice:false}];
 const ui=await frontend(async(path,method='GET',body)=>{
  if(method!=='GET'){writes.push({path,method,body});if(path==='/children/expired')records=records.filter(c=>c.childId!=='expired');return {deleted:true};}
  if(path==='/children')return {children:records};if(path==='/children/expired/settings')return {constraints:{mustHave:[],mustAvoid:[]}};if(path==='/proposals/received')return {proposals:[]};return basic(path);
 },message=>{assert.match(message,/期限切れの子/);assert.match(message,/元に戻せません/);return accepts;});
 await ui.go('#children');let html=ui.nodes['#content'].innerHTML;
 assert.match(html,/登録を続ける/);assert.match(html,/data-action="delete-child" data-id="pending"/);assert.match(html,/端末をつなぎ直す/);assert.doesNotMatch(html,/端末未接続/);assert.equal(writes.length,0);
 await ui.go('#child-settings/expired');assert.match(ui.nodes['#content'].innerHTML,/data-action="delete-child" data-id="expired"/);
 await ui.action('delete-child','expired');assert.equal(writes.length,0);
 accepts=true;ui.state.childId='expired';await ui.action('delete-child','expired');assert.equal(writes.length,1);assert.equal(writes[0].method,'DELETE');assert.equal(writes[0].path,'/children/expired');assert.equal(writes[0].body.confirmation,'DELETE_CHILD');assert.equal(ui.state.childId,null);assert.equal(ui.location.hash,'#children');assert.doesNotMatch(ui.nodes['#content'].innerHTML,/期限切れの子/);
});
