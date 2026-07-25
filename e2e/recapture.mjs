import { chromium } from 'playwright-core';
import fs from 'node:fs';
const CHROME='/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';
const BASE='http://127.0.0.1:3210';
const ids=JSON.parse(fs.readFileSync('e2e/ids.json','utf8'));
const b=await chromium.launch({executablePath:CHROME,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
async function grab(uid,view,fn,out){
  const ctx=await b.newContext({viewport:{width:1200,height:1500}});
  await ctx.route('**/*',(r)=>{const u=r.request().url();return (u.startsWith(BASE)||u.startsWith('data:'))?r.continue():r.abort();});
  const p=await ctx.newPage();
  await p.addInitScript((id)=>{try{localStorage.setItem('3jn_uid',id)}catch{}},uid);
  await p.goto(BASE+'/index.html',{waitUntil:'domcontentloaded'});
  await p.waitForTimeout(1800);
  if(fn) await p.evaluate(fn); await p.waitForTimeout(1200);
  await p.screenshot({path:out,fullPage:false,type:'jpeg',quality:72});
  await ctx.close();
  console.log('saved',out);
}
await grab(ids.userId,'home',()=>window.nav('home'),'screenshots/13-user-home.jpg');
await grab(ids.adminId,'comms',()=>window.nav('comms'),'screenshots/12-admin-comms.jpg');
await b.close();
