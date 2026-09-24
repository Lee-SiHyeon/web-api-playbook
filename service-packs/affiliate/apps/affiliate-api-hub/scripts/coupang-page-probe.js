(()=>{
  document.title='COS_COUPANG_PROBE';
  const safeUrl=(raw)=>{
    try{
      const u=new URL(raw,location.href);
      return {
        origin:u.origin,
        path:u.pathname,
        queryFields:[...new Set([...u.searchParams.keys()])].sort(),
        hashPath:u.hash?u.hash.replace(/[?#].*$/,'').slice(0,200):''
      };
    }catch{return null;}
  };
  const uniq=(items,key)=>[...new Map(items.filter(Boolean).map(x=>[key(x),x])).values()];
  const text=x=>(x||'').replace(/\s+/g,' ').trim().slice(0,160);
  const links=uniq([...document.querySelectorAll('a[href]')].slice(0,800).map(a=>{
    const u=safeUrl(a.href);
    return u?{label:text(a.innerText||a.getAttribute('aria-label')||a.title),...u}:null;
  }),x=>JSON.stringify(x));
  const forms=[...document.forms].slice(0,100).map(f=>{
    const u=safeUrl(f.action||location.href);
    return {
      method:(f.method||'GET').toUpperCase(),
      ...(u||{}),
      fieldNames:[...new Set([...f.elements].map(e=>e.name).filter(Boolean))].sort().slice(0,500)
    };
  });
  const scripts=uniq([...document.scripts].map(s=>safeUrl(s.src)).filter(Boolean),x=>JSON.stringify(x));
  const frames=uniq([...document.querySelectorAll('iframe[src]')].map(f=>safeUrl(f.src)).filter(Boolean),x=>JSON.stringify(x));
  const resources=uniq(performance.getEntriesByType('resource').slice(-2000).map(e=>{
    const u=safeUrl(e.name);
    return u?{
      initiatorType:e.initiatorType||null,
      ...u,
      durationMs:Math.round(e.duration||0),
      transferSize:Number.isFinite(e.transferSize)?e.transferSize:null
    }:null;
  }),x=>`${x.initiatorType}|${x.origin}|${x.path}|${x.queryFields.join(',')}`);
  const interestingGlobals=Object.keys(window).filter(k=>/(api|affiliate|partner|product|link|report|commission|campaign|promotion)/i.test(k)).sort().slice(0,300);
  const data={
    schemaVersion:1,
    checkedAt:new Date().toISOString(),
    mode:'logged_in_browser_metadata_only',
    page:{title:document.title,...safeUrl(location.href)},
    loginSignals:{
      hasMyInfo:[...document.querySelectorAll('a,button')].some(e=>/\uB0B4\s*\uC815\uBCF4/.test(e.textContent||'')),
      hasReport:[...document.querySelectorAll('a,button')].some(e=>/\uB9AC\uD3EC\uD2B8/.test(e.textContent||'')),
      hasLoginForm:Boolean(document.querySelector('input[type=password],form[action*=login]'))
    },
    links,forms,scripts,frames,resources,
    storageKeys:{
      local:[...Array(localStorage.length)].map((_,i)=>localStorage.key(i)).filter(Boolean).sort(),
      session:[...Array(sessionStorage.length)].map((_,i)=>sessionStorage.key(i)).filter(Boolean).sort()
    },
    interestingGlobals,
    cookieValuesCaptured:false,
    storageValuesCaptured:false,
    responseBodiesCaptured:false,
    mutationRequestsSent:0
  };
  const blob=new Blob([JSON.stringify(data,null,2)+'\n'],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=`coupang-partners-page-${new Date().toISOString().replace(/[-:.]/g,'')}.json`;
  document.documentElement.appendChild(a);
  a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},1000);
  return true;
})()
