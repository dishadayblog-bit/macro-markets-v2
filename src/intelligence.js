const fs = require('fs');
const path = require('path');

function env(name, fallback='') { return process.env[name] || fallback; }

function cleanText(v, max=1800){
  return String(v ?? '').replace(/\s+/g,' ').trim().slice(0,max);
}

function uniqBy(arr, keyFn){
  const seen=new Set(); const out=[];
  for(const x of arr||[]){ const k=keyFn(x); if(!seen.has(k)){seen.add(k);out.push(x);} }
  return out;
}

function collectSourceMaterial(payload){
  const sections=payload.sections||{};
  const stories=[];
  for(const [section,data] of Object.entries(sections)){
    for(const s of (data?.stories||[])){
      stories.push({section,title:cleanText(s.title,300),summary:cleanText(s.whatHappened||s.summary||s.description,900),why:cleanText(s.why,600),source:s.source||data.source||'',publishedAt:s.publishedAt||'',url:s.url||''});
    }
    for(const e of (data?.events||[])) stories.push({section,title:cleanText(e.event,300),summary:cleanText(e.whyItMatters,500),why:cleanText(e.whyItMatters,500),source:data.source||'',publishedAt:e.date||''});
  }
  return uniqBy(stories,x=>(x.title||'').toLowerCase()+'|'+x.section).slice(0,80);
}

function collectMetrics(payload){
  const metrics=[];
  for(const [section,data] of Object.entries(payload.sections||{})){
    for(const x of data?.indicators||[]) metrics.push({section,name:x.name,current:x.current,previous:x.previous,change:x.change});
    for(const x of data?.assets||[]) metrics.push({section,name:x.name,level:x.level,change:x.change});
    for(const x of data?.gdpForecasts||[]) metrics.push({section,name:x.economy,current:x.actual,previous:x.previousForecast,latest:x.latestForecast,revision:x.revision});
    for(const x of data?.sectors||[]) metrics.push({section,name:x.sector||x.name,current:x.change,reason:x.reason,outlook:x.outlook});
    for(const x of data?.companies||[]) metrics.push({section,name:x.name,revenueGrowth:x.revenueGrowth,margin:x.margin,roe:x.roe,valuation:x.valuation});
  }
  return metrics.slice(0,160);
}

function deterministicInterview(payload){
  const changes=(payload.changes||[]).filter(x=>x.type && x.type!=='WATCH').slice(0,8);
  return changes.map((c,i)=>({
    question:`What changed in ${c.section || 'the market'} today, and why does it matter?`,
    answer:`Start with the latest change: ${cleanText(c.title||c.summary,240)}. Then explain the economic or financial transmission mechanism, identify the most affected assets or sectors, and state what you would watch next. Treat the source data as the factual anchor and clearly separate your interpretation from confirmed facts.`,
    followUp:'What could invalidate that interpretation?',
    source:c.source||'Change-detection engine'
  }));
}

function deterministicDeepDive(payload){
  const c=(payload.changes||[]).find(x=>x.type==='NEW'||x.type==='REVISED'||x.type==='CHANGED');
  if(!c) return null;
  return {
    title:c.title||'Today’s most material development',
    priority:c.type==='NEW'||c.type==='REVISED'?'important':'watch',
    whatHappened:c.summary||c.title,
    why:'The change was identified by comparing the latest refresh with the previous stored snapshot.',
    keyData:'See the linked section for the source value, previous value and timestamp.',
    economicImpact:'Assess the effect on growth, inflation, liquidity, trade, fiscal conditions or financial conditions depending on the section.',
    marketImpact:'Assess the likely transmission to rates, equities, FX, commodities and credit.',
    sectorImpact:'Identify sectors with the clearest earnings, demand, cost or regulatory sensitivity.',
    companyImpact:'Identify companies only when the underlying source data supports a company-level conclusion.',
    indiaImpact:'Translate the global development into its effect on India through growth, inflation, capital flows, currency, rates or trade.',
    outlook:'Watch the next relevant data point, policy decision or company disclosure.',
    next:'Verify the primary source and compare the next refresh against this snapshot.',
    source:c.source||'Change-detection engine'
  };
}

async function callOpenAI(prompt){
  const key=env('OPENAI_API_KEY');
  const model=env('OPENAI_MODEL');
  if(!key || !model) return null; // AI layer is fully optional; falls back to deterministic mode below.
  const body={
    model,
    input: prompt,
    text: { format: { type: 'json_object' } }
  };
  const r=await fetch('https://api.openai.com/v1/responses',{
    method:'POST',
    headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/json'},
    body:JSON.stringify(body)
  });
  if(!r.ok) throw new Error(`OpenAI HTTP ${r.status}: ${await r.text()}`);
  const j=await r.json();
  const text=(j.output||[]).flatMap(o=>o.content||[]).map(c=>c.text||'').filter(Boolean).join('');
  if(!text) return null;
  return JSON.parse(text);
}

async function generateIntelligence(payload){
  const material=collectSourceMaterial(payload);
  const metrics=collectMetrics(payload);
  const changes=(payload.changes||[]).slice(0,20);
  const prompt=`You are a financial intelligence editor for a personal macroeconomics and markets dashboard.
Use ONLY the supplied source material and metrics. Never invent a fact, number, forecast, company result, policy decision or source.
Distinguish clearly between confirmed source facts and your interpretation. Do not give investment advice.

SOURCE MATERIAL:\n${JSON.stringify(material)}

METRICS:\n${JSON.stringify(metrics)}

CHANGE LOG:\n${JSON.stringify(changes)}

Return strict JSON with this shape:
{
  "dashboard": {"globalStories":[],"indiaStories":[],"markets":[],"changes":[]},
  "deepDive": {},
  "interviewQuestions": [],
  "sectorInsights": [],
  "companyInsights": []
}
Requirements:
- dashboard.globalStories: up to 5 high-impact developments with priority/title/why/section.
- dashboard.indiaStories: up to 5 India-focused developments with priority/title/why/section.
- dashboard.markets: summarize only supplied current assets.
- dashboard.changes: up to 15 meaningful changes using NEW/CHANGED/REVISED/IMPROVED/DETERIORATED and cite the section/source in the object.
- deepDive: one most material story with title, priority, whatHappened, why, keyData, economicImpact, marketImpact, sectorImpact, companyImpact, indiaImpact, outlook, next, source. Use “Not available from supplied data” rather than inventing.
- interviewQuestions: 5 questions with question/answer/followUp. Answers should be interview-ready but explicitly distinguish facts from interpretation.
- sectorInsights: only sectors supported by supplied data; include sector, direction, reason, outlook.
- companyInsights: only companies supported by supplied data; include name, revenueGrowth, margin, roe, valuation, keyCatalyst, keyRisk. Use “Not available from supplied data” when absent.
`;
  try {
    const ai=await callOpenAI(prompt);
    if(ai) return {...ai, generatedBy:'OpenAI', model:env('OPENAI_MODEL')};
  } catch(e) {
    return {error:e.message, generatedBy:'fallback'};
  }
  return {
    dashboard:{globalStories:[],indiaStories:[],markets:[],changes:changes.slice(0,15)},
    deepDive:deterministicDeepDive(payload),
    interviewQuestions:deterministicInterview(payload).slice(0,5),
    sectorInsights:(payload.sections?.['sector-performance']?.sectors||[]).slice(0,10),
    companyInsights:(payload.sections?.['top-companies']?.companies||[]).slice(0,10),
    generatedBy:'deterministic-fallback'
  };
}

module.exports={generateIntelligence};
