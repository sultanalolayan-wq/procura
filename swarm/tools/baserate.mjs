import { CsvFeed } from '/home/user/procura/swarm/dist/src/market/csv.js';
import { windowDistribution } from '/home/user/procura/swarm/dist/src/market/report.js';
import { nullLogger } from '/home/user/procura/swarm/dist/src/core/logger.js';
import { readdirSync, existsSync } from 'node:fs';
const W=10; let gW=0,gT=0; const all=[];
for (const era of ['dotcom2000','covid2020','meme2021','gfc2008']) {
  const dir=`/tmp/ares_era/${era}`; if(!existsSync(`${dir}/market/us`)) continue;
  const feed=new CsvFeed({dataDir:dir, logger:nullLogger});
  let w=0,t=0,best={bps:-1e9,s:''};
  for (const f of readdirSync(`${dir}/market/us`)) {
    const s=f.slice(0,-4).toUpperCase();
    const d=await windowDistribution(feed,{symbol:s,venue:'US'},W,{targetBps:10_000, notionalMinor:133_300});
    if(!d.windows) continue;
    w+=d.windows; const hits=Math.round(d.fractionAtTarget*d.windows); t+=hits;
    if(d.maxBps>best.bps) best={bps:d.maxBps,s};
    if(hits>0) all.push({era,s,hits,max:d.maxBps});
    if(d.minBps < -10000) console.log(`  !! ${era}/${s} min ${d.minBps}bps — IMPOSSIBLE, data gap`);
  }
  gW+=w; gT+=t;
  console.log(`${era.padEnd(12)} windows=${String(w).padStart(6)}  >=+100%: ${String(t).padStart(3)}  (${(t/w*100).toFixed(4)}%)  best=${best.s} ${(best.bps/100).toFixed(1)}%`);
}
console.log(`\n=== COMBINED BASE RATE (contiguous series only) ===`);
console.log(`${gT} of ${gW.toLocaleString()} rolling 10-session windows reached +100%  =  ${(gT/gW*100).toFixed(4)}%`);
if(all.length){ console.log('\nwindows that DID double:'); for(const a of all) console.log(`  ${a.era}/${a.s}: ${a.hits} window(s), best +${(a.max/100).toFixed(1)}%`); }
