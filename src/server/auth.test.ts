import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.ts';
import { unseal,hash } from './core.ts';
import type { Config,DB,Row } from './core.ts';
const config:Config={origin:'https://app.test',supabaseUrl:'https://test.supabase.co',serviceKey:'secret',publishableKey:'public',sessionSecret:'a'.repeat(64),geminiKey:'test',port:3000};
test('OAuth binds callback to PKCE cookie and creates only opaque secure app session',async()=>{
 const authCalls:Row[]=[];let saved:Row={};
 const db:DB={list:async()=>[],insert:async(t,v)=>{assert.equal(t,'app_sessions');saved=v as Row;return [saved];},update:async()=>[],remove:async()=>{},rpc:async(n)=>{assert.equal(n,'wb_register_parent');return {};},auth:async(path,method,body)=>{authCalls.push({path,method,body});return {access_token:'never-expose',refresh_token:'never-expose',user:{id:'00000000-0000-4000-8000-000000000001',identities:[{provider:'google'}]}};}};
 const app=createApp(config,{db,ai:async()=>{throw Error('unused');},enrich:async p=>p,image:async()=>null,qr:async()=>''});
 const start=await app(new Request(config.origin+'/api/auth/google/start'));
 const jar=start.headers.getSetCookie()[0].split(';')[0],flow=unseal(jar.split('=')[1],config.sessionSecret)!;
 const target=new URL(start.headers.get('location')!);assert.equal(target.searchParams.get('code_challenge_method'),'s256');assert.equal(target.searchParams.get('provider'),'google');
 assert.equal(target.searchParams.has('max_age'),false);assert.equal('reauthUserId' in flow,false);
 const bad=await app(new Request(config.origin+'/api/auth/google/callback?code=x&flow=wrong',{headers:{cookie:jar}}));assert.match(bad.headers.get('location')!,/authError/);assert.equal(authCalls.length,0);
 const good=await app(new Request(config.origin+'/api/auth/google/callback?code=x&flow='+flow.flow,{headers:{cookie:jar}}));assert.equal(good.status,303);assert.equal(authCalls[0].body.code_verifier,flow.verifier);
 const session=good.headers.getSetCookie().find(c=>c.startsWith('__Host-wb_session='))!;assert.match(session,/HttpOnly; SameSite=Lax; Max-Age=\d+; Secure/);assert(!session.includes('never-expose'));assert.equal(saved.token_hash,hash(session.split(';')[0].split('=')[1]));
});
test('pairing bootstrap keeps browser binding across reloads and rejects cross-origin or wrong CSRF',async()=>{
 const db:DB={list:async()=>[],insert:async()=>[],update:async()=>[],remove:async()=>{},rpc:async()=>{throw Error('must reject before DB');},auth:async()=>({})};
 const app=createApp(config,{db,ai:async()=>{throw Error('unused');},enrich:async p=>p,image:async()=>null,qr:async()=>''});
 const call=(path:string,cookie='',csrf='',origin=config.origin)=>app(new Request(config.origin+path,{method:'POST',headers:{origin,cookie,'x-csrf-token':csrf,'content-type':'application/json'},body:'{}'}));
 assert.equal((await call('/api/pairing/session','','','https://evil.test')).status,403);
 const first=await call('/api/pairing/session'),a=(await first.json()).data,jar=first.headers.getSetCookie()[0].split(';')[0];
 const again=await call('/api/pairing/session',jar),b=(await again.json()).data;assert.equal(a.csrfToken,b.csrfToken);assert.equal(a.expiresAt,b.expiresAt);
 assert.equal((await call('/api/pairing/requests',jar,'wrong')).status,403);
});
