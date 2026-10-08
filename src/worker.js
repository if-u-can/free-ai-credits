
const GITHUB_ISSUES="https://api.github.com/repos/if-u-can/free-ai-credits/issues";
function reply(value,status=200){return new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json;charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"}})}
function trim(value,max){return typeof value==="string"?value.trim().slice(0,max):""}
function oneLine(value,max){return trim(value,max).replace(/[\r\n<>]/g," ")}
function goodUrl(value){try{const u=new URL(value);return u.protocol==="https:"&&!!u.hostname&&!u.username&&!u.password&&u.href.length<700}catch{return false}}
function enabled(env){return !!(env.GITHUB_TOKEN&&env.TURNSTILE_SITE_KEY&&env.TURNSTILE_SECRET)}
export default {async fetch(request,env){
 const url=new URL(request.url);
 if(url.pathname==="/api/submissions/config"){
  if(request.method!=="GET")return reply({message:"Method not allowed"},405);
  return reply({enabled:enabled(env),siteKey:enabled(env)?env.TURNSTILE_SITE_KEY:null});
 }
 if(url.pathname!=="/api/submissions"){
  if(url.pathname.startsWith("/api/"))return reply({message:"Not found"},404);
  return env.ASSETS.fetch(request);
 }
 if(request.method!=="POST")return reply({message:"Method not allowed"},405);
 if(!enabled(env))return reply({message:"投稿通道正在配置，请稍后再试。"},503);
 if(request.headers.get("origin")!==url.origin)return reply({message:"请从本站投稿页面提交。"},403);
 if(!(request.headers.get("content-type")||"").startsWith("application/json"))return reply({message:"请求格式不正确。"},415);
 if(Number(request.headers.get("content-length")||0)>8192)return reply({message:"投稿内容太长。"},413);
 let form;
 try{const raw=await request.text();if(raw.length>8192)return reply({message:"投稿内容太长。"},413);form=JSON.parse(raw)}catch{return reply({message:"请求格式不正确。"},400)}
 if(!form||typeof form!=="object"||Array.isArray(form))return reply({message:"请求格式不正确。"},400);
 if(form.website)return reply({ok:true,queued:true},202);
 const provider=oneLine(form.provider,100),link=oneLine(form.claim_url,700);
 const kind=oneLine(form.category,40),credits=oneLine(form.credits,160),models=oneLine(form.models,220),requirements=oneLine(form.requirements,320),details=trim(form.details,2000).replace(/\r/g,"");
 if(provider.length<2||!goodUrl(link)||details.length<10||!["官方模型厂商 / 推理平台","可信公益站","其他（待评估）"].includes(kind))return reply({message:"请检查名称、官方链接和补充说明。"},400);
 const token=trim(form.turnstile_token,2048);
 if(!token)return reply({message:"请先完成人机验证。"},400);
 let ok=false;
 try{
  const params=new URLSearchParams({secret:env.TURNSTILE_SECRET,response:token});
  const ip=request.headers.get("CF-Connecting-IP");if(ip)params.set("remoteip",ip);
  const r=await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify",{method:"POST",body:params});
  if(r.ok){const d=await r.json();ok=d.success===true&&d.hostname===url.hostname}
 }catch{}
 if(!ok)return reply({message:"人机验证失败或过期，请重新验证。"},403);
 const body=["<!-- freeegg-website-submission -->","## 活动名称",provider,"","## 官方链接",link,"","## 类型",kind,"","## 免费额度",credits||"未填写","","## 支持模型",models||"未填写","","## 领取条件",requirements||"未填写","","## 补充信息",details,"","---","来源：免费鸡蛋篮站内投稿。未经核实，不得直接加入有效列表。"].join("\n");
 let response;
 try{response=await fetch(GITHUB_ISSUES,{method:"POST",headers:{authorization:"Bearer "+env.GITHUB_TOKEN,accept:"application/vnd.github+json","x-github-api-version":"2022-11-28","content-type":"application/json","user-agent":"freeegg-submission-worker"},body:JSON.stringify({title:"[投稿] "+provider,body})})}
 catch{return reply({message:"GitHub 暂时无法连接，请稍后重试。"},502)}
 if(!response.ok)return reply({message:response.status===403||response.status===429?"投稿服务繁忙，请稍后再试。":"GitHub 创建 Issue 失败，请稍后重试。"},response.status===403||response.status===429?503:502);
 const issue=await response.json();
 if(typeof issue.html_url!=="string"||!issue.html_url.startsWith("https://github.com/if-u-can/free-ai-credits/issues/"))return reply({message:"GitHub 返回异常，请检查投稿状态。"},502);
 return reply({ok:true,issue_url:issue.html_url,issue_number:issue.number},201);
}};