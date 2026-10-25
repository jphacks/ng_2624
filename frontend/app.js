(() => {
'use strict';
const $=s=>document.querySelector(s);
let activeOperations=0;
function activity(change){
 activeOperations+=change;
 const indicator=$('#activity-indicator');if(!indicator)return;
 if(activeOperations>0){if(indicator.hidden){indicator.hidden=false;indicator.showPopover?.();}}
 else if(!indicator.hidden){indicator.hidePopover?.();indicator.hidden=true;}
}
async function api(...args){
 const epoch=state.epoch,foreground=backgroundEpoch!==epoch;if(args[1]&&args[1]!=='GET')viewCache.clear();if(foreground)activity(1);
 try { const result=await API.request(...args);if(epoch!==state.epoch)throw Object.assign(new Error(),{stale:true,completed:args[1]&&args[1]!=='GET'});return result; }
 catch(e){if(epoch!==state.epoch)e.stale=true;throw e;}
 finally{if(foreground)activity(-1);}
}
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=n=>Number(n||0).toLocaleString('ja-JP'), points=n=>num(n)+' ポイント';
const lines=v=>String(v||'').split('\n').map(s=>s.trim()).filter(Boolean), date=v=>v?new Date(v).toLocaleString('ja-JP'):'期限なし';
const url=v=>{try{const u=new URL(v);return u.protocol==='https:'?u.href:'';}catch{return '';}};
const image=v=>typeof v==='string'&&/^\/api\/products\/[\w-]+\/image$/.test(v)?v:url(v);
const btn=(text,action,id='')=>`<button type="button" class="btn-pill" data-action="${action}" data-id="${esc(id)}">${esc(text)}</button>`;
const field=(label,name,value='',type='text',required=false)=>`<label class="field-label">${esc(label)}<input name="${name}" type="${type}" value="${esc(value)}" ${required?'required':''} ${type==='number'?'min="0" step="10"':''}></label>`;
const area=(label,name,value='',required=false,placeholder='')=>`<label class="field-label">${esc(label)}<textarea name="${name}" rows="3" maxlength="4000" ${required?'required':''}${placeholder?` placeholder="${esc(placeholder)}"`:''}>${esc(value)}</textarea></label>`;
const form=(action,body,submit='保存する',id='')=>`<form class="proposal-form" data-form="${action}" data-id="${esc(id)}">${body}<button class="btn-primary" type="submit">${submit}</button></form>`;
const empty=text=>`<p class="empty-note">${esc(text)}</p>`;
const labels={pending:'返事待ち',approved:'承認済み',rejected:'見送り・差し戻し',submitted:'確認待ち',completed:'完了',paid:'報酬反映済み',draft:'下書き',agreed:'合意済み',superseded:'更新済み',open:'相談中',active:'取り組み中',assigned:'取り組み中',available:'取り組み中',in_progress:'取り組み中',revision_requested:'修正依頼',closed:'終了',purchased:'購入済み',expired:'期限切れ'};
const status=v=>labels[v]||v||'';
// Child screens (home / chores) use hiragana labels instead of kanji.
const kidLabels={pending:'へんじまち',approved:'OK！',rejected:'みおくり',submitted:'かくにんまち',completed:'おわり',paid:'ポイントもらったよ',draft:'したがき',agreed:'きまったよ',superseded:'あたらしくなったよ',open:'そうだんちゅう',active:'とりくみちゅう',assigned:'とりくみちゅう',available:'とりくみちゅう',in_progress:'とりくみちゅう',revision_requested:'なおしてね',closed:'おわり',purchased:'かったよ',expired:'きげんぎれ'};
const kidStatus=v=>parent()?status(v):kidLabels[v]||status(v);
const kid=(adult,child)=>parent()?adult:child;
// Approved / rejected chores also get an icon on the child screen.
const childChoreLabels={approved:['🎉','ごうかく！'],rejected:['😢','みおくり・さしもどし']};
const choreLabel=v=>{const c=!parent()&&childChoreLabels[v];return c?`<span class="chore-status-icon" aria-hidden="true">${c[0]}</span>${esc(c[1])}`:esc(kidStatus(v));};
const reloadBtn=()=>'';
const choreTone=v=>['approved','completed','paid'].includes(v)?'is-approved':['rejected','revision_requested'].includes(v)?'is-rejected':v==='submitted'?'is-waiting':'';
const state={session:null,childId:null,dashboard:null,chat:null,proposal:null,busy:false,loading:true,canNegotiate:false,epoch:0,dirty:false,routeHash:location.hash,invitation:null,goalOrder:[],pairingId:sessionStorage.getItem('pairingRequestId')};
const parent=()=>state.session?.user?.role==='parent';
const pairingMonitor={checking:false,dismissed:new Set(),request:null,focus:null};
function closePairingDialog(){
 const dialog=$('#pairing-dialog');
 if(dialog?.open)dialog.close();
 pairingMonitor.request=null;
 pairingMonitor.focus?.focus?.();pairingMonitor.focus=null;
}
function showPairingDialog(request){
 const dialog=$('#pairing-dialog');if(!dialog||dialog.open)return;
 pairingMonitor.request=request;pairingMonitor.focus=document.activeElement;
 dialog.innerHTML=`<h2 id="pairing-title">子どもの端末を承認</h2><p id="pairing-description">${esc(request.childDisplayName)}の端末から接続申請が届きました。子どもの画面に表示されている6桁の確認番号を入力してください。</p><p>期限：${esc(date(request.expiresAt))}</p><p id="pairing-error" class="form-error" role="alert"></p>${form('pair-respond-modal',`<label class="field-label">6桁の確認番号<input name="confirmationCode" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="off" required autofocus></label>`,'この端末を承認する',request.pairingRequestId)}<div class="pairing-actions">${btn('この申請を拒否する','pairing-reject',request.pairingRequestId)}</div>`;
 dialog.showModal();
}
async function checkPairingRequests(){
 if(pairingMonitor.checking||state.busy||document.visibilityState==='hidden')return;
 if(!parent()||(!state.session?.authenticated&&!state.pairingId)||state.session?.user?.onboardingCompleted===false){closePairingDialog();return;}
 pairingMonitor.checking=true;const session=state.session;
 try{
  const data=await API.request('/pairing/requests');
  if(state.session!==session||!parent())return;
  const pending=(data.requests||[]).filter(r=>r.status==='pending'&&Date.parse(r.expiresAt)>Date.now());
  const ids=new Set(pending.map(r=>r.pairingRequestId));
  for(const id of pairingMonitor.dismissed)if(!ids.has(id))pairingMonitor.dismissed.delete(id);
  if(pairingMonitor.request&&!ids.has(pairingMonitor.request.pairingRequestId))closePairingDialog();
  if(!state.busy){const next=pending.find(r=>!pairingMonitor.dismissed.has(r.pairingRequestId));if(next)showPairingDialog(next);}
 }catch(e){if(e.status===401)closePairingDialog();}
 finally{pairingMonitor.checking=false;}
}
async function respondPairingDialog(id,decision,confirmationCode){
 if(pairingMonitor.request?.pairingRequestId!==id)return;
 await API.request('/pairing/requests/'+path(id)+'/responses','POST',{decision,...(decision==='approved'?{confirmationCode}:{})});
 pairingMonitor.dismissed.add(id);closePairingDialog();
 notice(decision==='approved'?'端末を承認しました。子どもの端末に承認が自動で届きます。「接続を完了する」を押してください。':'接続申請を拒否しました。');
}
function notice(text='',error=false){$('#notice').textContent=text;$('#notice').className=error?'global-notice form-error':'global-notice';}
const viewCache=new Map();let cacheSession=null,backgroundEpoch=null,refreshPending=false,lastRendered=null,composing=false;
function viewKey(){if(cacheSession!==state.session){viewCache.clear();cacheSession=state.session;}return (state.childId||'')+'|'+location.hash;}
function rememberView(html){if(state.session?.authenticated&&html){viewCache.set(viewKey(),{html,chat:state.chat,proposal:state.proposal,dashboard:state.dashboard,chatThreads:state.chatThreads,canNegotiate:state.canNegotiate});if(viewCache.size>24)viewCache.delete(viewCache.keys().next().value);}}
function captureView(){
 const content=$('#content'),fields=[...(content.querySelectorAll?.('input,textarea,select')||[])];
 const key=e=>{const f=e.closest?.('form');return [f?.dataset.form||'',f?.dataset.id||'',e.name||e.id].join('|');};
 const values=new Map(fields.map(e=>[key(e),{value:e.value,checked:e.checked,focused:document.activeElement===e,gradeInitialized:e.dataset?.gradeInitialized,start:e.selectionStart,end:e.selectionEnd}]));
 const scroll=[...(content.querySelectorAll?.('.chat-scroll-area,textarea')||[])].map(e=>({top:e.scrollTop,left:e.scrollLeft}));
 const details=[...(content.querySelectorAll?.('details')||[])].map(e=>e.open),dirty=state.dirty,top=window.scrollY,left=window.scrollX;
 return ()=>{for(const e of content.querySelectorAll?.('input,textarea,select')||[]){const v=values.get(key(e));if(!v)continue;if(e.value!==v.value)e.value=v.value;if(v.checked!==undefined&&e.checked!==v.checked)e.checked=v.checked;if(v.gradeInitialized!==undefined&&e.dataset)e.dataset.gradeInitialized=v.gradeInitialized;if(v.focused){e.focus?.({preventScroll:true});if(typeof v.start==='number'&&e.setSelectionRange){try{e.setSelectionRange(v.start,v.end);}catch{}}}}
 [...(content.querySelectorAll?.('details')||[])].forEach((e,i)=>{if(details[i]!==undefined)e.open=details[i];});
 [...(content.querySelectorAll?.('.chat-scroll-area,textarea')||[])].forEach((e,i)=>{if(scroll[i]){e.scrollTop=scroll[i].top;e.scrollLeft=scroll[i].left;}});state.dirty=dirty;window.scrollTo?.({left,top,behavior:'instant'});};
}
function render(html){
 const content=$('#content'),preserve=backgroundEpoch===state.epoch;
 // Native date inputs expose an empty value while only some date segments are entered.
 // Keeping the original element is the only way to preserve those segments and the date picker.
 if(preserve&&(composing||document.activeElement?.matches?.('input[type="date"]')||[...(content.querySelectorAll?.('input[type="date"]')||[])].some(e=>e.validity?.badInput)))return;
 state.loading=false;content.setAttribute('aria-busy','false');
 if(preserve&&lastRendered===html){rememberView(html);return;}
 const restore=preserve?captureView():null;if(!preserve)state.dirty=false;
 content.classList?.remove('chat-layout-fixed-v2','chat-layout-v3');content.innerHTML=html;lastRendered=html;restore?.();rememberView(html);
}
function loading(){render('');state.loading=true;$('#content').setAttribute('aria-busy','true');}
function nav(){ if(!parent())closePairingDialog();const roleLabel=$('#role-label');roleLabel.hidden=!state.session?.authenticated;roleLabel.textContent=state.session?.authenticated?(parent()?'保護者の画面':'子どもの画面'):'';$('#demo-tools').hidden=!state.session?.demo;$('#navigation').hidden=!state.session?.authenticated;$('#navigation').innerHTML=navLink('#home','home','ホーム')+(!parent()||state.canNegotiate?navLink('#conversations','chat',parent()?'親子で相談':'ぽぽにそうだん'):'')+navLink('#settings','gear',parent()?'設定':'じぶんの設定'); }
// Line icons for the bottom bar: house, hand, speech bubble, gear.
const navIcons={
 home:'<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
 hand:'<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
 chat:'<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
 gear:'<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'
};
const navLink=(href,icon,text)=>`<a href="${href}"><svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${navIcons[icon]}</svg><span>${esc(text)}</span></a>`;
function product(p,action=''){
 if(!p)return '';const src=image(p.imageUrl)||(p.id?'/api/products/'+encodeURIComponent(p.id)+'/image':''),target=url(p.productUrl);
 return `<article class="product-card"><div class="product-visual">${src?`<img class="product-image" src="${esc(src)}" alt="${esc(p.name)}" loading="lazy" referrerpolicy="no-referrer"><span class="image-fallback" hidden>${kid('画像を取得できません','しゃしんを ひょうじできません')}</span>`:`<span class="image-fallback">${kid('画像を取得できません','しゃしんを ひょうじできません')}</span>`}</div><div class="product-info"><h3 class="product-name">${esc(p.name)}</h3><p class="product-price">${p.priceJpy==null?kid('価格未確認','ねだんは まだ かくにんできていません'):num(p.priceJpy)+'円'}</p>${parent()&&target?`<a class="product-link" href="${esc(target)}" target="_blank" rel="noopener noreferrer">出典で確認 ↗</a>`:''}${action?btn(kid('この商品を選ぶ','これにする'),action,p.id):''}</div></article>`;
}
function welcome(){nav();render(`<div class="welcome"><span class="welcome-label">きみの「できた！」が、羽ばたく。</span><div class="welcome-dove dove" aria-hidden="true"></div><h1 class="tagline">がんばりと「ほしい」を、<br>親子でつなぐ。</h1></div><div class="start-actions"><a class="btn-start btn-start-parent login-link" href="/api/auth/google/start">🏡 Googleで保護者ログイン</a><details><summary>🌱 子どもの端末をつなぐ</summary><p>おうちの人から招待コードを受け取るか、招待QRを読み取ってください。</p>${form('pair-code',field('招待コード','invitationToken','','text',true),'接続をお願いする')}</details>${state.pairingId?btn('接続申請の続きを確認','pairing-check'):''}</div>`);}
function selector(children){return children?.length?`<label class="field-label">子ども<select id="child-selector">${children.map(c=>`<option value="${esc(c.childId)}" ${c.childId===state.childId?'selected':''}>${esc(c.displayName)}</option>`).join('')}</select></label>`:'';}
function goals(d){const list=(d.goals||[]).filter(g=>g.status!=='purchased'),initial=[...list].sort((a,b)=>({large:0,medium:1,small:2}[a.size]??3)-({large:0,medium:1,small:2}[b.size]??3));state.goalOrder=state.goalOrder.filter(id=>list.some(g=>g.id===id));for(const item of initial)if(!state.goalOrder.includes(item.id))state.goalOrder.push(item.id);const ordered=state.goalOrder.map(id=>list.find(g=>g.id===id)),g=ordered[0];if(!g)return empty(parent()?'親子で商品提案に合意すると、目標がここに届きます。':'おやごさんがりょうかいしてくれると、もくひょうがここに表示されます。');return `<article class="goal-main">${product({...g,priceJpy:g.targetAmountYen})}<p>あと ${points(Math.max(0,g.targetAmountYen-d.balanceYen))}</p><p>${d.balanceYen>=g.targetAmountYen?kid('目標に届きました！','もくひょうに とどいたよ！'):d.weeklyPaceYen>0?kid('最近のペースなら、あと約'+num(Math.ceil((g.targetAmountYen-d.balanceYen)*7/d.weeklyPaceYen))+'日（目安）','いまのペースなら、あと '+num(Math.ceil((g.targetAmountYen-d.balanceYen)*7/d.weeklyPaceYen))+'にちくらい'):kid('お手伝いの実績がたまると、達成までの目安が出ます。','おてつだいを つづけると、あと なんにちで とどくか わかるよ。')}</p><progress max="${Math.max(1,g.targetAmountYen)}" value="${Math.min(d.balanceYen,g.targetAmountYen)}" aria-label="${kid('目標までの進み具合','もくひょうまでの すすみぐあい')}"></progress>${parent()?btn('購入済みにする','purchase',g.id):''}</article><div class="goal-subs">${ordered.slice(1,3).map(x=>`<button type="button" class="goal-sub" data-action="feature-goal" data-id="${esc(x.id)}">${image(x.imageUrl)?`<img src="${esc(image(x.imageUrl))}" alt="" loading="lazy">`:''}<span>${esc(x.name)}<br>${points(x.targetAmountYen)}</span></button>`).join('')}</div>`;}
async function dashboard(){const d=await api('/dashboard'+(state.childId?'?childId='+encodeURIComponent(state.childId):''));state.dashboard=d;state.childId=d.childId;return d;}
const childName=d=>d.children?.find(c=>c.childId===d.childId)?.displayName||'子ども';
const noChild=d=>parent()&&!d.childId?empty('子ども一覧から子どもを登録してください。'):'';
// Home shows only the points and the wish list.
async function home(){
 const d=await dashboard();
 render(`<h1 class="page-title">${esc(parent()?childName(d):state.session.user.displayName)}${parent()?'の目標・お手伝い':'、おかえり！'}</h1>${parent()?selector(d.children):''}${noChild(d)}<div class="points-oval"><span class="points-label">ありがとうポイント</span><span class="points-value">${num(d.balanceYen)}<small>pt</small></span></div><p class="pace">${kid('1ポイント＝1円 ・これまで ','1ポイント＝1えん ・これまでに もらった：')}${points(d.lifetimeEarnedYen)}${parent()?`<br>最近の週平均：${points(d.weeklyPaceYen)}`:''}</p><section><h2>${kid('おねがいと返事','おねがいと おへんじ')}</h2>${proposalCards(d.proposals)}</section><section class="goals"><h2>${parent()?'子どもの目標':'ほしいもの'}</h2>${goals(d)}</section><a class="btn-pill login-link" href="#chores">${kid('お手伝いを確認する','おてつだいを みる')}</a>${reloadBtn()}`);
}
// Chores, chore requests and product proposals live on their own screen.
async function chores(){
 const d=await dashboard();
 render(`<h1 class="page-title">${parent()?esc(childName(d))+'のお手伝い':'おてつだい'}</h1>${parent()?selector(d.children):''}${noChild(d)}<section class="tasks"><h2>${kid('お手伝い','おてつだい')}</h2>${(d.chores||[]).map(c=>`<article class="flow-card chore-card ${choreTone(c.status)}"><span class="chore-status">${choreLabel(c.status)}</span><h3>${esc(c.title)}</h3><p>${esc(c.description)}</p><strong>${points(c.rewardAmountYen)}</strong>${c.dueAt?(parent()?`<p>期限 ${esc(date(c.dueAt))}</p>`:`<p>きげん ${esc(date(c.dueAt))} まで</p>`):''}${c.submissionNote?`<p>${kid('完了報告','できたこと')}：${esc(c.submissionNote)}</p>`:''}${c.reviewComment?`<p>${parent()?'確認コメント':'おうちのひとから'}：${esc(c.reviewComment)}</p>`:''}${!parent()&&['assigned','rejected'].includes(c.status)?form('submit-chore',area('できたこと（かかなくてもOK）','note'),'できた！を しらせる',c.id):''}${parent()&&c.status==='submitted'?form('review-chore',`<label>確認結果<select name="decision"><option value="approved">完了を承認し、ポイントを渡す</option><option value="rejected">やり直しをお願いする</option></select></label>${area('ひとこと（差し戻し時は必須）','reason')}`,'この内容で返事する',c.id):''}</article>`).join('')||empty(kid('お手伝いはまだありません。','おてつだいは まだ ないよ。'))}${d.childId?(parent()?`<details><summary>＋ お手伝いをお願いする</summary>${form('create-chore',field('やること','title','','text',true)+area('説明','description')+field('ありがとうポイント（10単位）','rewardAmountYen','','number',true)+field('期限（任意）','dueAt','','date'),'依頼する')}</details>`:form('create-request',field('やってみたいおてつだい','title','','text',true)+area('ひとこと','note'),'おうちのひとに つたえる')):''}</section><section><h2>${kid('お手伝いの提案','やってみたい おてつだい')}</h2>${(d.choreRequests||[]).map(r=>`<article class="flow-card"><h3>${esc(r.title)}</h3><p>${esc(r.note)}</p><p>${esc(kidStatus(r.status))}${r.rewardAmountYen!=null?' ・'+points(r.rewardAmountYen):''}</p>${r.reason?`<p>${esc(r.reason)}</p>`:''}${parent()&&r.status==='pending'?form('respond-request',`<label>返事<select name="decision"><option value="approved">条件を決めてお願いする</option><option value="rejected">今回は見送る</option></select></label>${field('やること','title',r.title,'text',true)}${field('ありがとうポイント（10単位）','rewardAmountYen','','number')}${field('期限（任意）','dueAt','','date')}${area('理由（見送り時は必須）','reason')}`,'返事する',r.id):''}</article>`).join('')||empty(kid('お手伝いの提案はまだありません。','まだ ないよ。'))}</section><section><h2>${kid('商品の提案','ほしいものの おねがい')}</h2>${(d.proposals||[]).map(v=>`<article class="flow-card">${product(v.product)}<p>${esc(kidStatus(v.proposal.status))} ・${kid('第'+v.proposal.version+'版',v.proposal.version+'かいめ')}</p>${btn(kid('提案を確認','みてみる'),'proposal',v.proposal.id)}</article>`).join('')||empty(kid('商品の提案はまだありません。','まだ ないよ。'))}</section>${reloadBtn()}`);
}
function proposalStatus(v){
 const p=v.proposal;
 if(p.status==='agreed')return kid('目標に登録済み','もくひょうになったよ！');
 if(v.negotiationStatus==='closed')return kid('今回は見送り','こんかいは みおくり');
 if(v.canConsult)return kid('購入について相談中','かうか そうだんちゅう');
 if(p.status==='pending')return v.canRespond?kid('返事をしてください','へんじを してね'):kid('相手の返事待ち','おうちのひとの へんじまち');
 return kidStatus(p.status);
}
function proposalCards(list=[]){
 const seen=new Set();
 return list.filter(v=>{const key=v.proposal.negotiationId||v.proposal.id;if(v.proposal.status==='superseded'||seen.has(key))return false;seen.add(key);return true;}).map(v=>`<article class="flow-card"><h3>${esc(v.childDisplayName||'')}${v.childDisplayName?'の':''}${esc(v.product?.name||'おねがい')}</h3><p>${esc(proposalStatus(v))}</p>${v.negotiationResult?.reason?`<p>${esc(v.negotiationResult.reason)}</p>`:''}${btn(kid(v.canRespond?'内容を確認して返事する':'内容を確認する','おねがいを みる'),'proposal',v.proposal.id)}${v.canConsult?btn(kid('親子とぽぽで相談する','おうちのひとと そうだんする'),'open-negotiation',v.negotiationId):''}</article>`).join('')||empty(kid('子どもから届いたおねがいはまだありません。','まだ おねがいは ないよ。'));
}
async function receivedProposals(){
 const d=await api('/proposals/received'),list=d.proposals||[];
 state.canNegotiate=list.some(v=>v.canConsult);nav();return list;
}
async function requests(){
 const list=parent()?await receivedProposals():(await dashboard()).proposals;
 render(`<a class="back-link" href="#home">← ホーム</a><h1>${kid('届いたおねがい','おねがいと おへんじ')}</h1>${proposalCards(list)}${reloadBtn()}`);
}
function chatProducts(d,active,shared){
 if(!d.products?.length||shared)return '';
 const selected=d.products.find(p=>p.id===d.selectedProductId);
 const candidates=`<section class="product-list">${d.products.map(p=>product(p,active?'select-product':'')).join('')}</section>`;
 return selected?`<details class="selected-product-details"><summary>えらんだものを みなおす・えらびなおす</summary>${candidates}</details>`:candidates;
}
function chatNextStep(d,active,shared){
 if(shared)return parent()&&active?form('decide-negotiation',`<label class="field-label">相談の結論<select name="decision"><option value="approved">購入をOKする</option><option value="rejected">今回は見送る</option></select></label>${area('ひとこと（見送るときは理由を書いてください）','reason')}`,'この結論を伝える',d.negotiationId):'';
 const p=d.currentProposal,matching=p&&p.productId===d.selectedProductId;
 if(p&&p.status!=='draft')return btn('おねがいと おへんじを みる','proposal',p.id);
 if(d.reasonSummary&&!d.reasonConfirmed)return `<section class="reason-confirmation">${btn('そう！ このりゆうでOK','confirm-reason')}<p>ちがうときは、ぽぽに おしえてね。</p></section>`;
 if(matching&&d.reasonConfirmed)return `<section class="flow-card"><p>おうちのひとに おくるものを かくにんしよう。</p>${btn('おくるまえに かくにんする','proposal',p.id)}</section>`;
 return '';
}
async function conversations(){
 if(parent()){const list=await receivedProposals();render('<h1>親子とぽぽで相談</h1><p>購入について相談するおねがいを選んでください。</p>'+proposalCards(list.filter(v=>v.canConsult))+`<a class="btn-pill" href="#requests">届いたおねがいを確認する</a>${reloadBtn()}`);return;}
 const children=[];

 const [d,n]=await Promise.all([
  api('/conversations'+(parent()?'?childId='+encodeURIComponent(state.childId):'')),
  api('/negotiations')
 ]);

 const conversations=[...(d.conversations||[])].sort(
  (a,b)=>new Date(b.updatedAt||0)-new Date(a.updatedAt||0)
 );
 const negotiations=(n.negotiations||[]).filter(
  x=>!parent()||x.childId===state.childId
 );

 state.chatThreads={conversations,negotiations,children};

 const latest=conversations[0];

 if(latest){
  const id=encodeURIComponent(latest.conversationId);
  return chat(latest.conversationId);
 }

 const created=await api(
  '/conversations',
  'POST',
  parent()&&state.childId?{childId:state.childId}:{}
 );
 const id=encodeURIComponent(created.conversationId);
 return chat(created.conversationId);
}

function chatSwitcher(){
 const threads=state.chatThreads;
 if(!threads)return '';

 const personal=threads.conversations.map(
  (c,i)=>btn(
   i===0?'最近の相談':'過去の相談 '+(i+1),
   'open-chat',
   c.conversationId
  )
 ).join('');

 const shared=threads.negotiations.map(
  (n,i)=>btn(
   '親子で共有するチャット '+(i+1),
   'open-negotiation',
   n.negotiationId
  )
 ).join('');

 return `<details class="chat-switcher">
  <summary>チャットを切り替える</summary>
  <p>個別相談は本人だけに表示されます。共有チャットは親子に公開されます。</p>
  ${parent()?selector(threads.children):''}
  ${btn('新しい個別相談を準備する','new-chat')}
  ${personal}
  ${shared||'<p>共有チャットはまだありません。</p>'}
 </details>`;
}

const chatPath=()=>state.chat.mode==='negotiation'?'/negotiations/'+path(state.chat.negotiationId):'/conversations/'+path(state.chat.conversationId);
function chatMessage(m){
 const assistant=m.sender==='assistant', own=m.own??m.sender==='user';
 const label=assistant?'ぽぽ':m.sender==='parent'?'保護者':m.sender==='child'?'子ども':'あなた';
 const bubble=`<article class="chat-message ${assistant?'assistant':own?'person':'participant'}"><small>${label}</small><p>${esc(m.content)}</p></article>`;
 return assistant?`<div class="assistant-message"><span class="dove message-avatar" aria-hidden="true"></span>${bubble}</div>`:bubble;
}
function renderChat(d){
 state.chat=d;
 const shared=d.mode==='negotiation', active=d.canMessage===true;
 const intro=shared?'ここでは、おうちの人といっしょに、この商品を買ってよいか相談しよう。ぽぽが話を整理するよ。ここでのお話は親子で見られるよ。':parent()?'ぽぽです。お子さんの目標に関する購入条件を一緒に整理します。この個別相談はあなたにだけ表示されます。':'ぽぽだよ。ほしいものや、その理由を一緒に整理しよう。この個別相談はあなたにだけ見えるよ。';
 // The composer label is visually hidden, so the same text is shown as a placeholder.
 const messageLabel=shared?kid('親子に公開するメッセージ','おうちのひとにも みえる メッセージ'):'ぽぽへのメッセージ';
 const selected=d.products?.find(p=>p.id===d.selectedProductId);
 render(`${selected?`<div class="chat-selected-title">${esc(selected.name)}</div>`:''}${parent()&&state.chatThreads?.children?.length?`<div class="chat-child-toggle" role="group" aria-label="子どもを選択">${state.chatThreads.children.map(c=>`<button type="button" data-action="select-chat-child" data-id="${esc(c.childId)}" aria-pressed="${c.childId===state.childId}">${esc(c.displayName)}</button>`).join('')}</div>`:''}<div class="chat-scroll-area"><div class="chat-log">${chatMessage({sender:'assistant',content:intro})}${(d.messages ?? []).map(chatMessage).join('')}</div>${shared?`<section class="shared-context"><h2>${esc(d.proposalView?.product?.name||d.products?.find(p=>p.id===d.currentProposal?.productId)?.name||'そうだんするもの')}</h2><p>ほしい りゆう：${esc(d.currentProposal?.persuasionText)}</p>${d.proposalView?.negotiationResult?.reason?`<p>おうちの人の おへんじ：${esc(d.proposalView.negotiationResult.reason)}</p>`:''}</section>`:''}${!shared&&d.phase==='negotiation'&&d.negotiationId?btn('共有交渉へ進む','open-negotiation',d.negotiationId):''}${chatProducts(d,active,shared)}${chatNextStep(d,active,shared)}</div><div class="chat-fixed-footer"><div class="chat-actions">${active&&!shared?btn('🔎 そろそろ商品を探す','search-product-now'):''}${!parent()?`<button type="button" class="btn-pill new-chat-btn" data-action="new-chat">＋ あたらしく はなす</button>`:''}</div>${active?form('message',area(messageLabel,'message','',true,messageLabel),kid('送信する','おくる')):empty(d.phase==='awaiting_response'?kid('子どもからの購入確認への返事を待っています。','おうちのひとの おへんじを まっているよ。'):d.phase==='closed'?kid('この相談は終了しました。履歴を確認できます。','この おはなしは おわったよ。'):d.phase==='negotiation'&&!shared?'つづきは、おうちのひとと いっしょに そうだんしよう。':'')}</div>`);
 $('#content').classList?.add('chat-layout-v3');
 const scroller=$('.chat-scroll-area');
 if(scroller&&backgroundEpoch!==state.epoch)scroller.scrollTop=scroller.scrollHeight;
}
async function chat(id){
 if(parent())return conversations();
 const key=encodeURIComponent(id);
 let detail=await api('/conversations/'+key);
 if(detail.phase==='not_started')detail=await api('/conversations/'+key+'/start','POST',{});
 renderChat(detail);
}
async function negotiation(id){renderChat(await api('/negotiations/'+encodeURIComponent(id)));}
async function proposal(id){
 const v=await api('/proposals/'+encodeURIComponent(id)),p=v.proposal;state.proposal=v;
 if(parent()&&v.canConsult){state.canNegotiate=true;nav();}
 const prod=v.product||state.chat?.products?.find(x=>x.id===p.productId);
 const draft=p.status==='draft'&&v.canEdit!==false;
 render(`<a class="back-link" href="${draft?'#conversations':'#home'}">← ${kid('戻る','もどる')}</a><h1>${draft?'おくるまえに かくにんしよう':kid('子どもからのおねがい','おねがいと おへんじ')}</h1>${product(prod)}<p>${esc(proposalStatus(v))}</p><section class="review-text"><h2>${kid('ほしい理由','ほしい りゆう')}</h2><p>${esc(p.persuasionText)}</p></section>${draft?`<p>この商品と理由を送って、買ってよいか確認するよ。ぽぽとの個別の会話は共有しません。</p>${btn('おうちのひとに おくる','send-proposal',p.id)}<a class="btn-pill" href="#conversations">ぽぽと もうすこし はなす</a>`:''}${p.status==='pending'&&v.canRespond?form('respond-proposal',`<p>お手伝いでポイントを貯めて、この商品を買ってよいですか？</p><label class="field-label">購入への返事<select name="decision"><option value="approved">OK・目標に登録する</option><option value="revision_requested">まだOKできない・親子で相談する</option></select></label>${area('OKできない理由・相談したいこと','reason')}`,'この返事を伝える',p.id):''}${v.negotiationResult?.reason?`<p class="flow-card">${kid('返事の理由','おうちのひとの おへんじ')}：${esc(v.negotiationResult.reason)}</p>`:''}${v.canConsult?btn(kid('親子とぽぽで相談する','おうちのひとと そうだんする'),'consult-proposal',p.id):''}${p.status==='agreed'?'<p>目標に登録しました。お手伝いでポイントを貯めていこう。</p><a class="btn-primary" href="#home">ホームで目標を見る</a>':''}${v.negotiationStatus==='closed'?'<p>今回は見送りになりました。</p><a class="btn-pill" href="#home">ホームへ戻る</a>':''}`);
}

const gender=(value=null)=>`<label class="field-label">性別<select name="gender"><option value="">回答しない</option><option value="male" ${value==='male'?'selected':''}>男性</option><option value="female" ${value==='female'?'selected':''}>女性</option><option value="other" ${value==='other'?'selected':''}>その他</option></select></label>`;
const gradeLabel=n=>!n?'その他':n<=6?'小学'+n+'年':n<=9?'中学'+(n-6)+'年':'高校'+(n-9)+'年';
const grade=(value='',initialized=false)=>`<label class="field-label">学年<select name="gradeLevel" data-grade-initialized="${initialized?'true':'false'}"><option value="">その他</option>${Array.from({length:12},(_,i)=>i+1).map(n=>`<option value="${n}" ${n===Number(value)?'selected':''}>${gradeLabel(n)}</option>`).join('')}</select></label>`;
function schoolYear(now=new Date()){const today=now.toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'});return Number(today.slice(0,4))-(today.slice(5,7)<'04'?1:0);}
function inferGradeFromBirthDate(value,now=new Date()){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return null;
 const birth=new Date(value+'T00:00:00Z'),today=now.toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'});
 if(!Number.isFinite(birth.getTime())||birth.toISOString().slice(0,10)!==value||value>today)return null;
 const birthYear=Number(value.slice(0,4));if(birthYear<Number(today.slice(0,4))-120)return null;
 const entranceYear=birthYear+6+(value.slice(5)>'04-01'?1:0),level=schoolYear(now)-entranceYear+1;
 return level>=1&&level<=12?String(level):'';
}
function fillGradeOnce(input){
 const form=input.closest?.('form[data-form="create-child"],form[data-form="child-info"]'),select=form?.querySelector?.('select[name="gradeLevel"]');
 if(!select||select.dataset.gradeInitialized==='true')return;
 // A value already chosen before the date is entered also takes precedence.
 if(select.value){select.dataset.gradeInitialized='true';return;}
 const value=inferGradeFromBirthDate(input.value);if(value===null)return;
 select.value=value;select.dataset.gradeInitialized='true';
}
function childFields(c={}){return field('ニックネーム','displayName',c.displayName||'','text',true)+field('誕生日','birthDate',c.birthDate||'','date',true)+gender(c.gender)+grade(c.gradeLevel,!!c.childId);}
async function onboarding(){const p=await api('/profile');render(`<h1>はじめまして</h1><p>${parent()?'保護者の情報を入力してください。':'好きなことを、ぽぽに教えてね。名前はおうちの人が登録しています。'}</p>${form('onboarding',parent()?field('お名前','displayName',p.displayName,'text',true)+field('誕生日','birthDate',p.birthDate||'','date',true)+gender(p.profile?.gender):area('好きなこと（1行に1つ）','interests',(p.profile?.preferences?.interests||[]).join('\n'),true),'はじめる')}`);}
async function children(){
 if(!parent())return home();const [d,received]=await Promise.all([api('/children'),receivedProposals()]);state.childRecords=d.children;
 render(`<section><h1>届いたおねがい</h1>${proposalCards(received)}</section><h1>子ども一覧</h1>${d.children.map(c=>`<article class="flow-card"><h2>${esc(c.displayName)}</h2><p>${esc(gradeLabel(c.gradeLevel))}</p>${c.hasCompletedPairing===false?`<p>端末の接続を完了すると登録が完了します。</p>${btn('登録を続ける','invite',c.childId)}${btn('この登録を削除する','delete-child',c.childId)}`:`${btn('目標・お手伝いを確認','child-home',c.childId)}${btn('情報・購入条件を変更','child-settings',c.childId)}${c.hasLinkedDevice?'':btn('端末をつなぎ直す','invite',c.childId)}`}</article>`).join('')||empty('子どもを登録して、はじめましょう。')}<details ${d.children.length?'':'open'}><summary>＋ 子どもを登録する</summary>${form('create-child',childFields(),'登録する')}</details>`);
}
async function childSettings(id){const [list,s]=await Promise.all([api('/children'),api('/children/'+encodeURIComponent(id)+'/settings')]);const c=list.children.find(x=>x.childId===id);if(!c)throw new Error('子どもが見つかりません。');state.childRecords=list.children;render(`<a href="#children">← 子ども一覧</a><h1>${esc(c.displayName)}の設定</h1>${form('child-info',childFields(c),'子どもの情報を保存',id)}${form('child-settings',area('購入の条件（1行に1つ）','mustHave',(s.constraints?.mustHave||[]).join('\n'))+area('避けたいもの（1行に1つ）','mustAvoid',(s.constraints?.mustAvoid||[]).join('\n')),'条件を保存',id)}${btn('端末をつなぎ直す','invite',id)}<section class="history-reset"><h2>子どもの登録を削除</h2><p>この子の会話・目標・お手伝い・ポイント・端末接続も削除します。元に戻せません。</p>${btn('この子どもの登録・履歴を削除する','delete-child',id)}</section>`);}
async function settings(){if(!parent()){const p=await api('/profile');return render(`<h1>じぶんの設定</h1><p>${esc(p.displayName)}の好きなことを更新できるよ。</p>${form('child-profile',area('好きなこと（1行に1つ）','interests',(p.profile?.preferences?.interests||[]).join('\n')),'保存する')}`);}const [p,devices]=await Promise.all([api('/profile'),api('/devices')]);render(`<h1>保護者の設定</h1>${form('profile',field('お名前','displayName',p.displayName,'text',true)+field('誕生日','birthDate',p.birthDate||'','date',true)+gender(p.profile?.gender))}<section><h2>接続中の端末</h2>${devices.devices.map(d=>`<article class="flow-card"><h3>${d.childDisplayName?esc(d.childDisplayName)+'：':''}${esc(d.deviceLabel)}${d.isCurrent?'（この端末）':''}</h3><p>${esc(date(d.lastActiveAt))}</p>${d.isCurrent?btn('この端末からログアウト','logout'):btn('この接続を解除','revoke-device',d.deviceSessionId)}</article>`).join('')}</section><section class="history-reset"><h2>履歴の全消去</h2><p>家族全員の会話・おねがい・目標・お手伝い・ポイントをすべて消去します。アカウント・家族登録・設定・端末接続は残ります。消去した履歴は元に戻せません。</p>${btn('履歴をすべて消去する','clear-history')}</section>`);}
function invitation(id){const d=state.invitation;if(!d||d.childId!==id)return render(`<a href="#children">← 子ども一覧</a><p>招待を表示するには、子ども一覧から招待を発行してください。</p>`);if(d.connected)return render('<h1>端末の接続が完了しました</h1><p>子どもの端末で、ぽぽとの相談を始められます。</p><a class="btn-primary" href="#children">子ども一覧へ</a>');const src=typeof d.qrDataUrl==='string'&&d.qrDataUrl.startsWith('data:image/png;base64,')?d.qrDataUrl:'';render(`<a href="#children">← 子ども一覧</a><h1>子どもの端末をつなぐ</h1><p>子どもの端末でQRを読み取るか、最初の画面で招待コードを入力してください。</p>${src?`<img class="pair-qr" src="${esc(src)}" alt="子どもの端末で読み取る招待QR">`:''}<p class="confirmation-code">${esc(d.invitationToken)}</p><p>期限：${esc(date(d.expiresAt))}</p>`);}
async function pair(token){if(state.session?.authenticated)throw new Error('ログイン中です。子どもの別端末または別ブラウザーで招待を開いてください。');token=token.normalize('NFKC').replace(/[\s-]/g,'').toUpperCase();if(!/^[A-Z2-9]{12}$/.test(token))throw new Error('招待コードは12文字の英数字です。6桁の確認番号とは異なります。');await api('/pairing/session','POST',{invitationToken:token});const p=await api('/pairing/requests','POST',{invitationToken:token});state.pairingId=p.pairingRequestId;sessionStorage.setItem('pairingRequestId',p.pairingRequestId);pairView(p);}
function pairView(p){render(`<h1>おうちの人に確認してもらおう</h1><p>${esc(p.childDisplayName)}の端末として接続します。</p><p class="confirmation-code">${esc(p.confirmationCode)}</p><p>保護者に、この6桁の確認番号を入力して承認してもらってください。</p><p>${esc(status(p.status))} ・期限 ${esc(date(p.expiresAt))}</p>${p.status==='approved'?btn('接続を完了する','pairing-complete'):p.status==='pending'?'<p>保護者の承認を待っています。</p>':'<a href="#start">新しい招待ではじめる</a>'}`);}
async function route(){if(backgroundEpoch!==state.epoch)notice();nav();if(!state.session?.authenticated){if(state.pairingId&&location.hash==='#pairing'){await api('/pairing/session','POST',{});return pairView(await api('/pairing/requests/'+encodeURIComponent(state.pairingId)));}return welcome();}if(state.session.user.onboardingCompleted===false)return onboarding();const [view,id]=location.hash.slice(1).split('/');if(view==='requests')return requests();if(view==='chores')return chores();if(view==='conversations')return conversations();if(view==='conversation'&&id)return chat(id);if(view==='negotiation'&&id)return negotiation(id);if(view==='proposal'&&id)return proposal(id);if(view==='child-home'&&id&&parent()){if(state.childId!==id)state.goalOrder=[];state.childId=id;return home();}if(view==='children')return children();if(view==='child-settings'&&id&&parent())return childSettings(id);if(view==='settings')return settings();if(view==='invitation'&&id&&parent())return invitation(id);return parent()?children():home();}
function canLeave(){return !state.dirty||confirm('提案の編集内容が未保存です。保存せず移動しますか？');}
async function go(hash){if(!canLeave())return;history.pushState(null,'',hash);return navigate();}
async function navigate(preserveScroll=false){
 state.routeHash=location.hash;const epoch=++state.epoch; backgroundEpoch=null;
 const position=preserveScroll?{left:window.scrollX,top:window.scrollY,behavior:'instant'}:null;if(!preserveScroll)window.scrollTo?.({left:0,top:0,behavior:'instant'});
 const cached=!preserveScroll&&viewCache.get(viewKey());
 if(cached){Object.assign(state,{chat:cached.chat,proposal:cached.proposal,dashboard:cached.dashboard,chatThreads:cached.chatThreads,canNegotiate:cached.canNegotiate});render(cached.html);if(/^#(?:conversation|negotiation)\//.test(location.hash))$('#content').classList?.add('chat-layout-v3');backgroundEpoch=epoch;}else if(!preserveScroll)loading();
 try{if(!state.session)await initialize();else await route();if(position&&epoch===state.epoch)window.scrollTo(position);}catch(e){if(!e.stale)await error(e);}finally{if(backgroundEpoch===epoch)backgroundEpoch=null;}
}
async function refreshVisible(){
 if(composing||refreshPending||activeOperations||state.busy||state.loading||document.visibilityState==='hidden'||(!state.session?.authenticated&&!state.pairingId)||state.session?.user?.onboardingCompleted===false)return;
 const view=location.hash.slice(1).split('/')[0];if(!['','home','children','child-home','chores','requests','conversations','conversation','negotiation','proposal','settings','pairing','invitation'].includes(view))return;
 refreshPending=true;const epoch=state.epoch;backgroundEpoch=epoch;
 try{if(view==='invitation'&&parent()&&state.invitation){const d=await api('/children');if(d.children?.find(c=>c.childId===state.invitation.childId)?.hasLinkedDevice){state.invitation.connected=true;invitation(state.invitation.childId);}}else if(view==='pairing'&&state.pairingId){pairView(await api('/pairing/requests/'+path(state.pairingId)));}else if(view==='conversations'&&!parent()&&state.chat?.conversationId){renderChat(await api('/conversations/'+encodeURIComponent(state.chat.conversationId)));}else if(view==='conversation'){renderChat(await api('/conversations/'+encodeURIComponent(location.hash.slice(1).split('/')[1])));}else await route();}
 catch(e){if(!e.stale&&e.status===401)await error(e);else if(!e.stale&&e.status===404){viewCache.clear();state.chat=null;state.proposal=null;await go('#home');}}
 finally{if(state.epoch===epoch){backgroundEpoch=null;}refreshPending=false;}
}


async function error(e){if(e.stale){if(e.completed)notice('前の画面の操作が完了しました。最新の状態に更新して確認してください。');return;}notice(e.message||'処理に失敗しました。',true);if(state.loading)render('<h1>画面を読み込めませんでした</h1><p>少し待ってから、もう一度お試しください。</p>'+btn('もう一度読み込む','reload'));if(e.code==='PAIRING_EXPIRED'){state.pairingId=null;sessionStorage.removeItem('pairingRequestId');welcome();}else if(e.status===401){state.session={authenticated:false,demo:state.session?.demo};API.clear();welcome();}if(e.code==='CSRF_INVALID')await api('/auth/session');if(['VERSION_CONFLICT','INVALID_STATE','CONFLICT'].includes(e.code))$('#notice').insertAdjacentHTML('beforeend',btn('最新の状態を確認','reload'));}
async function run(task,source){
 if(state.busy){notice('前の操作を処理中です。完了後にもう一度操作してください。');return;}
 if(backgroundEpoch===state.epoch){state.epoch++;backgroundEpoch=null;}state.busy=true;activity(1);
 const controls=source?[...(source.matches('form')?source.querySelectorAll('button,input,textarea,select'):[source])]:[];
 const disabled=controls.map(c=>c.disabled);controls.forEach(c=>c.disabled=true);
 notice();
 try{await task();}
 catch(e){if(source?.closest?.('#pairing-dialog')){$('#pairing-error').textContent=e.message||'処理に失敗しました。';}else{await error(e);$('#notice').scrollIntoView?.({block:'center',behavior:'smooth'});}}
 finally{activity(-1);state.busy=false;controls.forEach((c,i)=>c.disabled=disabled[i]);}
}
const path=id=>encodeURIComponent(id);
const due=value=>value?new Date(value+'T23:59:59').toISOString():null;
function amount(value){const n=Number(value);if(value===''||!Number.isSafeInteger(n)||n<0||n%10!==0)throw new Error('ポイントは0以上、10単位で入力してください。');return n;}
function identity(f){return {displayName:f.displayName.trim(),birthDate:f.birthDate,gender:f.gender||null,gradeLevel:f.gradeLevel?Number(f.gradeLevel):null,gradeBaseSchoolYear:schoolYear()};}
async function action(a,id){
 if(a==='pairing-reject')return respondPairingDialog(id,'rejected');
 if(a==='reload'){if(!canLeave())return;return navigate(true);}
 if(a==='logout'){if(!parent())throw new Error('子どもの端末の接続解除は、保護者の設定から行ってください。');await api('/auth/logout','POST',{});API.clear();sessionStorage.removeItem('pairingRequestId');state.session={authenticated:false,demo:state.session?.demo};state.pairingId=null;state.childId=null;state.chat=null;state.dashboard=null;return go('#start');}
 if(a==='child-home')return go('#child-home/'+path(id));
 if(a==='child-settings')return go('#child-settings/'+id);
 if(a==='invite'){state.invitation=await api('/children/'+path(id)+'/invitations','POST',{});return go('#invitation/'+id);}
 if(a==='feature-goal'){const i=state.goalOrder.indexOf(id);if(i>0)[state.goalOrder[0],state.goalOrder[i]]=[state.goalOrder[i],state.goalOrder[0]];const section=$('.goals');if(section)section.innerHTML='<h2>ほしいもの</h2>'+goals(state.dashboard);return;}
 if(a==='purchase'){const g=state.dashboard.goals.find(x=>x.id===id);if(!confirm(`${g.name}を購入済みにして、${points(g.targetAmountYen)}を残高から引きますか？`))return;await api('/goals/'+path(id)+'/purchase','POST',{});await home();return notice('購入を記録しました。');}
 if(a==='select-chat-child'){state.childId=id;state.goalOrder=[];return go('#conversations');}
 if(a==='new-chat'){if(parent())throw new Error('保護者は子どもから届いたおねがいについて、親子とぽぽで相談してください。');
  const current=state.chat,removable=current?.mode!=='negotiation'&&current?.conversationId&&!current.currentProposal&&!current.draftProposal;
  if(!confirm(kid('新しいチャットを始めます。今までの会話は画面から消え、ぽぽにも引き継がれません。よろしいですか？','あたらしく はなしを はじめるよ。いままでの おはなしは みえなくなるけど いい？')))return;
  const d=await api('/conversations','POST',parent()&&state.childId?{childId:state.childId}:{});
  // Delete the old private chat only after the new one exists, so a failed delete never blocks starting over.
  // The server refuses chats that have proposals; those stay stored and simply stop being shown.
  if(removable)await api('/conversations/'+path(current.conversationId),'DELETE').catch(()=>{});
  return go('#conversation/'+d.conversationId);
 }
 if(a==='open-negotiation')return go('#negotiation/'+id);
 if(a==='start-chat')return renderChat(await api(chatPath()+'/start','POST',{}));
 if(a==='open-chat')return go('#conversation/'+id);
 if(a==='proposal')return go('#proposal/'+id);
 if(a==='consult-proposal'){const d=await api('/proposals/'+path(id));if(!d.canConsult)throw new Error('共有交渉は開始前、回答待ち、または終了しています。');return go('#negotiation/'+d.negotiationId);}
 if(a==='search-product-now'){
  notice(kid('商品を探しています…','さがしているよ…'));
  const detail=await api(chatPath()+'/search','POST',{
    fromConversation:true
  });
  notice();
  return renderChat(detail);
}
 if(a==='select-product')return renderChat(await api(chatPath()+'/selected-product','PATCH',{selectedProductId:id}));
 if(a==='confirm-reason'){const d=await api(chatPath()+'/confirm-reason','POST',{reasonSummary:state.chat.reasonSummary});renderChat(d);return go('#proposal/'+d.currentProposal.id);}
 if(a==='generate-proposal'){
  const shared=state.chat.mode==='negotiation', before=shared?state.chat.draftProposal:state.chat.currentProposal;
  const d=await api(chatPath()+'/proposal-drafts','POST',{}), draft=shared?d.draftProposal:d.currentProposal;
  renderChat(d);
  const updated=draft&&(!before||draft.id!==before.id||draft.version!==before.version);
  if(!updated)return;
  return go('#proposal/'+draft.id);
 }
 if(a==='send-proposal'){if(state.dirty)throw new Error('編集内容が未保存です。保存してから送ってください。');if(!confirm(kid('この商品と理由を送りますか？','この おねがいを おうちのひとに おくる？')))return;await api('/proposals/'+path(id)+'/send','POST',{version:state.proposal.proposal.version});await proposal(id);return notice(kid('相手に送りました。返事をお待ちください。','おうちのひとに おくったよ。おへんじを まってね。'));}
 if(a==='delete-child'){
  if(!parent())throw new Error('保護者の操作が必要です。');const c=state.childRecords?.find(c=>c.childId===id);
  if(!c)throw new Error('子どもの一覧を開き直してください。');
  if(!confirm(`${c.displayName}の登録を削除しますか？\nこの子の会話・目標・お手伝い・ポイント・端末接続もすべて削除され、元に戻せません。他の子のデータは残ります。`))return;
  await api('/children/'+path(id),'DELETE',{confirmation:'DELETE_CHILD'});
  state.epoch++;viewCache.clear();if(state.childId===id)state.childId=null;state.dashboard=null;state.chat=null;state.proposal=null;state.chatThreads=null;state.goalOrder=[];state.dirty=false;
  await go('#children');return notice('子どもの登録と履歴を削除しました。');
 }
 if(a==='clear-history'){
  if(!parent())throw new Error('保護者の操作が必要です。');
  if(!confirm('本当に履歴をすべて消去しますか？\n家族全員の会話・おねがい・目標・お手伝い・ポイントがすべて消え、元に戻せません。\nアカウント・家族登録・設定・端末接続は残ります。'))return;
  await api('/history','DELETE',{confirmation:'DELETE_ALL_HISTORY'});
  state.epoch++;viewCache.clear();state.chat=null;state.chatThreads=null;state.proposal=null;state.dashboard=null;state.goalOrder=[];state.canNegotiate=false;state.dirty=false;
  await settings();nav();return notice('履歴をすべて消去しました。ポイントは0に戻りました。');
 }
 if(a==='revoke-device'){if(!confirm('選択した端末の接続を解除しますか？ その端末では再接続が必要になります。'))return;const d=await api('/devices/'+path(id),'DELETE');if(d.currentDeviceRevoked){state.session={authenticated:false,demo:state.session?.demo};API.clear();return welcome();}await settings();return notice('選択した端末の接続を解除しました。');}
 if(a==='pairing-check'){history.replaceState(null,'','#pairing');await api('/pairing/session','POST',{});return pairView(await api('/pairing/requests/'+path(state.pairingId)));}
 if(a==='pairing-complete'){state.session=await api('/pairing/requests/'+path(state.pairingId)+'/complete','POST',{});sessionStorage.removeItem('pairingRequestId');state.pairingId=null;return go('#home');}
}
async function submit(name,id,f){
 if(name==='pair-respond-modal'){const code=f.confirmationCode.normalize('NFKC').trim();if(!/^[0-9]{6}$/.test(code))throw new Error('6桁の確認番号を入力してください。');return respondPairingDialog(id,'approved',code);}
 if(name==='pair-code'){await pair(f.invitationToken.trim().toUpperCase());history.replaceState(null,'','#pairing');return;}
 if(name==='child-profile'){await api('/profile','PATCH',{profile:{preferences:{interests:lines(f.interests)}}});return notice('好きなことを保存しました。');}
 if(name==='search-products')return renderChat(await api(chatPath()+'/search','POST',{query:f.query.trim()}));
 if(name==='onboarding'){const payload=parent()?{displayName:f.displayName.trim(),birthDate:f.birthDate,gender:f.gender||null,onboardingCompleted:true}:{profile:{preferences:{interests:lines(f.interests),expectations:[]}},onboardingCompleted:true};await api('/profile','PATCH',payload);state.session=await api('/auth/session');return go(parent()?'#children':'#home');}
 if(name==='create-child'){const c=await api('/children','POST',{...identity(f)});state.childId=c.childId;if(c.settingsSaved===false){await go('#child-settings/'+c.childId);return notice('子どもは登録済みですが、目標の設定を保存できませんでした。この画面で設定を保存してください。再登録は不要です。',true);}try{return await action('invite',c.childId);}catch(e){await children();return notice('子どもは登録しました。端末の接続準備に失敗しました。「端末をつなぐ」から再開できます。',true);}}
 if(name==='child-info'){await api('/children/'+path(id),'PATCH',identity(f));await childSettings(id);return notice('子どもの情報を保存しました。');}
 if(name==='child-settings'){await api('/children/'+path(id)+'/settings','PATCH',{constraints:{mustHave:lines(f.mustHave),mustAvoid:lines(f.mustAvoid)}});return notice('条件を保存しました。');}
 if(name==='profile'){await api('/profile','PATCH',{displayName:f.displayName.trim(),birthDate:f.birthDate,gender:f.gender||null});state.session=await api('/auth/session');return notice('プロフィールを保存しました。');}
 if(name==='create-chore'){await api('/chores','POST',{childId:state.childId,title:f.title.trim(),description:f.description.trim(),rewardAmountYen:amount(f.rewardAmountYen),dueAt:due(f.dueAt)});await chores();return notice('お手伝いを依頼しました。');}
 if(name==='create-request'){await api('/chore-requests','POST',{title:f.title.trim(),note:f.note.trim()});await chores();return notice('おうちのひとに つたえたよ。');}
 if(name==='respond-request'){if(f.decision==='rejected'&&!f.reason.trim())throw new Error('見送る理由を書いてください。');await api('/chore-requests/'+path(id)+'/respond','POST',{decision:f.decision,reason:f.reason.trim(),...(f.decision==='approved'?{title:f.title.trim(),rewardAmountYen:amount(f.rewardAmountYen),dueAt:due(f.dueAt)}:{})});await chores();return notice('提案に返事しました。');}
 if(name==='submit-chore'){await api('/chores/'+path(id)+'/submit','POST',{note:f.note.trim()});await chores();return notice('できた！を しらせたよ。');}
 if(name==='review-chore'){if(f.decision==='rejected'&&!f.reason.trim())throw new Error('やり直してほしいことを書いてください。');await api('/chores/'+path(id)+'/review','POST',{decision:f.decision,reason:f.reason.trim()});await chores();return notice(f.decision==='approved'?'ありがとうポイントを反映しました。':'やり直しをお願いしました。');}
 if(name==='message')return renderChat(await api(chatPath()+'/messages','POST',{message:f.message.trim()}));
 if(name==='edit-proposal'){const saved=await api('/proposals/'+path(id),'PATCH',{version:state.proposal.proposal.version,persuasionText:f.persuasionText.trim(),purchaseConditions:[]});state.proposal=saved;state.dirty=false;return action('send-proposal',id);}
 if(name==='decide-negotiation'){if(f.decision==='rejected'&&!f.reason.trim())throw new Error('見送る理由を書いてください。');await api('/negotiations/'+path(id)+'/decision','POST',{version:state.chat.currentProposal.version,decision:f.decision,reason:f.reason.trim()||null});return negotiation(id);}
 if(name==='respond-proposal'){if(f.decision!=='approved'&&!f.reason.trim())throw new Error('理由を書いてください。');const d=await api('/proposals/'+path(id)+'/responses','POST',{version:state.proposal.proposal.version,decision:f.decision,reason:f.reason.trim()||null});if(d.canConsult)return go('#negotiation/'+d.negotiationId);await proposal(id);return notice(f.decision==='approved'?'合意して、目標に登録しました。':'理由を伝えて、今回は見送りにしました。');}
}
document.addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(b){e.preventDefault();if(['child-home','child-settings','open-chat','open-negotiation','proposal','reload'].includes(b.dataset.action)){Promise.resolve(action(b.dataset.action,b.dataset.id)).catch(error);}else run(()=>action(b.dataset.action,b.dataset.id),b);return;}const a=e.target.closest('a[href^="#"]');if(a){e.preventDefault();void go(a.getAttribute('href'));}});
document.addEventListener('keydown',e=>{
 if(e.key!=='Enter'||e.shiftKey||e.ctrlKey||e.altKey||e.metaKey||e.isComposing||composing||e.keyCode===229)return;
 const input=e.target,form=input.closest?.('form[data-form="message"]');
 if(!form||!input.matches?.('textarea[name="message"]'))return;
 e.preventDefault();if(e.repeat||state.busy||!input.value.trim())return;
 form.requestSubmit();
});
document.addEventListener('input',e=>{if(e.target.closest('[data-form="edit-proposal"]'))state.dirty=true;});
window.addEventListener('beforeunload',e=>{if(state.dirty){e.preventDefault();e.returnValue='';}});
document.addEventListener('submit',e=>{const f=e.target.closest('[data-form]');if(!f)return;e.preventDefault();const data=Object.fromEntries(new FormData(f));run(()=>submit(f.dataset.form,f.dataset.id,data),f);});
document.addEventListener('focusout',e=>{if(e.target.name==='birthDate')fillGradeOnce(e.target);});
document.addEventListener('change',e=>{if(e.target.name==='gradeLevel')e.target.dataset.gradeInitialized='true';if(e.target.name==='birthDate'&&document.activeElement!==e.target)fillGradeOnce(e.target);if(e.target.id==='child-selector'){state.childId=e.target.value;state.goalOrder=[];if(parent()&&location.hash.startsWith('#child-home/')){void go('#child-home/'+path(state.childId));}else if(parent()&&/^#(?:conversation|negotiation)\//.test(location.hash)){void go('#conversations');}else void navigate();}});
document.addEventListener('error',e=>{if(e.target.matches?.('.product-image')){e.target.hidden=true;const fallback=e.target.nextElementSibling;if(fallback)fallback.hidden=false;}},true);
window.addEventListener('hashchange',()=>{if(!canLeave()){history.replaceState(null,'',state.routeHash||'#home');return;}void navigate();});
async function initialize(){loading();state.session=await api('/auth/session');const token=new URLSearchParams(location.hash.slice(1)).get('invitationToken');if(token){if(state.session.authenticated){history.replaceState(null,'','#home');await route();notice('ログイン中です。子どもの別端末または別ブラウザーで招待を開いてください。',true);return;}history.replaceState(null,'','/pairing');await pair(token);history.replaceState(null,'','#pairing');return;}if(new URLSearchParams(location.search).has('authError')){history.replaceState(null,'',location.pathname+location.hash);await route();notice('ログインできませんでした。もう一度お試しください。',true);return;}await route();}
$('#pairing-dialog')?.addEventListener('cancel',e=>{e.preventDefault();});
document.addEventListener('compositionstart',()=>{composing=true;});
document.addEventListener('compositionend',()=>{composing=false;});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='hidden'){void refreshVisible();void checkPairingRequests();}});
window.addEventListener('focus',()=>void refreshVisible());
run(initialize).then(()=>{void checkPairingRequests();window.setInterval?.(()=>void checkPairingRequests(),5000);window.setInterval?.(()=>void refreshVisible(),2000);});
})();
