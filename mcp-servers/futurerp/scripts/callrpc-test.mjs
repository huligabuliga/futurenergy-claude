import { randomBytes } from "node:crypto";
const SB=(process.env.SUPABASE_URL||"http://127.0.0.1:54321").replace(/\/+$/,"");
const PUB=process.env.SUPABASE_PUBLISHABLE_KEY, SVC=process.env.SUPABASE_SERVICE_ROLE_KEY, MCP=process.env.MCP_URL;
const H={apikey:SVC,Authorization:`Bearer ${SVC}`,"Content-Type":"application/json"};
const PASS="Rpc-"+randomBytes(6).toString("hex"); let fails=0;
const ok=(c,m,x="")=>{console.log(`${c?"PASS":"FAIL"}  ${m}${x?" — "+x:""}`); if(!c)fails++;};
const j=async(u,i={})=>{const r=await fetch(u,i);const t=await r.text();try{return{s:r.status,b:JSON.parse(t)}}catch{return{s:r.status,b:t}}};
async function mkUser(email,{admin=false,role=null}={}){const u=(await j(`${SB}/auth/v1/admin/users`,{method:"POST",headers:H,body:JSON.stringify({email,password:PASS,email_confirm:true})})).b;
  await j(`${SB}/rest/v1/profiles?on_conflict=user_id`,{method:"POST",headers:{...H,Prefer:"return=minimal,resolution=merge-duplicates"},body:JSON.stringify({user_id:u.id,email,first_name:"Rpc",last_name:"T",is_active:true,is_admin:admin})});
  if(role){const r=(await j(`${SB}/rest/v1/crm_roles?name=eq.${encodeURIComponent(role)}&select=id`,{headers:H})).b[0];await j(`${SB}/rest/v1/user_crm_roles?on_conflict=user_id,role_id`,{method:"POST",headers:{...H,Prefer:"return=minimal,resolution=ignore-duplicates"},body:JSON.stringify({user_id:u.id,role_id:r.id})});}
  return u.id;}
const rm=async(id)=>{await j(`${SB}/rest/v1/user_crm_roles?user_id=eq.${id}`,{method:"DELETE",headers:H});await j(`${SB}/rest/v1/profiles?user_id=eq.${id}`,{method:"DELETE",headers:H});await j(`${SB}/auth/v1/admin/users/${id}`,{method:"DELETE",headers:H});};
const signIn=async(e)=>(await j(`${SB}/auth/v1/token?grant_type=password`,{method:"POST",headers:{apikey:PUB,"Content-Type":"application/json"},body:JSON.stringify({email:e,password:PASS})})).b.access_token;
async function mcp(tok,method,params={},id=1){const r=await j(MCP,{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json, text/event-stream",Authorization:`Bearer ${tok}`},body:JSON.stringify({jsonrpc:"2.0",id,method,params})});let d=r.b;if(typeof r.b==="string"&&(r.b.startsWith("event:")||r.b.startsWith("data:")))d=r.b.split("\n").filter(l=>l.startsWith("data:")).map(l=>JSON.parse(l.slice(5))).pop();return {status:r.s,data:d};}
const call=async(tok,name,args)=>{await mcp(tok,"initialize",{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"t",version:"0"}});return mcp(tok,"tools/call",{name:"futurerp_call_rpc",arguments:{name,args}},9);};
const txt=(r)=>r.data?.result?.content?.[0]?.text||JSON.stringify(r.data); const isErr=(r)=>r.data?.result?.isError===true;
const created=[];
try{
  const stamp=randomBytes(3).toString("hex");
  const admin=await mkUser(`rpc-admin-${stamp}@futurenergy.mx`,{admin:true});
  const plain=await mkUser(`rpc-plain-${stamp}@futurenergy.mx`,{});
  const gas=await mkUser(`rpc-gas-${stamp}@futurenergy.mx`,{role:"Sistemas"}); // Sistemas has gasolina.view_all? if not, admin covers via is_admin
  created.push(admin,plain,gas);
  const aTok=await signIn(`rpc-admin-${stamp}@futurenergy.mx`), pTok=await signIn(`rpc-plain-${stamp}@futurenergy.mx`);

  // INVOKER self-scoping RPC works for everyone
  let r=await call(pTok,"dashboard_dc_kpis_month",{p_month_start:"2026-08-01"});
  ok(isErr(r) && /permiso/.test(txt(r)),"plain user: dashboard_dc_kpis_month DENIED (needs dashboards.direccion_comercial.view)",txt(r).slice(0,90));
  r=await call(aTok,"dashboard_dc_kpis_month",{p_month_start:"2026-08-01"});
  ok(r.status===200 && !isErr(r),"admin: dashboard_dc_kpis_month allowed",txt(r).slice(0,80));
  r=await call(pTok,"get_unread_notification_count",{});
  ok(r.status===200 && !isErr(r),"plain user: get_unread_notification_count ok");

  // Gated org-wide RPC: denied for plain, allowed for admin
  r=await call(pTok,"get_gasolina_summary",{p_start:"2026-08-01T00:00:00Z",p_end:"2026-08-31T23:59:59Z"});
  ok(isErr(r) && /permiso/.test(txt(r)),"plain user: get_gasolina_summary DENIED (needs gasolina.view_all)",txt(r).slice(0,90));
  r=await call(aTok,"get_gasolina_summary",{p_start:"2026-08-01T00:00:00Z",p_end:"2026-08-31T23:59:59Z"});
  ok(r.status===200 && !isErr(r),"admin: get_gasolina_summary allowed",txt(r).slice(0,80));

  // Whitelist blocks arbitrary / mutating RPC
  r=await call(aTok,"mark_gasolina_entry_paid",{});
  ok(isErr(r) && /not callable/.test(txt(r)),"admin: mutating RPC mark_gasolina_entry_paid BLOCKED (not in whitelist)",txt(r).slice(0,80));
  r=await call(aTok,"set_config",{});
  ok(isErr(r) && /not callable/.test(txt(r)),"admin: set_config BLOCKED");

  // Operativo gated
  r=await call(aTok,"dashboard_operativo_projects",{});
  ok(r.status===200 && !isErr(r),"admin: dashboard_operativo_projects allowed");
}catch(e){console.error("ERROR",e);fails++;}
finally{for(const id of created){try{await rm(id)}catch{}}console.log(`\n${fails===0?"ALL PASS":fails+" FAIL"}`);process.exit(fails?1:0);}
