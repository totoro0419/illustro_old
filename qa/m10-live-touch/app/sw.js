const params=new URL(self.location.href).searchParams;
const build=(params.get('build')||'dev').replace(/[^A-Za-z0-9._-]/g,'_');
const CACHE_PREFIX='illustro-m05-';
const CACHE_NAME=CACHE_PREFIX+build;
const scopeUrl=new URL('./',self.location.href).href;
const indexUrl=new URL('./index.html',self.location.href).href;

self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE_NAME);
    const response=await fetch(scopeUrl,{cache:'reload'});
    if(!response.ok)throw new Error('M05 app shell fetch failed');
    await cache.put(scopeUrl,response.clone());
    await cache.put(indexUrl,response.clone());
    const html=await response.text(),urls=new Set([scopeUrl,indexUrl,new URL('./offline-assets.json',scopeUrl).href]);
    for(const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)){
      const raw=match[1];if(!raw||raw.startsWith('data:')||raw.startsWith('#'))continue;
      const url=new URL(raw,scopeUrl);if(url.origin===self.location.origin&&url.href.startsWith(scopeUrl))urls.add(url.href);
    }
    const manifestUrl=new URL('./offline-assets.json',scopeUrl).href;
    try{
      const manifestResponse=await fetch(manifestUrl,{cache:'reload'});
      if(!manifestResponse.ok)throw new Error('M05 offline asset manifest fetch failed');
      const manifest=await manifestResponse.clone().json();
      if(!manifest||manifest.version!==1||!Array.isArray(manifest.assets))throw new Error('M05 offline asset manifest is invalid');
      await cache.put(manifestUrl,manifestResponse);
      for(const name of manifest.assets){
        if(typeof name!=='string'||name.includes('..'))throw new Error('M05 offline asset path is invalid');
        const url=new URL(name,scopeUrl);if(url.origin!==self.location.origin||!url.href.startsWith(scopeUrl))throw new Error('M05 offline asset escaped scope');
        urls.add(url.href);
      }
    }catch(error){
      throw error;
    }
    await Promise.all([...urls].map(async url=>{
      if(url===scopeUrl||url===indexUrl||url===manifestUrl)return;
      const asset=await fetch(url,{cache:'reload'});if(!asset.ok)throw new Error('M05 offline asset fetch failed: '+url);await cache.put(url,asset);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(key=>key.startsWith(CACHE_PREFIX)&&key!==CACHE_NAME).map(key=>caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch',event=>{
  const request=event.request;if(request.method!=='GET')return;
  const url=new URL(request.url);if(url.origin!==self.location.origin||!url.href.startsWith(scopeUrl))return;
  if(request.mode==='navigate'){
    event.respondWith((async()=>{
      const cache=await caches.open(CACHE_NAME);
      try{
        const fresh=await fetch(request);
        if(fresh.ok){await cache.put(scopeUrl,fresh.clone());await cache.put(indexUrl,fresh.clone());}
        return fresh;
      }catch{
        return (await cache.match(scopeUrl))??(await cache.match(indexUrl))??Response.error();
      }
    })());return;
  }
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE_NAME),cached=await cache.match(request,{ignoreSearch:false});
    if(cached)return cached;
    try{
      const fresh=await fetch(request);
      if(fresh.ok&&(fresh.type==='basic'||fresh.type==='cors'))await cache.put(request,fresh.clone());
      return fresh;
    }catch{
      const withoutSearch=new Request(url.origin+url.pathname,{method:'GET',headers:request.headers,mode:'same-origin',credentials:'same-origin'});
      return (await cache.match(withoutSearch,{ignoreSearch:true}))??Response.error();
    }
  })());
});
