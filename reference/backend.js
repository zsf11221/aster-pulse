const WALLET='0xa0edBaBcb48034e368de286b49F9603C7AfA1b60';
const HOST='https://fapi.asterdex.com/fapi/v1/';
const DAY=86400000;
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
async function remote(url,body){let r=await fetch(url,{signal:AbortSignal.timeout(20000),headers:{'Content-Type':'application/json'},...(body?{method:'POST',body:JSON.stringify(body)}:{})});if(!r.ok)throw Error('上游 HTTP '+r.status);let d=await r.json();if(d.error||d.code<0)throw Error(d.error?.message||d.msg||'数据源错误');return d}
async function cached(env,key,ttl,fn){let old;try{const o=await env.BUCKET.get(key);if(o)old=await o.json()}catch{}if(old&&Date.now()-old.updatedAt<ttl)return {...old,stale:false};try{let v={...(await fn()),updatedAt:Date.now()};await env.BUCKET.put(key,JSON.stringify(v));return {...v,stale:false}}catch(e){if(old)return {...old,stale:true,error:e.message};throw e}}
async function markets(env){return cached(env,'market-v3.json',30000,async()=>{const [e,t]=await Promise.all([remote(HOST+'exchangeInfo'),remote(HOST+'ticker/24hr')]);if(!Array.isArray(e.symbols)||!Array.isArray(t))throw Error('行情格式异常');let previous;try{previous=await(await env.BUCKET.get('symbols.json'))?.json()}catch{}const names=e.symbols.map(x=>x.symbol);await env.BUCKET.put('symbols.json',JSON.stringify({names,checkedAt:Date.now(),firstCheckedAt:previous?.firstCheckedAt||Date.now()}));let tick=Object.fromEntries(t.map(x=>[x.symbol,x]));let rows=e.symbols.filter(x=>x.quoteAsset==='USDT'&&x.onboardDate<=Date.now()&&['TRADING','SETTLING'].includes(x.status)).sort((a,b)=>b.onboardDate-a.onboardDate).map(x=>({name:x.baseAsset,symbol:x.symbol,onboard:x.onboardDate,status:x.status,price:tick[x.symbol]?.lastPrice??null,change24:Number(tick[x.symbol]?.openPrice)>0&&Number(tick[x.symbol]?.lastPrice)>0?(Number(tick[x.symbol].lastPrice)/Number(tick[x.symbol].openPrice)-1)*100:null,volume:tick[x.symbol]?.quoteVolume??null,discovered:!!previous&&!previous.names.includes(x.symbol)}));return {rows,firstCheckedAt:previous?.firstCheckedAt||Date.now(),source:HOST+'exchangeInfo',minQuoteVolume:100000,peakListedSince:Date.parse('2026-06-01T00:00:00+08:00')}})}
async function detail(env,symbol){if(!/^[\p{L}\p{N}_]{1,40}$/u.test(symbol))throw Error('币种参数无效');return cached(env,'detail-v2-'+encodeURIComponent(symbol)+'.json',300000,async()=>{const e=await remote(HOST+'exchangeInfo');let s=e.symbols.find(x=>x.symbol===symbol);if(!s)throw Error('合约不存在');let cursor=Math.floor(s.onboardDate/DAY)*DAY,all=[];for(let page=0;page<10;page++){let k=await remote(HOST+'klines?'+new URLSearchParams({symbol,interval:'1d',startTime:String(cursor),limit:'1500'}));if(!Array.isArray(k))throw Error('K线格式异常');all.push(...k.filter(x=>Number(x[8])>0));if(k.length<1500)break;cursor=k[k.length-1][6]+1;if(page===9)throw Error('历史数据尚未完整读取')}if(!all.length)throw Error('尚无成交K线');all.sort((a,b)=>a[0]-b[0]);if(Number(all[0][0])!==Math.floor(s.onboardDate/DAY)*DAY)throw Error('上线首日K线缺失，无法确认完整历史涨幅');let p=await remote(HOST+'ticker/price?'+new URLSearchParams({symbol}));const open=Number(all[0][1]),high=Math.max(...all.map(x=>Number(x[2])));if(!(open>0&&high>=open&&Number(p.price)>0))throw Error('历史价格无效');return {symbol,onboard:s.onboardDate,open,high,price:Number(p.price),priceTime:p.time,peak:(high/open-1)*100,now:(Number(p.price)/open-1)*100,drawdown:(Number(p.price)/high-1)*100,firstCandle:all[0][0]}})}
async function announcements(env){return cached(env,'announcements.json',60000,async()=>{let r=await remote('https://www.asterdex.com/bapi/composite/v1/public/composite/ae/announcement/search',{page:1,size:15,category:'NEW_LISTING'});if(!Array.isArray(r.data?.rows))throw Error('公告格式异常');return {rows:r.data.rows.map(x=>({id:x.id,title:x.title,publishTime:x.publishTime})),source:'Aster 官方公告'}})}
async function buyback(env){return cached(env,'buyback.json',300000,async()=>{const end=Date.now(),today=Math.floor((end+8*3600000)/DAY)*DAY-8*3600000,start=today-6*DAY;let calls=0;async function range(a,b){if(++calls>100)throw Error('成交过密，暂不能确认完整统计');const d=await remote('https://tapi.asterdex.com/info',{jsonrpc:'2.0',id:1,method:'aster_spotUserFills',params:[WALLET,'ASTERUSDT',a,b,'latest']});const r=d.result;if(!r||!Array.isArray(r.fills)||r.accountPrivacy!=='disabled')throw Error('成交数据不可用或账户开启隐私');if(r.fills.length>=1000){if(b-a<=1000)throw Error('单秒成交触及上限，统计不完整');let m=Math.floor((a+b)/2);return [...await range(a,m),...await range(m+1,b)]}return r.fills.filter(x=>x.time>=a&&x.time<=b)}const days=[];for(let i=0;i<7;i++){let a=start+i*DAY,b=Math.min(end,a+DAY-1);let f=await range(a,b);let buys=f.filter(x=>x.side==='BUY'&&x.symbol==='ASTERUSDT');days.push({day:new Date(a+8*3600000).toISOString().slice(0,10),qty:buys.reduce((s,x)=>s+Number(x.qty),0),spent:buys.reduce((s,x)=>s+Number(x.qty)*Number(x.price),0),count:buys.length,sellCount:f.filter(x=>x.side==='SELL').length})}return {wallet:WALLET,days,start,end,scope:'该钱包公开可查询的 ASTER/USDT 现货买入成交，金额未含手续费',source:'https://tapi.asterdex.com/info'}})}

