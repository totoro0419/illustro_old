import fs from 'node:fs/promises';
import path from 'node:path';
import {stripTypeScriptTypes} from 'node:module';
const root=path.resolve(import.meta.dirname,'../..'),out=path.join(root,'prototypes/brush-rt/dist');
await fs.mkdir(out,{recursive:true});
const sources=new Map;
for(const name of ['types','input','dynamics','random','math','coverage','record']){let code=stripTypeScriptTypes(await fs.readFile(path.join(root,'packages/brush/src',name+'.ts'),'utf8'));code=code.replace(/from\s+["']\.\/(\w+)["']/g,(_,n)=>`from '@legacy/${n}'`);sources.set('@legacy/'+name,code);}
for(const name of ['baseline-shaders','foundation','model','shaders','minification','preview-policy','stroke-overlay','reference-feedback','history-io','history.worker','tile-history','renderer','session','drawing-host','viewport-scene','standby-picture','drawing.worker','worker-stroke-sink','presentation-tiles','presentation.worker','document-presentation','index','canonical.worker','ui'])sources.set('@rt/'+name,await fs.readFile(path.join(root,name==='ui'?'prototypes/brush-rt/ui.mjs':'packages/brush-rt/src/'+name+'.mjs'),'utf8'));
// Blob module graph assembled topologically for a self-contained downloaded HTML.
// Worker modules cannot use document import maps, so their graph is resolved separately.
function moduleGraph(code,registry,cache=new Map){return code.replace(/from\s+["'](@(?:rt|legacy)\/[\w-]+)["']/g,(_,id)=>{if(!cache.has(id)){const source=registry.get(id);if(!source)throw Error('missing module '+id);cache.set(id,'data:text/javascript;base64,'+Buffer.from(moduleGraph(source,registry,cache)).toString('base64'));}return `from '${cache.get(id)}'`;});}
const worker=moduleGraph(await fs.readFile(path.join(root,'packages/brush-rt/src/canonical.worker.mjs'),'utf8'),sources);
const map=Object.fromEntries([...sources].map(([id,code])=>[id,'data:text/javascript;base64,'+Buffer.from(code).toString('base64')]));
let html=await fs.readFile(path.join(root,'prototypes/brush-rt/index.html'),'utf8');
html=html.replace('<!-- MODULES -->',`<script type="importmap">${JSON.stringify({imports:map}).replaceAll('<','\\u003c')}</script><script>window.__workerSource=${JSON.stringify(worker).replaceAll('<','\\u003c')};</script><script type="module">import {boot} from '@rt/ui';boot();</script>`);
// Standalone prototype is an accepted, frozen artifact. Building the editor
// must not overwrite it; an explicit opt-in is required to regenerate it.
if(process.env.ILLUSTRO_REBUILD_STANDALONE==='1')
  await fs.writeFile(path.join(out,'illustro-brush-rt.html'),html);
// Node tests use the same source transpilation without browser-specific import maps.
for(const base of [out,path.join(root,'packages/brush-rt/dist')])for(const [id,code]of sources){const target=path.join(base,id.slice(1)+'.mjs');await fs.mkdir(path.dirname(target),{recursive:true});const local=code.replace(/from\s+["'](@(?:rt|legacy)\/[\w-]+)["']/g,(_,dep)=>`from '${path.relative(path.dirname(target),path.join(base,dep.slice(1)+'.mjs')).replaceAll('\\','/').replace(/^(?!\.)/,'./')}'`);await fs.writeFile(target,local);}
console.log('Built self-contained HTML:',(await fs.stat(path.join(out,'illustro-brush-rt.html'))).size,'bytes');

const bundle=await fs.readFile(path.join(out,'illustro-brush-rt.html'));
const {createHash}=await import('node:crypto');
const blobHash=createHash('sha1').update(Buffer.from('blob '+bundle.length+String.fromCharCode(0))).update(bundle).digest('hex');
const encoded=bundle.toString('base64');
console.log('RT_BUNDLE_META:'+JSON.stringify({bytes:bundle.length,base64Length:encoded.length,blobHash}));
for(let i=0;i<encoded.length;i+=4000)console.log('RT_BUNDLE:'+i+':'+encoded.slice(i,i+4000));
