// Verifies the MCP mirrors FuturERP RLS per user. Creates throwaway users at 3 permission levels,
// mints password tokens, and checks tool visibility + data scoping through the running server.
// Env: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SERVICE_ROLE_KEY, MCP_URL
import { randomBytes } from "node:crypto";
const SB=(process.env.SUPABASE_URL||"http://127.0.0.1:54321").replace(/\/+$/,"");
const PUB=process.env.SUPABASE_PUBLISHABLE_KEY, SVC=process.env.SUPABASE_SERVICE_ROLE_KEY, MCP=process.env.MCP_URL;
const H={apikey:SVC,Authorization:`Bearer ${SVC}`,"Content-Type":"application/json"};
const PASS="Rls-"+randomBytes(6).toString("hex");
let fails=0; const ok=(c,m,x="")=>{console.log(`${c?"PASS":"FAIL"}  ${m}${x?" — "+x:""}`); if(!c)fails++;};
const j=async(u,i={})=>{const r=await fetch(u,i);const t=await r.text();try{return{s:r.status,b:JSON.parse(t),h:r.headers}}catch{return{s:r.status,b:t,h:r.headers}}};

async function mkUser(email, {admin=false, role=null}={}){
  const u=(await j(`${SB}/auth/v1/admin/users`,{method:"POST",headers:H,body:JSON.stringify({email,password:PASS,email_confirm:true})})).b;
  await j(`${SB}/rest/v1/profiles?on_conflict=user_id`,{method:"POST",headers:{...H,Prefer:"return=minimal,resolution=merge-duplicates"},body:JSON.stringify({user_id:u.id,email,first_name:"RLS",last_name:"Test",is_active:true,is_admin:admin})});
  if(role){const r=(await j(`${SB}/rest/v1/crm_roles?name=eq.${encodeURIComponent(role)}&select=id`,{headers:H})).b[0];
    await j(`${SB}/rest/v1/user_crm_roles?on_conflict=user_id,role_id`,{method:"POST",headers:{...H,Prefer:"return=minimal,resolution=ignore-duplicates"},body:JSON.stringify({user_id:u.id,role_id:r.id})});}
  return u.id;
}
const rmUser=async(id)=>{await j(`${SB}/rest/v1/user_crm_roles?user_id=eq.${id}`,{method:"DELETE",headers:H});await j(`${SB}/rest/v1/profiles?user_id=eq.${id}`,{method:"DELETE",headers:H});await j(`${SB}/auth/v1/admin/users/${id}`,{method:"DELETE",headers:H});};
const signIn=async(email)=>(await j(`${SB}/auth/v1/token?grant_type=password`,{method:"POST",headers:{apikey:PUB,"Content-Type":"application/json"},body:JSON.stringify({email,password:PASS})})).b.access_token;
async function mcp(tok,method,params={},id=1){const r=await j(MCP,{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json, text/event-stream",Authorization:`Bearer ${tok}`},body:JSON.stringify({jsonrpc:"2.0",id,method,params})});
  let data=r.b; if(typeof r.b==="string"&&(r.b.startsWith("event:")||r.b.startsWith("data:")))data=r.b.split("\n").filter(l=>l.startsWith("data:")).map(l=>JSON.parse(l.slice(5))).pop(); return {status:r.s,data};}
async function tools(tok){await mcp(tok,"initialize",{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"t",version:"0"}});const r=await mcp(tok,"tools/list",{},2);return (r.data?.result?.tools||[]).map(t=>t.name);}
async function count(tok,table){const r=await mcp(tok,"tools/call",{name:"futurerp_count",arguments:{table}},3);const txt=r.data?.result?.content?.[0]?.text||JSON.stringify(r.data);const m=txt.match(/\*\*([\d,]+)\*\*|(\d[\d,]*)\s*(rows|filas|registros)/i);return m?parseInt((m[1]||m[2]).replace(/,/g,""),10):txt;}

const created=[];
try{
  const baseLeads=(await j(`${SB}/rest/v1/leads?select=id`,{method:"HEAD",headers:{...H,Prefer:"count=exact"}})).h.get("content-range").split("/").pop();
  console.log("baseline leads (service):", baseLeads);
  const stamp=randomBytes(3).toString("hex");
  const admin=await mkUser(`rls-admin-${stamp}@futurenergy.mx`,{admin:true});
  const dir  =await mkUser(`rls-dir-${stamp}@futurenergy.mx`,{role:"Director Comercial"});
  const plain=await mkUser(`rls-plain-${stamp}@futurenergy.mx`,{});
  created.push(admin,dir,plain);

  console.log("\n# ADMIN (is_admin=true)");
  const tA=await tools(await signIn(`rls-admin-${stamp}@futurenergy.mx`));
  ok(tA.includes("futurerp_sales_ranking")&&tA.includes("futurerp_drone_leaderboard")&&tA.includes("futurerp_whatsapp_chats"),"admin sees gated + bot tools",`${tA.length} tools`);
  ok(String(await count(await signIn(`rls-admin-${stamp}@futurenergy.mx`),"leads"))===String(baseLeads),"admin leads count == all",`vs ${baseLeads}`);

  console.log("\n# DIRECTOR (leads.view_all via role, not admin)");
  const dTok=await signIn(`rls-dir-${stamp}@futurenergy.mx`);
  const tD=await tools(dTok);
  ok(tD.includes("futurerp_sales_ranking"),"director sees sales_ranking (leads.view_all)");
  ok(!tD.includes("futurerp_whatsapp_chats"),"director does NOT see bot whatsapp tools (not admin)");
  ok(String(await count(dTok,"leads"))===String(baseLeads),"director leads count == all (leads.view_all)",`vs ${baseLeads}`);

  console.log("\n# PLAIN (no special role → own data only)");
  const pTok=await signIn(`rls-plain-${stamp}@futurenergy.mx`);
  const tP=await tools(pTok);
  ok(!tP.includes("futurerp_sales_ranking")&&!tP.includes("futurerp_drone_leaderboard")&&!tP.includes("futurerp_whatsapp_chats")&&!tP.includes("futurerp_whatsapp_stats")&&!tP.includes("futurerp_whatsapp_health"),"plain user has NO gated/bot tools");
  ok(tP.includes("futurerp_count")&&tP.includes("futurerp_query")&&tP.includes("futurerp_whatsapp_seguimientos"),"plain user still has row + seguimientos tools",`${tP.length} tools`);
  const pLeads=await count(pTok,"leads");
  ok(Number(pLeads)<Number(baseLeads),"plain user leads count < all (RLS scoped to own)",`${pLeads} vs ${baseLeads}`);
  const pProj=await count(pTok,"projects");
  const baseProj=(await j(`${SB}/rest/v1/projects?select=id`,{method:"HEAD",headers:{...H,Prefer:"count=exact"}})).h.get("content-range").split("/").pop();
  ok(Number(pProj)<Number(baseProj),"plain user projects count < all",`${pProj} vs ${baseProj}`);
}catch(e){console.error("ERROR",e);fails++;}
finally{for(const id of created){try{await rmUser(id)}catch(e){console.error("cleanup",id,e.message)}}console.log(`\n${fails===0?"ALL PASS":fails+" FAIL"}`);process.exit(fails?1:0);}
