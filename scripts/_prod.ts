async function main(){
  const base="https://serve-os-puce.vercel.app";
  const r0=await fetch(base+"/login");
  console.log("GET /login:", r0.status);
  const html=await r0.text();
  const m=html.match(/\$ACTION_ID_([0-9a-f]+)/);
  if(!m){ console.log("NO action id found. body head:", html.slice(0,300)); return; }
  const id=m[1];
  const fd=new FormData(); fd.set("$ACTION_ID_"+id,"");
  fd.set("slug","roma"); fd.set("email","owner@roma.com"); fd.set("password","owner1234");
  const res=await fetch(base+"/login",{
    method:"POST",
    headers:{ "Origin": base, "Referer": base+"/login" },
    body:fd, redirect:"manual",
  });
  console.log("POST /login:", res.status, "->", res.headers.get("location"));
  console.log("set-cookie:", (res.headers.get("set-cookie")||"(none)").slice(0,50));
  const body=await res.text();
  if(res.status>=400 || res.status<300){
    console.log("--- body (first 600) ---");
    console.log(body.slice(0,600));
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error("FETCH ERR",e);process.exit(1);});