async function tokenStats(env){const [priceRes,stakeRes]=await Promise.allSettled([cached(env,'token-price.json',30000,async()=>{const t=await remote(HOST+'ticker/24hr?symbol=ASTERUSDT');const price=Number(t.lastPrice),change24=Number(t.priceChangePercent);if(!Number.isFinite(price)||price<=0||!Number.isFinite(change24))throw Error('ASTER 行情格式异常');return {price,change24,priceTime:t.closeTime??Date.now(),source:'fapi.asterdex.com/fapi/v1/ticker/24hr (ASTERUSDT 永续)'}}),cached(env,'token-staked.json',300000,async()=>{const d=await remote('https://api.llama.fi/protocol/aster');const series=d?.chainTvls?.staking?.tvl;if(!Array.isArray(series)||!series.length)throw Error('质押数据格式异常');const last=series[series.length-1];const usd=Number(last.totalLiquidityUSD);if(!Number.isFinite(usd)||usd<=0)throw Error('质押数据格式异常');return {stakedUsd:usd,stakedAt:Number(last.date)*1000,source:'api.llama.fi/protocol/aster (DefiLlama 质押 TVL，美元)'}})]);const p=priceRes.status==='fulfilled'?priceRes.value:null;const st=stakeRes.status==='fulfilled'?stakeRes.value:null;if(!p&&!st)throw Error((priceRes.reason?.message||'价格不可用')+' / '+(stakeRes.reason?.message||'质押不可用'));const price=p?p.price:null;const staked=(st&&price)?st.stakedUsd/price:null;return {price,change24:p?p.change24:null,priceTime:p?p.priceTime:null,priceStale:p?!!p.stale:false,priceError:p?null:(priceRes.reason?.message||'价格暂不可用'),staked,stakedUsd:st?st.stakedUsd:null,stakedAt:st?st.stakedAt:null,stakedStale:st?!!st.stale:false,stakedError:st?null:(stakeRes.reason?.message||'质押暂不可用'),stakedSource:'DefiLlama 质押 TVL（美元）÷ 本站 ASTER 永续价换算；官方质押页未提供公开总量接口',stale:!!(p?.stale||st?.stale||!p||!st),source:'fapi.asterdex.com/fapi/v1/ticker/24hr + api.llama.fi/protocol/aster',updatedAt:Math.max(p?.updatedAt||0,st?.updatedAt||0)}}

