import { handleInteractions } from './interactions.js';
const GITHUB_ISSUES="https://api.github.com/repos/if-u-can/free-ai-credits/issues";
const MAX_BODY_BYTES=8192;
// Coalesce concurrent creates in this isolate; GitHub markers handle later retries.
const inFlightSubmissions=new Map();
function reply(value,status=200,headers={}){return new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json;charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff",...headers}})}
function trim(value,max){return typeof value==="string"?value.trim().slice(0,max):""}
function oneLine(value,max){return trim(value,max).replace(/[\r\n<>]/g," ")}
function goodUrl(value){try{const u=new URL(value);return u.protocol==="https:"&&!!u.hostname&&!u.username&&!u.password&&u.href.length<700}catch{return false}}
function enabled(env){return !!(env.GITHUB_TOKEN&&env.TURNSTILE_SITE_KEY&&env.TURNSTILE_SECRET&&typeof env.SUBMISSION_RATE_LIMITER?.limit==="function")}
async function readForm(request){
 const reader=request.body?.getReader();if(!reader)return null;
 const decoder=new TextDecoder("utf-8",{fatal:true});let bytes=0,raw="";
 try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>MAX_BODY_BYTES){await reader.cancel();return {tooLarge:true}}raw+=decoder.decode(value,{stream:true})}raw+=decoder.decode();return {form:JSON.parse(raw)}}finally{reader.releaseLock()}
}
async function upstream(url,options,deadline){
 const remaining=Math.min(10000,deadline-Date.now());
 if(remaining<=0)throw new Error("Submission upstream deadline exceeded");
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),remaining);
 try{const response=await fetch(url,{...options,signal:controller.signal,redirect:"manual"});return {status:response.status,ok:response.ok,next:!!response.headers.get("link")?.match(/;\s*rel="next"/),data:response.ok?await response.json():null}}finally{clearTimeout(timer)}
}
function githubHeaders(env){return {...(env.GITHUB_TOKEN?{authorization:"Bearer "+env.GITHUB_TOKEN}:{}),accept:"application/vnd.github+json","x-github-api-version":"2022-11-28","content-type":"application/json","user-agent":"freeegg-submission-worker"}}
function githubError(status){return reply({message:status===403||status===429?"投稿服务繁忙，请稍后再试。":"GitHub 暂时无法连接，请稍后重试。"},status===403||status===429?503:502)}
function validIssue(issue){return Number.isSafeInteger(issue?.number)&&issue.number>0&&issue.html_url==="https://github.com/if-u-can/free-ai-credits/issues/"+issue.number}
function validTimestamp(value){if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))return false;const parsed=new Date(value);if(!Number.isFinite(parsed.getTime()))return false;return parsed.toISOString()===(value.includes(".")?value:value.replace("Z",".000Z"))}
function reviewFeedError(code,status){return reply({message:status===403||status===429?"投稿服务繁忙，请稍后再试。":"GitHub 暂时无法连接，请稍后重试。",code,...(code==="UPSTREAM_HTTP"?{upstream_status:status}:{})},status===403||status===429?503:502)}
async function reviewFeed(request,env,url,deadline){
 if(request.method!=="GET")return reply({message:"Method not allowed"},405);
 const page=url.searchParams.get("page")??"1",since=url.searchParams.get("since");
 if(!/^[1-5]$/.test(page)||url.searchParams.getAll("page").length>1||url.searchParams.getAll("since").length>1||[...url.searchParams.keys()].some(key=>key!=="page"&&key!=="since")||(since!==null&&!validTimestamp(since)))return reply({message:"Invalid review feed query"},400);
 if(typeof env.SUBMISSION_RATE_LIMITER?.limit!=="function")return reply({message:"Review feed is temporarily unavailable"},503);
 const ip=request.headers.get("CF-Connecting-IP");if(!ip)return reply({message:"Request must pass through the site"},403);
 try{const limit=await env.SUBMISSION_RATE_LIMITER.limit({key:"review-feed:"+ip});if(limit?.success!==true)return reply({message:"Review feed rate limit exceeded"},429,{"retry-after":"60"})}catch{return reply({message:"Review feed is temporarily unavailable"},503)}
 const query=new URLSearchParams({state:"all",sort:"updated",direction:"asc",per_page:"100",page});if(since!==null)query.set("since",since);
 try{
  const listed=await upstream(GITHUB_ISSUES+"?"+query,{method:"GET",headers:githubHeaders(env)},deadline);
  if(!listed.ok)return reviewFeedError("UPSTREAM_HTTP",listed.status);
  if(!Array.isArray(listed.data))return reviewFeedError("INVALID_SOURCE_ARRAY");
  const issues=[];let sourceLatestUpdatedAt=null;
  for(const issue of listed.data){
   if(!validTimestamp(issue?.updated_at))return reviewFeedError("INVALID_SOURCE_TIMESTAMP");
   if(sourceLatestUpdatedAt===null||Date.parse(issue.updated_at)>Date.parse(sourceLatestUpdatedAt))sourceLatestUpdatedAt=issue.updated_at;
   if(issue?.pull_request||typeof issue?.body!=="string"||!issue.body.startsWith("<!-- freeegg-website-submission -->\n"))continue;
   if(!validIssue(issue)||typeof issue.title!=="string"||!validTimestamp(issue.created_at)||!validTimestamp(issue.updated_at)||!["open","closed"].includes(issue.state))return reviewFeedError("INVALID_SUBMISSION_METADATA");
   issues.push({number:issue.number,html_url:issue.html_url,title:issue.title,created_at:issue.created_at,updated_at:issue.updated_at,state:issue.state,body:issue.body});
  }
  return reply({issues,has_more:listed.next,source_latest_updated_at:sourceLatestUpdatedAt});
 }catch(error){return reviewFeedError(error?.name==="SyntaxError"?"UPSTREAM_JSON":error?.name==="AbortError"||error?.name==="TimeoutError"||Date.now()>=deadline?"UPSTREAM_TIMEOUT":"UPSTREAM_REQUEST")}
}
function normalizedUrl(value){const url=new URL(value);url.hash="";return url.href}
async function submissionMarker(link){const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(normalizedUrl(link)));return "<!-- freeegg-submission-id: "+Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,"0")).join("")+" -->"}
function matchesSubmission(issue,marker,link){
 if(issue.pull_request||typeof issue.body!=="string"||!issue.body.startsWith("<!-- freeegg-website-submission -->\n"))return false;
 if(issue.body.split("\n")[1]===marker)return true;
 const legacyLink=issue.body.match(/\n## 官方链接\n([^\n]+)\n/);
 return !!legacyLink&&goodUrl(legacyLink[1])&&normalizedUrl(legacyLink[1])===normalizedUrl(link);
}
export default {async fetch(request,env){
 const deadline=Date.now()+20000;
 const url=new URL(request.url);
 if(url.pathname==="/api/interactions"||url.pathname.startsWith("/api/interactions/"))return handleInteractions(request,env);
 if(url.pathname==="/api/submissions/review-feed")return reviewFeed(request,env,url,deadline);
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
 if((request.headers.get("content-type")||"").split(";")[0].trim().toLowerCase()!=="application/json")return reply({message:"请求格式不正确。"},415);
 if(Number(request.headers.get("content-length")||0)>MAX_BODY_BYTES)return reply({message:"投稿内容太长。"},413);
 let form;
 try{const parsed=await readForm(request);if(parsed?.tooLarge)return reply({message:"投稿内容太长。"},413);form=parsed?.form}catch{return reply({message:"请求格式不正确。"},400)}
 if(!form||typeof form!=="object"||Array.isArray(form))return reply({message:"请求格式不正确。"},400);
 if(form.website)return reply({ok:true,queued:true},202);
 const provider=oneLine(form.provider,100),link=oneLine(form.claim_url,700);
 const kind=oneLine(form.category,40),credits=oneLine(form.credits,160),models=oneLine(form.models,220),requirements=oneLine(form.requirements,320),details=trim(form.details,2000).replace(/\r/g,"");
 if(provider.length<2||!goodUrl(link)||details.length<10||!["官方模型厂商 / 推理平台","可信公益站","其他（待评估）"].includes(kind))return reply({message:"请检查名称、官方链接和补充说明。"},400);
 const token=trim(form.turnstile_token,2048);
 if(!token)return reply({message:"请先完成人机验证。"},400);
 const ip=request.headers.get("CF-Connecting-IP");
 if(!ip)return reply({message:"请从本站投稿页面提交。"},403);
 try{const limit=await env.SUBMISSION_RATE_LIMITER.limit({key:ip});if(limit?.success!==true)return reply({message:"投稿太频繁，请稍后再试。"},429,{"retry-after":"60"})}catch{return reply({message:"投稿服务暂时不可用，请稍后再试。"},503)}
 let ok=false;
 try{
  const params=new URLSearchParams({secret:env.TURNSTILE_SECRET,response:token});
  params.set("remoteip",ip);
  const r=await upstream("https://challenges.cloudflare.com/turnstile/v0/siteverify",{method:"POST",body:params},deadline);
  if(r.ok){const d=r.data;ok=d?.success===true&&d.hostname===url.hostname&&d.action==="submission"}
 }catch{}
 if(!ok)return reply({message:"人机验证失败或过期，请重新验证。"},403);
 const marker=await submissionMarker(link),headers=githubHeaders(env);
 const existing=inFlightSubmissions.get(marker);
 if(existing){const response=await existing;if(response.status===201)return reply({...await response.clone().json(),duplicate:true});return response.clone()}
 const submit=async()=>{
 try{
  for(let page=1;page<=10;page++){
   const listed=await upstream(GITHUB_ISSUES+"?state=all&per_page=100&page="+page,{method:"GET",headers},deadline);
   if(!listed.ok)return githubError(listed.status);
   if(!Array.isArray(listed.data))return githubError();
   const duplicate=listed.data.find(issue=>matchesSubmission(issue,marker,link));
   if(duplicate){if(!validIssue(duplicate))return githubError();return reply({ok:true,duplicate:true,issue_url:duplicate.html_url,issue_number:duplicate.number})}
   if(!listed.next)break;
   if(page===10)return reply({message:"投稿服务繁忙，请稍后再试。"},503);
  }
 }catch{return githubError()}
 const body=["<!-- freeegg-website-submission -->",marker,"## 活动名称",provider,"","## 官方链接",link,"","## 类型",kind,"","## 免费额度",credits||"未填写","","## 支持模型",models||"未填写","","## 领取条件",requirements||"未填写","","## 补充信息",details,"","---","来源：免费鸡蛋篮站内投稿。未经核实，不得直接加入有效列表。"].join("\n");
 let response;
 try{response=await upstream(GITHUB_ISSUES,{method:"POST",headers,body:JSON.stringify({title:"[投稿] "+provider,body})},deadline)}
 catch{return reply({message:"GitHub 暂时无法连接，请稍后重试。"},502)}
 if(!response.ok)return githubError(response.status);
 const issue=response.data;
 if(!validIssue(issue))return reply({message:"GitHub 返回异常，请检查投稿状态。"},502);
 return reply({ok:true,issue_url:issue.html_url,issue_number:issue.number},201);
 };
 const pending=submit();inFlightSubmissions.set(marker,pending);
 try{return (await pending).clone()}finally{inFlightSubmissions.delete(marker)}
}};
