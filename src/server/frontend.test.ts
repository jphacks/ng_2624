import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// Execute the shipped script with a small DOM boundary. No application-only test hooks.
const source=await readFile(new URL('../../frontend/app.js',import.meta.url),'utf8');
async function frontend(request:(path:string,method?:string,body?:any)=>Promise<any>){
 const nodes:any=Object.fromEntries(['#content','#notice','#navigation'].map(id=>[id,{innerHTML:'',textContent:'',setAttribute(){},insertAdjacentHTML(){}}]));
 const location={hash:'#home',search:'',pathname:'/'};
 const events:any={};const window:any={addEventListener:(name:string,fn:any)=>{events[name]=fn;}};
 const context=vm.createContext({window,document:{querySelector:(id:string)=>nodes[id],addEventListener:(name:string,fn:any)=>{events[name]=fn;}},location,
 history:{pushState:(_:unknown,__:string,hash:string)=>{location.hash=hash;},replaceState:(_:unknown,__:string,hash:string)=>{location.hash=hash;}},
 sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},API:{request,clear(){}},URL,URLSearchParams,console,confirm:()=>true});
 vm.runInContext(source.replace(/\}\)\(\);\s*$/, 'window.testing={state,run,go,action,submit,chat};})();'),context);
 await new Promise(resolve=>setImmediate(resolve));
 return {...window.testing,nodes,events,location};
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
 const conversation={conversationId:'chat',messages:[],products:[],currentProposal:{id:'old'},latestAIOutput:{action:'HEARING',reply:'条件を確認してください'}};
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
 ui.state.session=session;await ui.chat('chat');assert.match(ui.nodes['#content'].innerHTML,/保護者の方/);assert.doesNotMatch(ui.nodes['#content'].innerHTML,/ぽぽだよ/);
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