async function marketDetail(env,symbol){if(!/^[\p{L}\p{N}_]{1,40}$/u.test(symbol))throw Error('币种参数无效');return cached(env,'market-detail-'+encodeURIComponent(symbol)+'.json',30000,async()=>{const [ticker,oi]=await Promise.allSettled([remote(HOST+'ticker/24hr?'+new URLSearchParams({symbol})),remote(HOST+'openInterest?'+new URLSearchParams({symbol}))]);const t=ticker.status==='fulfilled'?ticker.value:null,o=oi.status==='fulfilled'?oi.value:null;const valid=v=>v!=null&&v!==''&&Number.isFinite(Number(v));return {symbol,price:valid(t?.lastPrice)?t.lastPrice:null,change24:Number(t?.openPrice)>0&&Number(t?.lastPrice)>0?(Number(t.lastPrice)/Number(t.openPrice)-1)*100:null,quoteVolume:valid(t?.quoteVolume)?t.quoteVolume:null,baseVolume:valid(t?.volume)?t.volume:null,highPrice:valid(t?.highPrice)?t.highPrice:null,lowPrice:valid(t?.lowPrice)?t.lowPrice:null,tickerTime:t?.closeTime??null,openInterest:valid(o?.openInterest)&&Number(o.openInterest)>=0?o.openInterest:null,interestTime:o?.time??null,tickerError:t?null:(ticker.reason?.message||'行情暂不可用'),interestError:valid(o?.openInterest)?null:(oi.reason?.message||'未平仓量暂不可用'),source:HOST}})}

async function activities(env){return cached(env,'activities.json',60000,async()=>{const r=await remote('https://www.asterdex.com/bapi/composite/v1/public/composite/ae/announcement/search',{page:1,size:12,category:'ACTIVITY'});if(!Array.isArray(r.data?.rows))throw Error('活动公告格式异常');return {rows:r.data.rows.filter(x=>x.category==='ACTIVITY').map(x=>({id:x.id,title:x.title,subtitle:x.subtitle||'',publishTime:x.publishTime})).sort((a,b)=>b.publishTime-a.publishTime),source:'Aster 官方活动公告',total:r.data.total}})}

