// Shared in-memory PostgreSQL adapter for local demo and integration tests.
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { AppError } from '../src/server/core.ts';
import type { DB, Row } from '../src/server/core.ts';
export async function createLocalDatabase() {
 const pg = new PGlite();
 await pg.exec(`create role anon; create role authenticated; create role service_role bypassrls;
 create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
 create table auth.identities(user_id uuid,provider text);
 create function auth.uid() returns uuid language sql as 'select null::uuid';`);
 for(const f of (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter(x=>x.endsWith('.sql')).sort()) await pg.exec((await readFile(new URL('../supabase/migrations/'+f, import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
 const col=(s:string)=>{if(!/^[a-z_]+$/.test(s))throw Error('Invalid SQL identifier');return '"'+s+'"';};
 const jsonFields=new Set(['products','latest_ai_output','constraints','chore_preferences','search_metadata']);
 const value=(k:string,v:any)=>v!==null&&typeof v==='object'&&(jsonFields.has(k)||!Array.isArray(v))?JSON.stringify(v):v;
 function filters(q:Record<string,string>,params:unknown[]) {return Object.entries(q).filter(([k])=>!['select','limit','order'].includes(k)).map(([k,v])=>{
  const c=col(k);if(v==='is.null')return c+' is null';
  const op=v.slice(0,v.indexOf('.')),val=v.slice(v.indexOf('.')+1);params.push(op==='in'?val.slice(1,-1).split(','):val);const n='$'+params.length;
  if(op==='in')return `${c}::text=any(${n}::text[])`;
  if(op==='cs')return `${c}@>${n}::jsonb`;
  const symbol=({eq:'=',neq:'<>',gt:'>',gte:'>=',lt:'<',lte:'<='} as Record<string,string>)[op];if(!symbol)throw Error('Unknown filter');return `${c}${symbol}${n}`;
 }).join(' and ')||'true';}
 async function query(sql:string,values:unknown[]=[]) {try{return JSON.parse(JSON.stringify((await pg.query<Row>(sql,values)).rows), (key,value)=>key==='birth_date'&&typeof value==='string'?value.slice(0,10):value);}catch(e:any){throw new AppError(e.code==='42501'?403:409,e.code==='42501'?'FORBIDDEN':'CONFLICT',e.message);}}
 const db:DB={
  async list(t,q={}){const p:unknown[]=[];let sql=`select * from public.${col(t)} where ${filters(q,p)}`;if(q.order)sql+=' order by '+q.order.split(',').map(x=>{const [name,direction]=x.split('.');return col(name)+(direction==='desc'?' desc':' asc');}).join(',');sql+=' limit '+Math.min(Number(q.limit||1000),1000);return query(sql,p);},
  async insert(t,values,conflict){const rows=Array.isArray(values)?values:[values],out:Row[]=[];for(const v of rows){const keys=Object.keys(v);let sql=`insert into public.${col(t)}(${keys.map(col).join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`;if(conflict)sql+=` on conflict(${col(conflict)}) do update set `+keys.filter(k=>k!==conflict).map(k=>`${col(k)}=excluded.${col(k)}`).join(',');out.push(...await query(sql+' returning *',keys.map(k=>value(k,v[k]))));}return out;},
  async update(t,q,v){const keys=Object.keys(v),p:unknown[]=keys.map(k=>value(k,v[k]));return query(`update public.${col(t)} set ${keys.map((k,i)=>`${col(k)}=$${i+1}`).join(',')} where ${filters(q,p)} returning *`,p);},
  async remove(t,q){const p:unknown[]=[];await query(`delete from public.${col(t)} where ${filters(q,p)}`,p);},
  async rpc(name,values){const keys=Object.keys(values);return (await query(`select public.${col(name)}(${keys.map((k,i)=>`${col(k)}=>$${i+1}`).join(',')}) as value`,keys.map(k=>values[k]!==null&&typeof values[k]==='object'&&!Array.isArray(values[k])?JSON.stringify(values[k]):values[k])))[0].value;},
  async auth(){throw Error('Auth network not enabled in local test');}
 };
 return {pg,db};
}
