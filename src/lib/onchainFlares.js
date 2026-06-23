const ORDINALS = "https://ordinals.com";
const ENGINE_URL = `${ORDINALS}/content/3b9622bdda52287f457c84da8547eef6e0f4e64282567692111f214f27613eb6i0`;
const THREE_MODULE_URL = `${ORDINALS}/content/8f968eb8ada1bf6275e6f8a27361a6b462a951b0102951e0fe7d30dec1d07dd4i0`;
const WATER_MAP_1 = `${ORDINALS}/content/eb36c3cec7f3115b4d7403caf7dd7102c10ef81bef01e897bc6aff5e8c109a8ci0`;
const WATER_MAP_2 = `${ORDINALS}/content/b9e58b1a257db9d743bfcbbbed1b9fdd2594710dbc1dcb4b552542851794b67ai0`;

let engineSourcePromise = null;

export async function fetchCurrentBlockHeight() {
  const response = await fetch(`${ORDINALS}/blockheight`, { mode: "cors" });
  if (!response.ok) {
    throw new Error(`Could not fetch block height (${response.status}).`);
  }
  return Number(await response.text());
}

export async function resolveSeedIndex(flare) {
  if (Number.isFinite(flare?.seedIndex)) return flare.seedIndex;
  if (!flare?.inscriptionId) {
    throw new Error("This FLARE does not have an inscription id.");
  }

  const response = await fetch(`${ORDINALS}/content/${flare.inscriptionId}`, {
    mode: "cors"
  });
  if (!response.ok) {
    throw new Error(`Could not fetch inscription wrapper (${response.status}).`);
  }

  const html = await response.text();
  const match = html.match(/data-id=["'](\d+)["']/);
  if (!match) {
    throw new Error("The inscription wrapper did not expose a FLARES seed id.");
  }
  return Number(match[1]);
}

export async function generateOnchainHeightMap({
  seedIndex,
  blockHeight,
  width,
  height,
  signal
}) {
  if (!Number.isFinite(seedIndex)) {
    throw new Error("A resolved FLARES seed index is required.");
  }
  if (!Number.isFinite(blockHeight)) {
    throw new Error("A numeric Bitcoin block height is required.");
  }

  const engineSource = await getPatchedEngineSource(blockHeight, signal);
  signal?.throwIfAborted();

  const iframe = document.createElement("iframe");
  iframe.title = "FLARES on-chain terrain sampler";
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = [
    "position:fixed",
    "left:-4096px",
    "top:-4096px",
    "width:512px",
    "height:512px",
    "opacity:0",
    "pointer-events:none",
    "border:0"
  ].join(";");
  iframe.sandbox = "allow-scripts allow-same-origin";

  const cleanup = () => {
    iframe.remove();
  };

  try {
    const loadPromise = new Promise((resolve, reject) => {
      iframe.addEventListener("load", resolve, { once: true });
      iframe.addEventListener("error", () => reject(new Error("FLARES frame failed to load.")), {
        once: true
      });
    });

    document.body.appendChild(iframe);
    iframe.srcdoc = buildSrcDoc(seedIndex, blockHeight, engineSource);
    await loadPromise;
    signal?.throwIfAborted();

    const runtime = await waitForRuntime(iframe, signal);
    const sampled = await requestDepthSample(iframe, width, height, signal);
    signal?.throwIfAborted();

    if (!sampled?.values?.length) {
      throw new Error("The FLARES displacement texture was empty.");
    }

    return {
      width,
      height,
      values: Float32Array.from(sampled.values),
      sourceWidth: sampled.sourceWidth,
      sourceHeight: sampled.sourceHeight,
      seedIndex,
      blockHeight,
      meta: sampled.meta ?? runtime.getMeta()
    };
  } finally {
    cleanup();
  }
}

async function getPatchedEngineSource(blockHeight, signal) {
  if (!engineSourcePromise) {
    engineSourcePromise = fetch(ENGINE_URL, { mode: "cors" })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Could not fetch FLARES engine (${response.status}).`);
        }
        return response.text();
      })
      .then(inflateGzipBase64)
      .then(patchEngineSource)
      .catch((error) => {
        engineSourcePromise = null;
        throw error;
      });
  }

  const source = await engineSourcePromise;
  signal?.throwIfAborted();
  return source.replace(
    "__PHYSICALFLARE_BLOCK_HEIGHT__",
    JSON.stringify(String(Math.round(blockHeight)))
  );
}

async function inflateGzipBase64(base64) {
  if (!("DecompressionStream" in window)) {
    throw new Error("This browser does not support DecompressionStream for the on-chain engine.");
  }

  const bytes = Uint8Array.from(atob(base64.trim()), (char) => char.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

function patchEngineSource(source) {
  const runtimeHook = `
window.__PHYSICALFLARE_RUNTIME={
  seed:f,
  renderer:n,
  compute:y,
  island:k,
  getMeta:()=>({
    seedIndex,
    blockHeight:__PHYSICALFLARE_BLOCK_HEIGHT__,
    name:f?.Name,
    terrain:f?.Terreno,
    fl:f?.fl
  }),
  isDepthReady:()=>Boolean(k?.defMat?.displacementMap),
  sampleDepth:(sampleWidth,sampleHeight)=>{
    const pass=r.compute.getPass("Blur");
    const target=pass?.backRenderTarget||pass?.renderTarget;
    if(!target) throw new Error("FLARES Blur render target is unavailable.");
    if(!target.texture||typeof target.texture!=="object") throw new Error("FLARES readback target texture is not an object: "+JSON.stringify({keys:Object.keys(target),constructor:target?.constructor?.name,type:typeof target,textureType:typeof target.texture,textureValue:String(target.texture)}));
    const sourceWidth=target.width;
    const sourceHeight=target.height;
    let raw;
    let rawType="half";
    try{
      raw=new Uint16Array(sourceWidth*sourceHeight*4);
      n.setRenderTarget(null);
      n.readRenderTargetPixels(target,0,0,sourceWidth,sourceHeight,raw);
    }catch(error){
      try{
        rawType="float";
        raw=new Float32Array(sourceWidth*sourceHeight*4);
        n.setRenderTarget(null);
        n.readRenderTargetPixels(target,0,0,sourceWidth,sourceHeight,raw);
      }catch(secondError){
        rawType="byte";
        raw=new Uint8Array(sourceWidth*sourceHeight*4);
        n.setRenderTarget(null);
        n.readRenderTargetPixels(target,0,0,sourceWidth,sourceHeight,raw);
      }
    }
    const halfToFloat=(h)=>{
      const s=(h&0x8000)>>15;
      const e=(h&0x7c00)>>10;
      const f=h&0x03ff;
      if(e===0) return (s?-1:1)*Math.pow(2,-14)*(f/1024);
      if(e===31) return f?NaN:((s?-1:1)*Infinity);
      return (s?-1:1)*Math.pow(2,e-15)*(1+f/1024);
    };
    const readValue=(index)=>{
      const value=raw[index];
      if(rawType==="byte") return value/255;
      if(rawType==="float") return value;
      return halfToFloat(value);
    };
    const values=new Array(sampleWidth*sampleHeight);
    for(let yy=0;yy<sampleHeight;yy++){
      const v=sampleHeight<=1?0:yy/(sampleHeight-1);
      const sy=Math.max(0,Math.min(sourceHeight-1,Math.round((1-v)*(sourceHeight-1))));
      for(let xx=0;xx<sampleWidth;xx++){
        const u=sampleWidth<=1?0:xx/(sampleWidth-1);
        const sx=Math.max(0,Math.min(sourceWidth-1,Math.round(u*(sourceWidth-1))));
        const value=readValue((sy*sourceWidth+sx)*4);
        values[yy*sampleWidth+xx]=Math.max(0,Math.min(1,Number.isFinite(value)?value:0));
      }
    }
    return {width:sampleWidth,height:sampleHeight,sourceWidth,sourceHeight,rawType,values,meta:window.__PHYSICALFLARE_RUNTIME.getMeta?.()};
  }
};
window.addEventListener("message",(event)=>{
  const message=event.data;
  if(!message||message.type!=="physicalflare-sample-depth") return;
  try{
    const result=window.__PHYSICALFLARE_RUNTIME.sampleDepth(message.width,message.height);
    event.source?.postMessage({type:"physicalflare-sample-depth-result",id:message.id,result},"*");
  }catch(error){
    event.source?.postMessage({type:"physicalflare-sample-depth-result",id:message.id,error:{message:error.message,stack:error.stack}},"*");
  }
});`;

  return source
    .replace(
      `from"/content/8f968eb8ada1bf6275e6f8a27361a6b462a951b0102951e0fe7d30dec1d07dd4i0"`,
      `from"${THREE_MODULE_URL}"`
    )
    .replaceAll(`"/content/"+`, `"${ORDINALS}/content/"+`)
    .replace(`ORDINAL_URL="/content/"`, `ORDINAL_URL="${ORDINALS}/content/"`)
    .replace(`T&&(T=!1,r.dispose(),g.dispose(),b.dispose(),t=!0)`, `T&&(T=!1,t=!0)`)
    .replace(`M.water=k.water;let R=!0`, `M.water=k.water;${runtimeHook}let R=!0`)
    .replace(`document.body.onload=onLoad;`, `onLoad();`);
}

function buildSrcDoc(seedIndex, blockHeight, engineSource) {
  const escapedEngine = engineSource.replace(/<\/script/gi, "<\\/script");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body, #scene { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #000; }
      canvas { display: block; }
    </style>
  </head>
  <body>
    <div id="scene"></div>
    <script>
      const seedIndex = ${JSON.stringify(seedIndex)};
      const ogBlockHeight = "830162";
      const waterMap1 = ${JSON.stringify(WATER_MAP_1)};
      const waterMap2 = ${JSON.stringify(WATER_MAP_2)};
      const blockHeightRes = { json: async () => ${JSON.stringify(String(blockHeight))} };
    </script>
    <script type="module">${escapedEngine}</script>
  </body>
</html>`;
}

async function waitForRuntime(iframe, signal) {
  const startedAt = performance.now();
  let lastError = null;

  while (performance.now() - startedAt < 30000) {
    signal?.throwIfAborted();
    const runtime = iframe.contentWindow?.__PHYSICALFLARE_RUNTIME;
    if (runtime?.isDepthReady?.()) {
      return runtime;
    }

    lastError = iframe.contentWindow?.__PHYSICALFLARE_ERROR ?? lastError;
    await new Promise((resolve) => window.setTimeout(resolve, 120));
  }

  throw new Error(lastError || "Timed out while running the FLARES on-chain terrain engine.");
}

function requestDepthSample(iframe, width, height, signal) {
  const id = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", handleMessage);
      reject(new Error("Timed out while sampling the FLARES displacement target."));
    }, 15000);

    const abort = () => {
      window.clearTimeout(timeout);
      window.removeEventListener("message", handleMessage);
      reject(new DOMException("Sampling was aborted.", "AbortError"));
    };

    const handleMessage = (event) => {
      if (event.source !== iframe.contentWindow) return;
      const message = event.data;
      if (message?.type !== "physicalflare-sample-depth-result" || message.id !== id) return;

      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      window.removeEventListener("message", handleMessage);

      if (message.error) {
        const error = new Error(message.error.message);
        error.stack = message.error.stack;
        reject(error);
        return;
      }

      resolve(message.result);
    };

    signal?.addEventListener("abort", abort, { once: true });
    window.addEventListener("message", handleMessage);
    iframe.contentWindow?.postMessage(
      { type: "physicalflare-sample-depth", id, width, height },
      "*"
    );
  });
}