// ===== BEGIN DAILY BRIEF =====
// 每日异动（app/worker.js 里 dailyBrief() 的可读版，改了不生效）。
// 异动分（0-100）只用现有数据算，不编造 1h 数据：
//   涨幅分（50）= min(50, change24 * 0.125)
//   成交额分（20）= min(20, 4 * log10(quoteVolume / 10000))
//   资金费率分（15）= min(15, |fundingRate - 0.0001| * 1000)
//   领先分（15）= min(15, (change1 - change2) * 0.05)
// 开单思路（规则版，非投资建议）：方向只看 24h 涨幅与资金费率；
// 点位用现价与日内高低点算（日内高点取 fapi ticker/24hr 的 highPrice，
// 取不到就省略该项）：
//   资金费率 > 0.5% 或 24h 涨幅 ≥ 200% → 不追多：回踩位 = 日内高点 × 0.85；
//     止损 = 回踩位 × 0.93；目标 = 日内高点 × 1.10。
//   24h 涨幅 ≥ 50%（费率未过热，即 ≤0.5%）→ 轻仓试多：回踩位 = min(现价, 日内高点 × 0.90)；
//     止损 = 日内低点 × 0.98；目标 = 日内高点 × 1.15。
//   24h 涨幅 ≥ 20%（费率未过热，即 ≤0.5%）→ 观望：突破位 = 日内高点；
//     止损 = 日内低点 × 0.98；目标 = 日内高点 × 1.20。
//   其余 → 暂无思路（不给点位）。
// 持仓量是单点快照、无变化趋势，只展示不参与方向判断；与第二名差距只影响
// 异动分，不参与开单判断。点位按 4 位有效数字取整。
const BRIEF_DINO=['XLM','XTZ','LTC','ZEC'];
const BRIEF_EVENTS=[
{date:'2026-11-10',zh:{title:'JCT 月度解锁开启（时间表有争议）',note:'DropsTab 称从今日起每月约 11.8 亿枚，但也有追踪器称首笔可能在 12 月 10 日或仅约 1229 万枚，未核实'},en:{title:'JCT monthly unlocks begin (schedule disputed)',note:'DropsTab says ~1.18B/month from today, but other trackers say the first unlock may be Dec 10 or only ~12.29M — unverified'}},
];
function briefSig(v){
  if(v==null||!Number.isFinite(Number(v)))return null;
  const n=Number(v);
  if(n===0)return 0;
  const p=Math.pow(10,Math.floor(Math.log10(Math.abs(n)))-3);
  return Number((Math.round(n/p)*p).toPrecision(4));
}
function briefIdea(c){
  const chg=Number(c.change24),fund=c.fundingRate!=null?Number(c.fundingRate):null;
  const price=Number(c.price),high=c.highPrice!=null?Number(c.highPrice):null,low=c.lowPrice!=null?Number(c.lowPrice):null;
  const okHigh=Number.isFinite(high)&&high>0,okLow=Number.isFinite(low)&&low>0,okPrice=Number.isFinite(price)&&price>0;
  const pct1=v=>(v>=0?'+':'')+Number(v).toFixed(1)+'%';
  if(!Number.isFinite(chg))return {direction:'none',entry:null,stop:null,target:null,reason:{zh:'数据暂不完整，暂无开单思路。',en:'Data incomplete — no setup.'}};
  if((fund!=null&&fund>0.005)||chg>=200){
    const entry=okHigh?briefSig(high*0.85):null;
    return {direction:'noChase',entry,stop:entry!=null?briefSig(entry*0.93):null,target:okHigh?briefSig(high*1.10):null,
      reason:fund!=null&&fund>0.005
        ?{zh:'资金费率 '+(fund*100).toFixed(2)+'% 已过热，别追，等回踩。',en:'Funding '+(fund*100).toFixed(2)+'% is overheated — don’t chase; wait for a pullback.'}
        :{zh:'24h 涨 '+pct1(chg)+'，涨幅过大，追高风险高。',en:'Up '+pct1(chg)+' in 24h — too extended to chase.'}};
  }
  if(chg>=50){
    const entry=okHigh?briefSig(Math.min(okPrice?price:Infinity,high*0.90)):null;
    return {direction:'tryLong',entry,stop:okLow?briefSig(low*0.98):null,target:okHigh?briefSig(high*1.15):null,
      reason:fund!=null?{zh:'放量大涨、资金费率 '+(fund*100).toFixed(2)+'%，回踩分批试多。',en:'Strong surge on volume, funding '+(fund*100).toFixed(2)+'% — try a light long on pullback.'}:{zh:'放量大涨、费率正常，回踩分批试多。',en:'Strong surge on volume with normal funding — try a light long on pullback.'}};
  }
  if(chg>=20){
    return {direction:'watch',entry:okHigh?briefSig(high):null,stop:okLow?briefSig(low*0.98):null,target:okHigh?briefSig(high*1.20):null,
      reason:{zh:'涨幅居前但动能一般，等放量突破日内高点。',en:'Leading gains but average momentum — wait for a breakout above the intraday high.'}};
  }
  return {direction:'none',entry:null,stop:null,target:null,reason:{zh:'涨幅一般，暂无开单思路。',en:'Gains are average — no setup.'}};
}
function briefScore(t,second){
  const chg=Math.max(0,Number(t.change24)||0);
  const vol=Math.max(0,Number(t.volume)||0);
  const round1=v=>Math.round(v*10)/10;
  const parts={
    change:round1(Math.min(50,chg*0.125)),
    volume:round1(Math.max(0,Math.min(20,4*Math.log10(Math.max(1,vol)/10000)))),
    funding:t.fundingRate!=null?round1(Math.min(15,Math.abs(Number(t.fundingRate)-0.0001)*1000)):0,
    gap:second!=null?round1(Math.min(15,Math.max(0,chg-Number(second.change24||0))*0.05)):0,
  };
  return {score:Math.round(parts.change+parts.volume+parts.funding+parts.gap),parts};
}
function briefVerdict(t){
  if(!t||t.change24==null)return 'quiet';
  if(t.fundingRate!=null&&Number(t.fundingRate)>0.005)return 'overheated';
  if(Number(t.change24)>=100)return 'strong';
  if(Number(t.change24)>=20)return 'watch';
  return 'quiet';
}
async function dailyBrief(env){
  return cached(env,'daily-brief.json',300000,async()=>{
    const m=await markets(env);
    const rows=Array.isArray(m.rows)?m.rows:[];
    const gainers=rows.filter(r=>r.status==='TRADING'&&Number(r.volume)>=100000&&r.change24!=null)
      .sort((a,c)=>Number(c.change24)-Number(a.change24));
    const ranked=gainers.length?gainers:rows.filter(r=>r.change24!=null)
      .sort((a,c)=>Number(c.change24)-Number(a.change24));
    const top=ranked[0]||null,second=ranked[1]||null;
    const details=await Promise.all(ranked.slice(0,3).map(async r=>{
      const [md,fr]=await Promise.allSettled([
        marketDetail(env,r.symbol),
        remote(HOST+'premiumIndex?'+new URLSearchParams({symbol:r.symbol})),
      ]);
      const d=md.status==='fulfilled'?md.value:null;
      const f=fr.status==='fulfilled'&&fr.value&&Number.isFinite(Number(fr.value.lastFundingRate))
        ?Number(fr.value.lastFundingRate):null;
      return {symbol:r.symbol,name:r.name,price:r.price,change24:r.change24,volume:r.volume,
        highPrice:d?d.highPrice:null,lowPrice:d?d.lowPrice:null,openInterest:d?d.openInterest:null,fundingRate:f};
    }));
    const topOut=details[0]||null;
    const {score,parts}=topOut?briefScore(topOut,second):{score:0,parts:{change:0,volume:0,funding:0,gap:0}};
    const byName=new Map(rows.map(r=>[r.name,r]));
    const dino=BRIEF_DINO.map(n=>byName.get(n)).filter(Boolean)
      .map(r=>({name:r.name,symbol:r.symbol,price:r.price,change24:r.change24,volume:r.volume}));
    const todayBjs=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
    const events=BRIEF_EVENTS.filter(e=>e.date>=todayBjs);
    const ideas=details.map(d=>({symbol:d.symbol,name:d.name,price:d.price,change24:d.change24,volume:d.volume,
      fundingRate:d.fundingRate,openInterest:d.openInterest,highPrice:d.highPrice,lowPrice:d.lowPrice,idea:briefIdea(d)}));
    return {
      date:todayBjs,
      top:topOut,
      top5:ranked.slice(0,5).map(r=>({symbol:r.symbol,name:r.name,price:r.price,change24:r.change24,volume:r.volume})),
      secondGap:second&&top?Number(top.change24)-Number(second.change24):null,
      newest:rows[0]?{symbol:rows[0].symbol,name:rows[0].name,onboard:rows[0].onboard,change24:rows[0].change24}:null,
      score,scoreParts:parts,verdict:briefVerdict(topOut),
      dino,events,ideas,
      source:'fapi.asterdex.com (markets + ticker/24hr + premiumIndex + openInterest)',
    };
  });
}
// ===== END DAILY BRIEF =====
